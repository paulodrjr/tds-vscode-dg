import * as vscode from "vscode";
import { beginBuildOperation, completeBuildOperation, isBuildOperationActive, languageClient } from "../extension";
import * as fs from "fs";
import Utils, { ServersConfig } from "../utils";

var windows1252 = require("windows-1252");
var windows1251 = require("windows-1251");

import { ResponseError } from "vscode-languageclient";
import { CompileResult } from "./CompileResult";
import { getCompilationOutcome, formatCompilationFailure } from "./compileOutcome";
import { sendCompilation } from "../protocolMessages";

interface CompileOptions {
  recompile: boolean;
  debugAphInfo: boolean;
  gradualSending: boolean;
  generatePpoFile: boolean;
  showPreCompiler: boolean;
  priorVelocity: boolean;
  returnPpo: boolean;
  commitWithErrorOrWarning: boolean;
}

//TODO: pegar as opções de compilação da configuração (talvez por server? ou workspace?)
function _getCompileOptionsDefault(): CompileOptions {
  let config = vscode.workspace.getConfiguration("totvsLanguageServer");
  let generatePpoFile = config.get("compilation.generatePpoFile");
  let showPreCompiler = config.get("compilation.showPreCompiler");
  let commitWithErrorOrWarning = config.get(
    "compilation.commitWithErrorOrWarning"
  );

  return {
    recompile: false,
    debugAphInfo: true,
    gradualSending: true,
    generatePpoFile: generatePpoFile as boolean,
    showPreCompiler: showPreCompiler as boolean,
    priorVelocity: true,
    returnPpo: false,
    commitWithErrorOrWarning: commitWithErrorOrWarning as boolean,
  };
}

/** Warn about unresponsive requests without releasing a potentially active remote build. */
async function watchCompilation<T>(request: Thenable<T>, operationId: number): Promise<T> {
  const config = vscode.workspace.getConfiguration("totvsLanguageServer");
  const requestedSeconds = config.get<number>("compilation.unresponsiveWarningSeconds", 600);
  const seconds = Math.max(30, Math.min(86400, Number(requestedSeconds) || 600));
  const timer = setTimeout(() => {
    if (isBuildOperationActive(operationId)) {
      const message = "Compilation has not returned after " + seconds +
        " seconds. Its state on the AppServer is unknown. Check the AppServer before " +
        "using TOTVS: Reset Local Compilation Lock.";
      languageClient.outputChannel.appendLine("[Warning] " + message);
      void vscode.window.showWarningMessage(message);
    }
  }, seconds * 1000);

  try {
    return await request;
  } finally {
    clearTimeout(timer);
  }
}

export async function generatePpo(filePath: string, options?: any): Promise<string> {
  if (!filePath) throw new Error("Undefined filePath.");
  if (!fs.existsSync(filePath)) throw new Error("File '" + filePath + "' not found.");
  if (!Utils.isAdvPlSource(filePath)) {
    throw new Error("This file has an invalid AdvPL source file extension.");
  }

  const server = ServersConfig.getCurrentServer();
  if (!server) throw new Error("No server connected.");
  const includes = ServersConfig.getIncludes(true, server) || [];
  if (!includes.length) throw new Error("Includes undefined.");

  const includesUris = includes.map(include => vscode.Uri.file(include).toString());
  const filesUris = [vscode.Uri.file(filePath).toString()];
  const optionsCompile = _getCompileOptionsDefault();
  optionsCompile.recompile = true;
  optionsCompile.generatePpoFile = false;
  optionsCompile.showPreCompiler = false;
  optionsCompile.returnPpo = true;

  const operationId = beginBuildOperation();
  if (operationId === undefined) throw new Error("Compilation already in progress.");
  try {
    const response = await watchCompilation(sendCompilation(
      server, includesUris, filesUris, optionsCompile, undefined, true
    ), operationId);
    const ppo = response.compileInfos?.find(item => item.status === "APPRE");
    if (!ppo) throw new Error("PPO not returned by the language server.");

    const encoding = String(options?.encoding || "cp1252").toLowerCase();
    if (encoding === "cp1252" || encoding === "windows-1252") {
      return windows1252.encode(ppo.detail);
    }
    if (encoding === "cp1251" || encoding === "windows-1251") {
      return windows1251.encode(ppo.detail);
    }
    return ppo.detail;
  } finally {
    completeBuildOperation(operationId);
  }
}

/**
 * Show a modal instead of relying on the Output panel, which developers may
 * not have visible when a compile finishes.
 */
function showCompilationFailure(message: string, detail: string): void {
  void vscode.window.showErrorMessage(
    message,
    { modal: true, detail },
    "Abrir saída TOTVS",
    "Ver problemas"
  ).then(choice => {
    if (choice === "Abrir saída TOTVS") {
      languageClient.outputChannel.show();
    } else if (choice === "Ver problemas") {
      void vscode.commands.executeCommand("workbench.action.problems.focus");
    }
  });
}

/**
 * Builds a file.
 */
export function buildFile(filename: string[], recompile: boolean): Promise<void> {
  const compileOptions = _getCompileOptionsDefault();
  compileOptions.recompile = recompile;
  return buildCode(filename, compileOptions);
}

/**
 * Build a file list.
 */
async function buildCode(filesPaths: string[], compileOptions: CompileOptions): Promise<void> {
  const config = vscode.workspace.getConfiguration("totvsLanguageServer");
  const output = languageClient.outputChannel;
  if (config.get("clearConsoleBeforeCompile") !== false) output.clear();
  if (config.get("showConsoleOnCompile") !== false) output.show();

  const dirtyFiles = vscode.workspace.textDocuments.some(doc => !doc.isUntitled && doc.isDirty);
  if (dirtyFiles) {
    const saved = await vscode.workspace.saveAll(false);
    if (!saved) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("Operation canceled because it is not possible to save edited files.")
      );
      return;
    }
  }

  const server = ServersConfig.getCurrentServer();
  if (!server) {
    vscode.window.showErrorMessage(vscode.l10n.t("No server connected"));
    return;
  }

  const filesUris = filesPaths.filter(file => {
    if (Utils.ignoreResource(file)) {
      languageClient.warn(vscode.l10n.t(
        "Resource appears in the list of files to ignore. Resource: {0}", file
      ));
      return false;
    }
    return true;
  }).map(file => vscode.Uri.file(file).toString());

  if (!filesUris.length) {
    vscode.window.showWarningMessage("There are no eligible files to compile.");
    return;
  }
  const hasAdvplSource = filesPaths.some(file => Utils.isAdvPlSource(file));
  const includePaths = ServersConfig.getIncludes(true, server) || [];
  const includesUris = includePaths.length
    ? includePaths.map(include => vscode.Uri.file(include).toString())
    : (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString());

  if (hasAdvplSource && !includesUris.length) {
    vscode.window.showErrorMessage("No valid include folders were configured.");
    return;
  }

  let extensionsAllowed: string[] | undefined;
  if (config.get("folder.enableExtensionsFilter", true)) {
    extensionsAllowed = config.get<string[]>("folder.extensionsAllowed", []);
  }

  const operationId = beginBuildOperation();
  if (operationId === undefined) return;

  try {
    const response = await watchCompilation(
      sendCompilation(server, includesUris, filesUris, compileOptions,
        extensionsAllowed, hasAdvplSource), operationId);

    if (!isBuildOperationActive(operationId)) {
      // The LSP connection was restarted: ignore the response from the former session.
      return;
    }
    if (response?.returnCode === 40840) ServersConfig.removeExpiredAuthorization();

    const outcome = getCompilationOutcome(response);
    if (outcome.failed) {
      const description = formatCompilationFailure(outcome, filesPaths);
      languageClient.outputChannel.appendLine("[ERROR] " + description.replace(/\n/g, " | "));
      showCompilationFailure("Falha na compilação", description);
      return;
    }

    if (outcome.warnings.length > 0) {
      void vscode.commands.executeCommand("workbench.action.problems.focus");
    }
    if (filesUris.length > 1 && (response.compileInfos?.length || 0) > 0) {
      verifyCompileResult(response);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    languageClient.error(message, err as any);
    showCompilationFailure("Falha na compilação", message);
  } finally {
    completeBuildOperation(operationId);
  }
}

/**
 * Strict compilation path for patch creation. The caller owns operationId and
 * retains the build lock until the patch request has also completed.
 */
export async function compileFilesForPatch(
  filesPaths: string[], expectedServer: any, operationId: number
): Promise<CompileResult> {
  if (!isBuildOperationActive(operationId)) {
    throw new Error("The compilation operation is no longer active.");
  }
  if (!filesPaths.length) throw new Error("No source files were selected.");

  const config = vscode.workspace.getConfiguration("totvsLanguageServer");
  const dirty = vscode.workspace.textDocuments.some(
    document => !document.isUntitled && document.isDirty);
  if (dirty && !await vscode.workspace.saveAll(false)) {
    throw new Error("Unsaved files: compilation was canceled.");
  }

  const server = ServersConfig.getCurrentServer();
  if (!server || server.id !== expectedServer.id ||
      server.environment !== expectedServer.environment ||
      server.token !== expectedServer.token) {
    throw new Error("The AppServer session changed before compilation.");
  }

  const isAdvpl = filesPaths.some(file => Utils.isAdvPlSource(file));
  const includePaths = ServersConfig.getIncludes(true, server) || [];
  const includeUris = includePaths.length
    ? includePaths.map(include => vscode.Uri.file(include).toString())
    : (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString());

  if (isAdvpl && !includeUris.length) {
    throw new Error("No valid include folders are configured for compilation.");
  }

  let extensionsAllowed: string[] | undefined;
  if (config.get("folder.enableExtensionsFilter", true)) {
    extensionsAllowed = config.get<string[]>("folder.extensionsAllowed", []);
  }

  const options = _getCompileOptionsDefault();
  options.recompile = true;

  let response: CompileResult;
  try {
    response = await watchCompilation(
      sendCompilation(server, includeUris,
        filesPaths.map(file => vscode.Uri.file(file).toString()),
        options, extensionsAllowed, isAdvpl), operationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Falha na compilação: " + message);
  }

  if (!isBuildOperationActive(operationId)) {
    throw new Error("A compilação foi invalidada após a reinicialização do Language Server.");
  }
  if (response?.returnCode === 40840) {
    ServersConfig.removeExpiredAuthorization();
  }

  const outcome = getCompilationOutcome(response);
  if (outcome.failed) {
    if (outcome.errors.length) {
      void vscode.commands.executeCommand("workbench.action.problems.focus");
    }
    throw new Error("Falha na compilação: " +
      formatCompilationFailure(outcome, filesPaths));
  }
  return response;
}

function verifyCompileResult(response) {
  const textNoAsk = vscode.l10n.t("Don't ask again");
  const textNo = vscode.l10n.t("No");
  const textYes = vscode.l10n.t("Yes");
  const textQuestion = vscode.l10n.t("Show table with compile results?");

  let questionAgain = true;

  const configADVPL = vscode.workspace.getConfiguration("totvsLanguageServer");
  const askCompileResult = configADVPL.get("askCompileResult");
  if (askCompileResult !== false) {
    vscode.window
      .showInformationMessage(textQuestion, { modal: true }, textYes, textNo, textNoAsk)
      .then((clicked) => {
        if (clicked === textYes) {
          vscode.commands.executeCommand(
            "totvs-developer-studio.show.result.build",
            response
          );
        } else if (clicked === textNoAsk) {
          questionAgain = false;
          configADVPL.update("askCompileResult", questionAgain);
        }
      });
  }
}

export async function commandBuildFile(
  context: vscode.ExtensionContext,
  recompile: boolean,
  files
): Promise<void> {
  let filePaths: string[] = [];

  if (files) {
    const sources = changeToArrayString(files);
    filePaths = await Utils.getAllFilesRecursiveAsync(sources, true);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      vscode.window.showInformationMessage(
        vscode.l10n.t("No editor is active, cannot find current file to build.")
      );
      return;
    }
    filePaths = [editor.document.uri.fsPath];
  }

  if (!filePaths.length) {
    vscode.window.showWarningMessage("There are no files to compile.");
    return;
  }

  const buildPromise = buildFile(filePaths, recompile);
  vscode.window.setStatusBarMessage(
    `$(gear~spin) ${vscode.l10n.t("Building...")}`, buildPromise
  );
  await buildPromise;
}

function changeToArrayString(allFiles) {
  let arrayFiles: string[] = [];

  allFiles.forEach((element) => {
    if (element.fsPath) {
      arrayFiles.push(element.fsPath);
    } else {
      if (fs.existsSync(element)) {
        arrayFiles.push(element);
      }
    }
  });

  return arrayFiles;
}

export async function commandBuildWorkspace(recompile: boolean): Promise<void> {
  const folders = vscode.workspace.workspaceFolders?.map(value => value.uri.fsPath) || [];
  if (!folders.length) {
    vscode.window.showWarningMessage("Open a workspace folder before compiling.");
    return;
  }
  const allFiles = await Utils.getAllFilesRecursiveAsync(folders, true);
  if (!allFiles.length) {
    vscode.window.showWarningMessage("No files found to compile in the workspace.");
    return;
  }
  const task = buildFile(allFiles, recompile);
  vscode.window.setStatusBarMessage(
    `$(gear~spin) ${vscode.l10n.t("Building...")}`, task
  );
  await task;
}

export async function commandBuildOpenEditors(recompile: boolean): Promise<void> {
  const files = new Set<string>();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText &&
          tab.input.uri.scheme === "file") {
        files.add(tab.input.uri.fsPath);
      }
    }
  }

  if (!files.size) {
    vscode.window.showWarningMessage("There are no open files to compile.");
    return;
  }

  const options = _getCompileOptionsDefault();
  options.recompile = recompile;
  const task = buildCode([...files], options);
  vscode.window.setStatusBarMessage(
    `$(gear~spin) ${vscode.l10n.t("Building...")}`, task
  );
  await task;
}
