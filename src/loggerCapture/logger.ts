import * as vscode from 'vscode';
import { ExtensionContext } from 'vscode';
import { LaunchConfig, ServersConfig } from '../utils';
import JSZip = require('jszip');
import * as path from 'path';
import * as fs from 'fs';
import * as tmp from 'tmp';

let logFile: string;
let logStatusBarItem: vscode.StatusBarItem;

export function onCaptureLoggers(context: ExtensionContext) {

	vscode.window.showInformationMessage(vscode.l10n.t("I authorize TOTVS to collect information from my development environment for technical support purposes"), { modal: true }, vscode.l10n.t("Yes"), vscode.l10n.t("No")).then(clicked => {
		if (clicked === vscode.l10n.t("Yes")) {
			if (!logFile) {
				vscode.window.showInformationMessage(vscode.l10n.t("Capture Logs started. Reproduce the problem and close the grabber."));
				const tmpFile = tmp.fileSync({ prefix: "vscode-tds-infos", postfix: ".log" });
				logFile = tmpFile.name;
				const newLine: String = "\n--------------------------------------------------\n";
				const tab = "\t";
				const fs = require('fs');

				let data = vscode.l10n.t("Starting Log on") + new Date().toString() + newLine;
				data += vscode.l10n.t("VSCode Version:") + " " + vscode.version + "\n";
				data += tab + "AppName : " + vscode.env.appName + "\n";
				data += tab + "AppRoot : " + vscode.env.appRoot + "\n";
				data += tab + "Language : " + vscode.env.language + "\n";
				data += tab + "MachineID : " + vscode.env.machineId + "\n";
				data += tab + "SessionID : " + vscode.env.sessionId + newLine;
				data += vscode.l10n.t("Path servers.json:") + " " + ServersConfig.getServerConfigPath() + newLine;
				data += vscode.l10n.t("Content servers.json:") + " " + ServersConfig.getServersConfigString() + newLine; // XXX
				data += vscode.l10n.t("Path launch.json:") + " " + LaunchConfig.getLaunchConfigFile() + newLine;
				try {
					data += vscode.l10n.t("Content launch.json:") + " " + LaunchConfig.getLaunchConfigString() + newLine;
				} catch (e) {
					data += vscode.l10n.t("Content launch.json:") + " It was not possible to read the launch.json file. Error:  " + e + newLine;
				}
				data += vscode.l10n.t("Root Path Workspace:") + " " + vscode.workspace.rootPath + "\n";
				const work: any = vscode.workspace.workspaceFolders;
				data += tab + vscode.l10n.t("Folders length:") + " " + work.length + newLine;
				data += vscode.l10n.t("All Extensions:") + " \n";

				//A gravação esta separada para diminuir o consumo de memoria.
				fs.appendFileSync(logFile, data, { flag: "a" }, (err) => {
					console.log(err);
				});

				//A gravação esta separada para diminuir o consumo de memoria.
				vscode.extensions.all.forEach(element => {
					if (!element.id.startsWith("vscode.") && !element.id.startsWith("ms-vscode.")) {
						let version = tab + "ID: " + element.id + "\n";
						version += tab + vscode.l10n.t("Active:") + " " + element.isActive + "\n";
						version += tab + "PackageJSON: " + JSON.stringify(element.packageJSON) + "\n\n";

						fs.appendFileSync(logFile, version, { flag: "a" }, (err) => {
							console.log(err);
						});
					}
				});

				let final = "--------------------------------------------------\n" + vscode.l10n.t("Ending log on ") + new Date().toString() + newLine;

				//A gravação esta separada para diminuir o consumo de memoria.
				fs.appendFileSync(logFile, final, { flag: "a" }, (err) => {
					console.log(err);
				});

				logStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
				logStatusBarItem.command = "totvs-developer-studio.logger.off";
				const str: string = vscode.l10n.t("Finish log capture.");
				logStatusBarItem.tooltip = str;
				context.subscriptions.push(logStatusBarItem);
				logStatusBarItem.text = vscode.l10n.t("Capturing logs ... Click here to close.");
				logStatusBarItem.show();
			} else {
				vscode.window.showErrorMessage(vscode.l10n.t("Collection has already been started. Reproduce the problem and close the grabber."));
			}
			return;
		}
	});

}

export async function offCaptureLoggers(): Promise<void> {
  if (!logFile) {
    vscode.window.showErrorMessage(vscode.l10n.t("First start logging"));
    return;
  }

  const currentLog = logFile;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder before exporting TDS support logs.");
    return;
  }

  const zipPath = path.join(
    workspaceFolder,
    fs.existsSync(path.join(workspaceFolder, "tdsSupport.zip"))
      ? "tdsSupport" + Date.now() + ".zip"
      : "tdsSupport.zip"
  );

  try {
    const archive = new JSZip();
    archive.file(path.basename(currentLog), await fs.promises.readFile(currentLog));
    const zipContent = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await fs.promises.writeFile(zipPath, zipContent);
    logStatusBarItem?.hide();
    logFile = "";
    vscode.window.showInformationMessage(
      vscode.l10n.t("Log file successfully generated in") + zipPath
    );
  } catch (error) {
    // Preserve the capture for a second attempt if the output cannot be created.
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage("Unable to generate TDS support ZIP: " + message);
  }
}
