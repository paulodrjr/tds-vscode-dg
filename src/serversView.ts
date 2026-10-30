import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import Utils, { ServersConfig } from "./utils";
import { inputConnectionParameters } from "./inputConnectionParameters";
import { inputAuthenticationParameters } from "./inputAuthenticationParameters";
import { ResponseError } from "vscode-languageclient";
import serverProvider from "./serverItemProvider";
import {
  ConnTypeIds,
  sendValidationRequest,
  IValidationInfo,
  sendDisconnectRequest,
  ITokenInfo,
  sendConnectRequest,
  sendAuthenticateRequest,
  IAuthenticationInfo,
  IReconnectInfo,
  ENABLE_CODE_PAGE,
} from "./protocolMessages";
import { EnvSection, ServerItem } from "./serverItem";
import { ConnectionWatchdog } from "./server/connectionWatchdog";
import { connectionPresentation } from "./server/connectionPresentation";
import {
  RecoveryFailure,
  recoveryDiagnostic,
  recoveryMessage,
  requestSessionRecovery
} from "./server/sessionRecovery";
import { processSelectResourceMessage } from "./utilities/processSelectResource";

const compile = require("template-literal");

const localizeHTML = {
  "tds.webview.newServer.title": vscode.l10n.t("New Server"),
  "tds.webview.newServer.name": vscode.l10n.t("Server Name"),
  "tds.webview.newServer.address": vscode.l10n.t("Address"),
  "tds.webview.newServer.port": vscode.l10n.t("Port"),
  "tds.webview.newServer.save": vscode.l10n.t("Save"),
  "tds.webview.newServer.saveClose": vscode.l10n.t("Save/Close"),
  "tds.webview.newServer.secure": vscode.l10n.t("Secure(SSL)"),
  "tds.webview.dir.include": vscode.l10n.t("Includes directory"),
  "tds.webview.dir.include2": vscode.l10n.t("Allow multiple directories"),
};

export class ServersExplorer {
  constructor(context: vscode.ExtensionContext) {
    let currentPanel: vscode.WebviewPanel | undefined = undefined;

    vscode.commands.registerCommand("totvs-developer-studio.add", () => {
      if (vscode.workspace.workspaceFolders === undefined) {
        vscode.window.showErrorMessage("No folder opened.");
        return;
      }

      if (currentPanel) {
        currentPanel.reveal();
      } else {
        currentPanel = vscode.window.createWebviewPanel(
          "totvs-developer-studio.add",
          vscode.l10n.t("New Server"),
          vscode.ViewColumn.One,
          {
            enableScripts: true,
            localResourceRoots: [
              vscode.Uri.file(
                path.join(context.extensionPath, "src", "server")
              ),
            ],
            retainContextWhenHidden: true,
          }
        );

        currentPanel.webview.html = getWebViewContent(context, localizeHTML);
        currentPanel.onDidDispose(
          () => {
            currentPanel = undefined;
          },
          null,
          context.subscriptions
        );

        currentPanel.webview.onDidReceiveMessage(
          (message) => {
            if (!processSelectResourceMessage(currentPanel.webview, message)) {
              switch (message.command) {
                case "checkDir":
                  let checkedDir = Utils.checkDir(message.selectedDir);
                  currentPanel.webview.postMessage({
                    command: "checkedDir",
                    checkedDir: checkedDir,
                  });
                  break;
                case "saveServer":
                  if (message.serverName && message.port && message.address) {
                    const serverId = createServer(
                      message.serverType,
                      message.serverName,
                      message.port,
                      message.address,
                      0,
                      "",
                      true,
                      message.includes
                    );
                    if (serverId !== undefined) {
                      sendValidationRequest(message.address, message.port, message.serverType).then(
                        (validInfoNode: IValidationInfo) => {
                          ServersConfig.updateBuildVersion(
                            serverId,
                            validInfoNode.build,
                            validInfoNode.secure
                          );

                          currentPanel?.dispose();
                          return;
                        },
                        (err: ResponseError<object>) => {
                          vscode.window.showErrorMessage(err.message);
                        }
                      );
                    }
                  } else {
                    vscode.window.showErrorMessage(
                      vscode.l10n.t("Add Server Fail. Name, port and Address are need")
                    );
                  }

                  if (currentPanel) {
                    if (message.close) {
                      currentPanel.dispose();
                    }
                  }
              }
            }
          },
          undefined,
          context.subscriptions
        );
      }
    });

    vscode.commands.registerCommand("totvs-developer-studio.config", () => {
      if (vscode.workspace.workspaceFolders === undefined) {
        vscode.window.showErrorMessage("No folder opened.");
        return;
      }
      const servers = ServersConfig.getServerConfigFile();
      if (servers) {
        vscode.window.showTextDocument(vscode.Uri.file(servers));
      }
    });

    // check if there is an open folder
    if (vscode.workspace.workspaceFolders === undefined) {
      vscode.window.showErrorMessage("No folder opened.");
      return;
    }

    const options: vscode.TreeViewOptions<ServerItem | EnvSection> = {
      treeDataProvider: serverProvider,
    };
    context.subscriptions.push(vscode.window.createTreeView("totvs_server", options));
    // Opt-in watchdog. Disabled by default until validated against a real LS.
    context.subscriptions.push(new ConnectionWatchdog());

    vscode.commands.registerCommand(
      "totvs-developer-studio.connect",
      (serverItem: ServerItem) => {
        let ix = serverProvider.localServerItems.indexOf(serverItem);
        if (ix >= 0) {
          //Verifica se ha um buildVersion cadastrado.
          if (serverItem.buildVersion) {
            inputConnectionParameters(
              context,
              serverItem,
              ConnTypeIds.CONNT_DEBUGGER,
              false
            );
          } else {
            //Há build no servidor
            vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Window,
                title: vscode.l10n.t("Validating server {0}", serverItem.name),
              },
              async (progress, token) => {
                progress.report({ increment: 0 });
                await doValidation(context, serverItem);
                progress.report({ increment: 100 });
              }
            );
          }
        }
      }
    );

    vscode.commands.registerCommand(
      "totvs-developer-studio.reconnect",
      (serverItem: ServerItem) => {
        let ix = serverProvider.localServerItems.indexOf(serverItem);
        if (ix >= 0) {
          //Verifica se ha um buildVersion cadastrado.
          if (serverItem.buildVersion) {
            inputConnectionParameters(
              context,
              serverItem,
              ConnTypeIds.CONNT_DEBUGGER,
              true
            );
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t("Could not reconnect to server {0}", serverItem.name)
            );
          }
        }
      }
    );

    vscode.commands.registerCommand(
      "totvs-developer-studio.disconnect",
      (serverItem: ServerItem) => {
        invalidateConnectionAttempts();
        connectionPresentation.clear(serverItem.id);
        if (serverItem.isConnected) {
          return queueConnection(() => vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: vscode.l10n.t("Disconnecting from the server [{0}]", serverItem.name),
            },
            async (progress) => {
              progress.report({ increment: 0 });
              await doDisconnect(serverItem);
              progress.report({ increment: 100 });
            }
          ));
        } else {
          serverProvider.connectedServerItem = undefined;
          return Promise.resolve();
        }
      }
    );

    vscode.commands.registerCommand(
      "totvs-developer-studio.selectenv",
      (environment: EnvSection) => {
        inputConnectionParameters(
          context,
          environment,
          ConnTypeIds.CONNT_DEBUGGER,
          true
        );
      }
    );

    vscode.commands.registerCommand(
      "totvs-developer-studio.delete",
      (serverItem: ServerItem) => {
        let ix = serverProvider.localServerItems.indexOf(serverItem);
        if (ix >= 0) {
          ServersConfig.deleteServer(serverItem.id);
        }
      }
    );

    vscode.commands.registerCommand(
      "totvs-developer-studio.delete.environment",
      (environmentItem: EnvSection) => {
        ServersConfig.deleteEnvironmentServer(environmentItem);
      }
    );

    vscode.commands.registerCommand(
      "totvs-developer-studio.rename",
      (serverItem: ServerItem) => {
        let ix = serverProvider.localServerItems.indexOf(serverItem);
        if (ix >= 0) {
          vscode.window
            .showInputBox({
              placeHolder: vscode.l10n.t("Rename the server"),
              value:
                typeof serverItem.label === "string"
                  ? serverItem.label
                  : (serverItem.label as vscode.TreeItemLabel).label,
            })
            .then((newName: string) => {
              ServersConfig.updateServerName(serverItem.id, newName);
            });
        }
      }
    );

    function createServer(
      typeServer: string,
      serverName: string,
      port: number,
      address: string,
      secure: number,
      buildVersion: string,
      showSucess: boolean,
      includes: string[]
    ): string | undefined {
      const serverId = ServersConfig.createNewServer(
        typeServer,
        serverName,
        port,
        address,
        buildVersion,
        secure,
        includes
      );

      if (serverId !== undefined && showSucess) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("Server saved. Name: {0}", serverName)
        );
      }

      return serverId;
    }

    function getWebViewContent(context, localizeHTML) {
      const htmlOnDiskPath = vscode.Uri.file(
        path.join(context.extensionPath, "src", "server", "addServer.html")
      );
      const cssOnDIskPath = vscode.Uri.file(
        path.join(context.extensionPath, "resources", "css", "form.css")
      );

      const chooseResourcePath = vscode.Uri.file(
        path.join(
          context.extensionPath,
          "resources",
          "script",
          "chooseResource.js"
        )
      );

      const htmlContent = fs.readFileSync(
        htmlOnDiskPath.with({ scheme: "vscode-resource" }).fsPath
      );
      const cssContent = fs.readFileSync(
        cssOnDIskPath.with({ scheme: "vscode-resource" }).fsPath
      );

      const chooseResourceContent = fs.readFileSync(
        chooseResourcePath.with({ scheme: "vscode-resource" }).fsPath
      );

      let runTemplate = compile(htmlContent);

      return runTemplate({
        css: cssContent,
        localize: localizeHTML,
        chooseResourceScript: chooseResourceContent
      });
    }
  }
}

function doFinishConnectProcess(
  serverItem: ServerItem,
  token: string,
  environment: string
) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Language Server returned no authenticated connection token.");
  }
  // The tree/monitor may hold this same object. Update it before notifying them.
  serverItem.token = token;
  serverItem.environment = environment;
  ServersConfig.saveConnectionToken(serverItem.id, token, environment);
  ServersConfig.saveSelectServer(
    serverItem.id,
    token,
    environment,
    serverItem.username
  );
  // Only the server-confirmed, authenticated token returns the icon to green.
  connectionPresentation.clear();

  runCommandUpdateMonitor();
  //let isSafeRPO = serverItem.isSafeRPO; // this is not working returning => undefined
  let isSafeRPO = serverItem.buildVersion.localeCompare("7.00.191205P") > 0;
  // custom context tds-vscode.isSafeRPO
  vscode.commands.executeCommand(
    "setContext",
    "tds-vscode.isSafeRPO",
    isSafeRPO
  );
}

/*
 * O comando é registrado na tela do monitor, portanto, caso ela nao sido aberta, o comando nao existira, entao faz a busca antes de mais nada.
 * Segundo a documentacao, comandos que começam com "_" sao tratados com internos.
 * doc: https://vshaxe.github.io/vscode-extern/VscodeCommands.html
 */
function executeCommand(commandId: string) {
  return vscode.commands.getCommands(false).then((commands: string[]) => {
    let index = commands.indexOf(commandId);
    if (index > -1) {
      vscode.commands.executeCommand(commandId);
    }
  });
}

function runCommandUpdateMonitor() {
  executeCommand("_totvs-developer-studio.updateMonitorPanel");
}

// Keep connection changes ordered so a delayed disconnect cannot clear a new session.
let connectionQueue: Promise<void> = Promise.resolve();
let queuedConnectionOperations = 0;
let connectionGeneration = 0;
let pendingAuthentication: { generation: number; serverId: string; environment: string; token: string } | undefined;

/** Invalidate all outstanding authentication prompts and connection requests. */
export function invalidateConnectionAttempts(): void {
  connectionGeneration++;
  pendingAuthentication = undefined;
  // A canceled recovery must never leave a permanent rotating indicator.
  const state = connectionPresentation.active();
  if (state && state.phase !== "disconnected") {
    connectionPresentation.setDisconnected(state.id, state.environment);
  }
}

export async function cancelAuthentication(serverItem: ServerItem, generation: number): Promise<void> {
  if (generation !== connectionGeneration || pendingAuthentication?.generation !== generation) {
    return;
  }
  pendingAuthentication = undefined;
  try {
    await sendDisconnectRequest(serverItem);
  } catch (error) {
    console.warn("Could not disconnect the canceled authentication session", error);
  }
}

function queueConnection<T>(operation: () => Thenable<T>): Promise<T> {
  queuedConnectionOperations++;
  const next = connectionQueue.then(operation, operation);
  // Keep the queue usable, and preserve the original rejection for the caller.
  connectionQueue = next.then(() => undefined, (error: any) => {
    console.error("Server connection operation failed:", error instanceof Error ? error.name : "unknown");
  });
  // ES2016-compatible release (Promise.finally is not available in this target).
  return next.then(value => {
    queuedConnectionOperations--;
    return value;
  }, error => {
    queuedConnectionOperations--;
    throw error;
  });
}

export function isConnectionOperationInProgress(): boolean {
  return queuedConnectionOperations > 0 || pendingAuthentication !== undefined;
}

export interface ExpectedConnection {
  id: string;
  environment: string;
  token: string;
}

export type SilentReconnectResult = "restored" | "stale" | "rejected" | "failed";

function matchesSession(expected: ExpectedConnection): boolean {
  const active = ServersConfig.getCurrentServer();
  return !!active && active.id === expected.id &&
    active.environment === expected.environment && active.token === expected.token;
}

/** Bounded, noninteractive restoration; cannot call Connect or ask credentials. */
export function trySilentReconnectSession(
  expected: ExpectedConnection,
  mayCommit?: () => boolean
): Promise<SilentReconnectResult> {
  const generation = connectionGeneration;
  return queueConnection(async (): Promise<SilentReconnectResult> => {
    if (generation !== connectionGeneration || !matchesSession(expected)) return "stale";
    const server = ServersConfig.getServerById(expected.id);
    if (!server) return "stale";
    try {
      const result: IReconnectInfo = await requestSessionRecovery(
        server, expected.environment, expected.token, ConnTypeIds.CONNT_DEBUGGER, "automatic"
      );
      if (generation !== connectionGeneration || !matchesSession(expected) ||
          (mayCommit && !mayCommit())) return "stale";
      if (result.user) server.username = result.user;
      doFinishConnectProcess(server, result.token, expected.environment);
      return "restored";
    } catch (error) {
      if (generation !== connectionGeneration || !matchesSession(expected)) return "stale";
      if (error instanceof RecoveryFailure &&
          (error.code === "SERVER_REJECTED_TOKEN" || error.code === "EMPTY_REPLY_TOKEN" ||
           error.code === "WRONG_ENVIRONMENT")) return "rejected";
      return "failed";
    }
  });
}

export function connectServer(
  serverItem: ServerItem,
  environment: string,
  connType: ConnTypeIds
): Promise<void> {
  // A recovering session has a cached token but is NOT necessarily connected.
  // The user must still be able to choose Connect to authenticate afresh.
  const wasRecovering = !!connectionPresentation.forEnvironment(serverItem.id, environment);
  const generation = ++connectionGeneration;
  pendingAuthentication = undefined;
  return queueConnection(async () => {
    if (generation !== connectionGeneration) return;
    const current = ServersConfig.getCurrentServer();
    if (current && current.id === serverItem.id && current.environment === environment && !wasRecovering) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("The server selected is already connected.")
      );
      return;
    }

    if (wasRecovering && current && current.id === serverItem.id && current.environment === environment) {
      // Keep the saved token but retire this failed active session locally.
      ServersConfig.markConnectionLost();
    }
    const previous = serverProvider.connectedServerItem;
    if (previous) {
      await doDisconnect(previous);
    }
    // Clear the old indicator only after the stale active session was removed.
    connectionPresentation.clear();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Connecting to the server {0}", serverItem.name),
      },
      async (progress) => {
        progress.report({ increment: 0 });
        if (generation === connectionGeneration) {
          await doConnect(serverItem, environment, connType, generation);
        }
        progress.report({ increment: 100 });
      }
    );
  });
}

export function authenticate(
  serverItem: ServerItem,
  environment: string,
  username: string,
  password: string,
  generation: number
): Promise<void> {
  const encoding: string =
    vscode.env.language === "ru" ? ENABLE_CODE_PAGE.CP1251 : ENABLE_CODE_PAGE.CP1252;

  return queueConnection(async () => {
    if (generation !== connectionGeneration ||
        pendingAuthentication?.generation !== generation ||
        pendingAuthentication.serverId !== serverItem.id ||
        pendingAuthentication.environment !== environment ||
        pendingAuthentication.token !== serverItem.token) {
      return; // An older login prompt must not authenticate a newer session.
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Authenticating user [{0}] in server [{1}]", username, serverItem.name),
      },
      async (progress) => {
        progress.report({ increment: 0 });
        const result = await sendAuthenticateRequest(serverItem, environment, username, password, encoding);
        if (generation !== connectionGeneration) return;
        if (!result.sucess || !result.token) {
          throw new Error(vscode.l10n.t("Server authentication failed."));
        }
        pendingAuthentication = undefined;
        serverItem.username = username;
        doFinishConnectProcess(serverItem, result.token, environment);
        progress.report({ increment: 100 });
      }
    );
  });
}

async function doReconnect(
  serverItem: ServerItem,
  environment: string,
  connType: ConnTypeIds,
  generation: number,
  mode: "manual" | "startup"
): Promise<void> {
  const savedToken = ServersConfig.getSavedTokens(serverItem.id, environment);
  const result: IReconnectInfo = await requestSessionRecovery(
    serverItem, environment, savedToken || "", connType, mode
  );
  // An old or canceled request is NEVER allowed to replace a newer session.
  if (generation !== connectionGeneration) return;
  if (result.user) serverItem.username = result.user;
  doFinishConnectProcess(serverItem, result.token, environment);
}

/**
 * Explicit Reconnect only. An invalid or expired token must NOT be converted
 * into a new Connect operation: authentication requires an explicit Connect.
 * In particular, never send Disconnect for the existing session just to retry.
 */
export function reconnectServer(
  serverItem: ServerItem,
  environment: string,
  connType: ConnTypeIds,
  silent = false
): Promise<void> {
  const generation = ++connectionGeneration;
  pendingAuthentication = undefined;
  return queueConnection(async () => {
    if (generation !== connectionGeneration) return;
    const previous = serverProvider.connectedServerItem;
    if (previous && (previous.id !== serverItem.id || previous.environment !== environment)) {
      recoveryDiagnostic(silent ? "startup" : "manual", "skip", "DIFFERENT_ACTIVE_SESSION");
      if (!silent) vscode.window.showWarningMessage(
        "Existe outra sessão ativa. Use Disconnect antes de reconectar a outro servidor/ambiente."
      );
      return;
    }

    // The manual/startup attempt has begun: a cached green icon is no longer
    // trustworthy until the remote Language Server confirms reconnection.
    connectionPresentation.setReconnecting(serverItem.id, environment, 1, 1);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Reconnecting to the server {0}", serverItem.name)
      },
      async (progress) => {
        progress.report({ increment: 0 });
        try {
          await doReconnect(serverItem, environment, connType, generation,
            silent ? "startup" : "manual");
          // doFinishConnectProcess clears the icon only on confirmed success.
        } catch (error) {
          if (generation === connectionGeneration) {
            // Do not delete saved tokens: the server may recover later.
            // Mark the actual connection as lost, so other views cannot remain green.
            connectionPresentation.setDisconnected(serverItem.id, environment);
            const active = ServersConfig.getCurrentServer();
            if (active && active.id === serverItem.id && active.environment === environment) {
              ServersConfig.markConnectionLost();
            }
            if (!silent) {
              vscode.window.showWarningMessage(
                "Não foi possível reconectar a " + serverItem.name + " / " + environment + ". " +
                recoveryMessage(error) + " Use Connect para autenticar novamente, se necessário."
              );
            }
          }
        } finally {
          // On a superseded attempt, the newer operation owns the indicator.
          progress.report({ increment: 100 });
        }
      }
    );
  });
}

export function reconnectLastServer(): Promise<void> {
  const last = ServersConfig.lastConnectedServer();
  if (!last || !last.environment) return Promise.resolve();
  // Startup recovery never asks for credentials or falls back to Connect.
  return reconnectServer(last, last.environment, ConnTypeIds.CONNT_DEBUGGER, true);
}

class NodeError {
  code: number;
  message: string;
}

function handleError(nodeError: NodeError) {
  vscode.window.showErrorMessage(nodeError.code + ": " + nodeError.message);
}

async function doDisconnect(serverItem: ServerItem): Promise<void> {
  try {
    await sendDisconnectRequest(serverItem);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(vscode.l10n.t("Unable to confirm remote disconnect: {0}", message));
  } finally {
    // Explicit disconnect removes a pending/rejected indicator as well.
    connectionPresentation.clear(serverItem.id);
    // The local session is disconnected regardless of the remote response.
    // Avoid invalidating another session if a late response arrives.
    const current = ServersConfig.getCurrentServer();
    if (current && current.id === serverItem.id) {
      ServersConfig.clearConnectedServerConfig();
    }
    await executeCommand("_totvs-developer-studio.clearMonitorPanel");
  }
}

async function doValidation(
  context: vscode.ExtensionContext,
  serverItem: ServerItem
) {
  await sendValidationRequest(serverItem.address, serverItem.port, serverItem.type).then(
    (validationInfo: IValidationInfo) => {
      //retornou uma versao valida no servidor.
      const updated = ServersConfig.updateBuildVersion(
        serverItem.id,
        validationInfo.build,
        validationInfo.secure
      );
      serverItem.buildVersion = validationInfo.build;
      if (updated) {
        //continua a autenticacao.
        inputConnectionParameters(
          context,
          serverItem,
          ConnTypeIds.CONNT_DEBUGGER,
          false
        );
      }
      return;
    },
    (err: ResponseError<object>) => {
      vscode.window.showErrorMessage(err.message);
    }
  );
}

async function doConnect(
  serverItem: ServerItem,
  environment: string,
  connType: ConnTypeIds,
  generation: number
): Promise<void> {
  const result = await sendConnectRequest(serverItem, environment, connType);
  if (generation !== connectionGeneration) return;
  if (!result.sucess) {
    throw new Error(vscode.l10n.t("The server refused the connection."));
  }
  if (result.needAuthentication) {
    serverItem.token = result.token;
    pendingAuthentication = { generation, serverId: serverItem.id, environment, token: result.token };
    void inputAuthenticationParameters(serverItem, environment, generation);
  } else {
    doFinishConnectProcess(serverItem, result.token, environment);
  }
}

export function createNewProtheusServer(
  serverName: string,
  port: number,
  address: string,
  secure: boolean,
  buildVersion: string,
  environment: string,
  username: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const serverId = ServersConfig.createNewServer(
      "totvs_server_protheus",
      serverName,
      port,
      address,
      buildVersion,
      secure,
      []
    );
    if (serverId !== undefined) {
      ServersConfig.saveServerEnvironmentUsername(serverId, environment, username);
      resolve(true);
    } else {
      resolve(false);
    }
  });
}
