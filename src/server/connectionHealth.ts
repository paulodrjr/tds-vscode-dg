import * as vscode from "vscode";
import { languageClient } from "../extension";
import Utils, { ServersConfig } from "../utils";
import { ServerItem } from "../serverItem";
import {
  sendGetServerInformationsInfo,
  sendGetServerPermissionsInfo
} from "../protocolMessages";

export const CONNECTION_PROBE_TIMEOUT_MS = 12000;

/**
 * Verify the authenticated AppServer session, not merely TCP reachability.
 * The request only reads server information/permissions; it does not change
 * the RPO, connect a new user or perform a compiler operation.
 */
export async function probeAppServerSession(
  server: ServerItem,
  timeoutMs = CONNECTION_PROBE_TIMEOUT_MS
): Promise<void> {
  if (!languageClient?.isReady) {
    throw new Error("TOTVS Language Server is not ready.");
  }

  const cancellation = new vscode.CancellationTokenSource();
  let timer: NodeJS.Timeout | undefined;
  try {
    const request = Utils.isServerP20OrGreater(server)
      ? sendGetServerInformationsInfo(server, cancellation.token)
      : sendGetServerPermissionsInfo(server, cancellation.token);

    const result = await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          cancellation.cancel();
          reject(new Error("AppServer did not answer the session check within " +
            Math.ceil(timeoutMs / 1000) + " seconds."));
        }, timeoutMs);
      }),
    ]);

    if (!result || result.message !== "OK") {
      throw new Error(result?.message || "AppServer returned an invalid session response.");
    }
  } finally {
    if (timer) clearTimeout(timer);
    cancellation.dispose();
  }
}

/** Manual, user-requested check; automatic monitoring is implemented separately. */
export async function checkRemoteConnection(): Promise<void> {
  const server = ServersConfig.getCurrentServer();
  if (!server) {
    vscode.window.showWarningMessage("No AppServer environment is selected.");
    return;
  }

  if (!languageClient?.isReady) {
    ServersConfig.markConnectionLost(server.token);
    vscode.window.showWarningMessage(
      "The local TOTVS Language Server is not running; the selected AppServer session has been marked disconnected."
    );
    return;
  }

  try {
    await probeAppServerSession(server);
    vscode.window.showInformationMessage(
      "AppServer connection verified: " + server.name + " / " + server.environment
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const action = "Mark disconnected";
    const answer = await vscode.window.showWarningMessage(
      "Unable to validate the AppServer session for " +
      server.name + " / " + server.environment + ". " + detail +
      " The UI may be stale. Mark this session disconnected?",
      action
    );
    if (answer === action) {
      ServersConfig.markConnectionLost(server.token);
    }
  }
}
