import * as vscode from "vscode";
import { languageClient } from "../extension";
import Utils, { ServersConfig } from "../utils";
import {
  sendGetServerInformationsInfo,
  sendGetServerPermissionsInfo
} from "../protocolMessages";

/** Performs a read-only remote session check when explicitly requested. */
export async function checkRemoteConnection(): Promise<void> {
  const server = ServersConfig.getCurrentServer();
  if (!server) {
    vscode.window.showWarningMessage("No AppServer environment is selected.");
    return;
  }

  const message = "Unable to validate the AppServer session for " +
    server.name + " / " + server.environment + ". ";
  if (!languageClient?.isReady) {
    ServersConfig.markConnectionLost(server.token);
    vscode.window.showWarningMessage(
      "The local TOTVS Language Server is not running; the selected AppServer session has been marked disconnected."
    );
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      Utils.isServerP20OrGreater(server)
        ? sendGetServerInformationsInfo(server)
        : sendGetServerPermissionsInfo(server),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Remote request timed out after 12 seconds.")), 12000);
      })
    ]);
    if (response?.message !== "OK") {
      throw new Error(response?.message || "Remote server returned an unexpected response.");
    }
    vscode.window.showInformationMessage(
      "AppServer connection verified: " + server.name + " / " + server.environment
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const action = "Mark disconnected";
    const answer = await vscode.window.showWarningMessage(
      message + detail + " The UI may be stale. Mark this session disconnected?",
      action
    );
    if (answer === action) {
      ServersConfig.markConnectionLost(server.token);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
