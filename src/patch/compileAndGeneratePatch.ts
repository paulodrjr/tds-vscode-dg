import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import Utils, { ServersConfig } from "../utils";
import { beginBuildOperation, completeBuildOperation, isBuildOperationActive, languageClient } from "../extension";
import { compileFilesForPatch } from "../compile/tdsBuild";
import { sendPatchGenerateMessageStrict } from "./patchUtil";

const EXCLUDED_EXTENSIONS = new Set([".ch", ".th"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".vscode", "out", "out-test"]);

interface PatchSelection {
  files: string[];
  skipped: number;
}

async function gatherSelectedSources(uris: vscode.Uri[]): Promise<PatchSelection> {
  const configured = vscode.workspace.getConfiguration("totvsLanguageServer")
    .get<string[]>("folder.extensionsAllowed", []);
  const allowed = new Set(configured.map(ext =>
    (ext.startsWith(".") ? ext : "." + ext).toLowerCase()));

  const pending = uris.map(uri => uri.fsPath);
  const fileSet = new Map<string, string>();
  let skipped = 0;
  let examined = 0;

  while (pending.length) {
    const current = pending.pop();
    const name = path.basename(current);
    if (Utils.ignoreResource(name)) {
      skipped++;
      continue;
    }

    let info: fs.Stats;
    try {
      info = await fs.promises.lstat(current);
    } catch (error) {
      throw new Error("Unable to access " + current + ": " +
        (error instanceof Error ? error.message : String(error)));
    }

    // Do not follow symlinks: they may point outside the selected workspace
    // or create cycles when users select entire directory trees.
    if (info.isSymbolicLink()) {
      skipped++;
      continue;
    }

    if (info.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(name.toLowerCase()) ||
          fs.existsSync(path.join(current, ".tdspatchignore")) ||
          fs.existsSync(path.join(current, ".tdscompileignore"))) {
        skipped++;
        continue;
      }
      const children = await fs.promises.readdir(current);
      for (const child of children) pending.push(path.join(current, child));
    } else if (info.isFile()) {
      const extension = path.extname(current).toLowerCase();
      // .ch and .th are compile-time includes, not RPO objects.
      if (allowed.has(extension) && !EXCLUDED_EXTENSIONS.has(extension)) {
        fileSet.set(path.resolve(current).toLowerCase(), current);
      } else {
        skipped++;
      }
    }

    if (++examined % 150 === 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  const files = [...fileSet.values()].sort((a, b) => a.localeCompare(b));

  // TOTVS patches refer to resources by RPO name (basename), not local folder.
  // Two sources with the same basename cannot be unambiguously included.
  const names = new Map<string, string>();
  for (const file of files) {
    const key = path.basename(file).toLowerCase();
    const previous = names.get(key);
    if (previous && previous !== file) {
      throw new Error("Duplicate resource name in selected folders: " +
        path.basename(file) + ". " + previous + " and " + file);
    }
    names.set(key, file);
  }

  return { files, skipped };
}

function getExplorerSelection(
  clicked?: vscode.Uri, selected?: readonly vscode.Uri[]
): vscode.Uri[] {
  if (!clicked || clicked.scheme !== "file") return [];
  const matchingSelection = (selected || []).some(uri =>
    uri.scheme === "file" &&
    path.normalize(uri.fsPath).toLowerCase() ===
      path.normalize(clicked.fsPath).toLowerCase());

  const inputs = matchingSelection ? [...selected] : [clicked];
  const unique = new Map<string, vscode.Uri>();
  for (const uri of inputs) {
    if (uri.scheme !== "file") continue;
    unique.set(path.normalize(uri.fsPath).toLowerCase(), uri);
  }
  return [...unique.values()];
}

function activeSessionMatches(server: any): boolean {
  const active = ServersConfig.getCurrentServer();
  return !!active &&
    active.id === server.id &&
    active.environment === server.environment &&
    active.token === server.token;
}

/**
 * Explorer command: compile selected files/folders first, then generate a patch
 * containing those exact RPO resource names. Never package stale sources after
 * a compilation error or a connection change.
 */
export async function compileAndGeneratePatch(
  clicked?: vscode.Uri, selected?: readonly vscode.Uri[]
): Promise<void> {
  const resources = getExplorerSelection(clicked, selected);
  if (!resources.length) {
    vscode.window.showWarningMessage(
      "Selecione um ou mais arquivos ou pastas locais no Explorer do VS Code."
    );
    return;
  }

  const server = ServersConfig.getCurrentServer();
  if (!server?.id || !server?.token || !server?.environment) {
    vscode.window.showErrorMessage(
      "Conecte-se ao servidor e ao ambiente Protheus antes de compilar e gerar o patch."
    );
    return;
  }

  let operationId: number | undefined;
  try {
    const selection = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Identificando fontes e recursos para o patch",
      },
      () => gatherSelectedSources(resources)
    );

    if (!selection.files.length) {
      vscode.window.showWarningMessage(
        "A seleção não contém arquivos elegíveis para compilação. " +
        "Verifique as extensões permitidas nas configurações TOTVS."
      );
      return;
    }

    const initialFolder: string | undefined = server.patchGenerateDir;
    const folderSelection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Selecionar destino do patch",
      defaultUri: initialFolder && fs.existsSync(initialFolder)
        ? vscode.Uri.file(initialFolder)
        : vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!folderSelection?.length) return;

    const requestedName = await vscode.window.showInputBox({
      title: "Compilar e gerar patch",
      prompt: "Nome do patch (sem extensão). Deixe vazio para usar o padrão do RPO.",
      value: "",
      validateInput: value =>
        /[\\/:*?"<>|]/.test(value) ? "Informe somente o nome, sem caracteres de caminho." : undefined,
    });
    if (requestedName === undefined) return;
    const patchName = requestedName.trim().replace(/\.ptm$/i, "");

    const message =
      "Servidor: " + server.name + " / " + server.environment + "\n" +
      "Compilar: " + selection.files.length + " arquivo(s)\n" +
      "Ignorados: " + selection.skipped + "\n" +
      "Destino: " + folderSelection[0].fsPath + "\n\n" +
      "A compilação será executada no RPO selecionado. Continuar?";
    const confirmation = await vscode.window.showWarningMessage(
      message, { modal: true }, "Compilar e gerar patch"
    );
    if (confirmation !== "Compilar e gerar patch") return;

    if (!activeSessionMatches(server)) {
      throw new Error("A sessão do AppServer mudou antes da compilação.");
    }

    operationId = beginBuildOperation();
    if (operationId === undefined) return;

    const compilation = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Compilando " + selection.files.length + " arquivo(s)",
        cancellable: false,
      },
      () => compileFilesForPatch(selection.files, server, operationId)
    );

    if (!isBuildOperationActive(operationId) || !activeSessionMatches(server)) {
      throw new Error("A conexão ou a operação de compilação mudou. O patch não será gerado.");
    }

    const warnings = (compilation.compileInfos || []).filter(
      item => item.status === "WARN");
    if (warnings.length > 0) {
      const continueOption = "Gerar patch mesmo assim";
      const choice = await vscode.window.showWarningMessage(
        "A compilação terminou com " + warnings.length +
        " aviso(s). Verifique os resultados antes de incluir esses fontes no patch.",
        { modal: true }, continueOption
      );
      if (choice !== continueOption) return;
    }

    if (!isBuildOperationActive(operationId) || !activeSessionMatches(server)) {
      throw new Error("A sessão de compilação foi alterada antes da geração do patch.");
    }

    const names = selection.files.map(file => path.basename(file));
    const patchResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Gerando patch com " + names.length + " arquivo(s)",
        cancellable: false,
      },
      () => sendPatchGenerateMessageStrict(
        server, folderSelection[0].toString(), patchName, names)
    );

    ServersConfig.updatePatchGenerateDir(server.id, folderSelection[0].fsPath);
    vscode.window.showInformationMessage(
      "Patch gerado a partir de " + names.length + " arquivo(s) em " +
      folderSelection[0].fsPath +
      (patchResult.files ? ". " + patchResult.files : ".")
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    languageClient.outputChannel.appendLine(
      "[Compile and generate patch] " + message
    );
    vscode.window.showErrorMessage("Compilar e gerar patch: " + message);
  } finally {
    if (operationId !== undefined) completeBuildOperation(operationId);
  }
}
