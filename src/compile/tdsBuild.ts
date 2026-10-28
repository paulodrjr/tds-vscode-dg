import * as vscode from "vscode";
import { beginBuildOperation, completeBuildOperation, isBuildOperationActive, languageClient } from "../extension";
import * as fs from "fs";
import Utils, { ServersConfig } from "../utils";

var windows1252 = require("windows-1252");
var windows1251 = require("windows-1251");

import { ResponseError } from "vscode-languageclient";
import { CompileResult } from "./CompileResult";
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
    if (response.returnCode === 40840) ServersConfig.removeExpiredAuthorization();
    const errors = response.compileInfos?.some(info =>
      info.status === "FATAL" || info.status === "ERROR" || info.status === "WARN");
    if (errors) {
      void vscode.commands.executeCommand("workbench.action.problems.focus");
    }
    if (filesUris.length > 1 && (response.compileInfos?.length || 0) > 0) {
      verifyCompileResult(response);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    languageClient.error(message, err as any);
    vscode.window.showErrorMessage("Compilation failed: " + message);
  } finally {
    completeBuildOperation(operationId);
  }
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

export function commandBuildFile(
  context: vscode.ExtensionContext,
  recompile: boolean,
  files
) {
  let editor: vscode.TextEditor | undefined;
  let filename: string | undefined = undefined;

  if (context === undefined) {
    //A ação veio pelo ctrl+f9
    editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("No editor is active, cannot find current file to build.")
      );
      return;
    }
    filename = editor.document.uri.fsPath;
  }

  let buildPromise: Promise<void> | undefined;
  if (files) {
    const paths = changeToArrayString(files);
    buildPromise = buildFile(Utils.getAllFilesRecursive(paths, true), recompile);
  } else if (filename !== undefined) {
    buildPromise = buildFile([filename], recompile);
  }
  if (buildPromise) {
    vscode.window.setStatusBarMessage(
      `$(gear~spin) ${vscode.l10n.t("Building...")}`, buildPromise
    );
  }

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

export function commandBuildWorkspace(recompile: boolean) {
  if (vscode.workspace.workspaceFolders) {
    let folders: string[] = [];

    vscode.workspace.workspaceFolders.forEach((value) => {
      folders.push(value.uri.fsPath);
    });

    let allFiles = Utils.getAllFilesRecursive(folders, true);

    buildFile(allFiles, recompile);
  }
}

export async function commandBuildOpenEditors(recompile: boolean) {
  let delayNext = 250;
  let files: string[] = [];
  let filename: string | undefined = undefined;
  let editor = vscode.window.activeTextEditor;
  let nextEditor = editor;
  if (!editor) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("No editor is active, cannot find current file to build.")
    );
    return;
  }
  if (editor.viewColumn) {
    filename = editor.document.uri.fsPath;
    if (files.indexOf(filename) === -1) {
      files.push(filename);
    }
  } else {
    vscode.commands.executeCommand("workbench.action.nextEditor");
    await delay(delayNext);
    editor = vscode.window.activeTextEditor;
    if (editor) {
      if (editor.viewColumn) {
        filename = editor.document.uri.fsPath;
        if (files.indexOf(filename) === -1) {
          files.push(filename);
        }
      } else {
        vscode.window.showWarningMessage(
          "[SKIPPING] Editor file is not fully open"
        );
      }
    }
  }

  //TODO: melhorar essa rotina usando vscode.workspace.textDocuments
  do {
    vscode.commands.executeCommand("workbench.action.nextEditor");
    await delay(delayNext);
    nextEditor = vscode.window.activeTextEditor;
    if (!nextEditor) {
      // arquivo que não pode ser aberto pelo editor (binarios ou requerem confirmacao do usuario)
      continue;
    }
    if (
      nextEditor &&
      !sameEditor(editor as vscode.TextEditor, nextEditor as vscode.TextEditor)
    ) {
      if (nextEditor.viewColumn) {
        filename = nextEditor.document.uri.fsPath;
        if (files.indexOf(filename) === -1) {
          files.push(filename);
        }
      } else {
        vscode.window.showWarningMessage(
          "[SKIPPING] Editor file is not fully open"
        );
      }
    } else {
      // retornou ao primeiro editor
      break;
    }
  } while (true);
  // check if there are files to compile
  if (files.length > 0) {
    const compileOptions = _getCompileOptionsDefault();
    compileOptions.recompile = recompile;
    buildCode(files, compileOptions);
  } else {
    vscode.window.showWarningMessage("There is nothing to compile");
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameEditor(editor: vscode.TextEditor, nextEditor: vscode.TextEditor) {
  if (editor === undefined && nextEditor === undefined) {
    return true;
  }

  if (editor === undefined || nextEditor === undefined) {
    return false;
  }

  return editor.document === nextEditor.document;
}
