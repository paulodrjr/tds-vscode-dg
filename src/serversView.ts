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
  sendReconnectRequest,
  IReconnectInfo,
  ENABLE_CODE_PAGE,
} from "./protocolMessages";
import { EnvSection, ServerItem } from "./serverItem";
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

    vscode.commands.registerCommand("tds-vscode-dg.add", () => {
      if (vscode.workspace.workspaceFolders === undefined) {
        vscode.window.showErrorMessage("No folder opened.");
        return;
      }

      if (currentPanel) {
        currentPanel.reveal();
      } else {
        currentPanel = vscode.window.createWebviewPanel(
          "tds-vscode-dg.add",
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

    vscode.commands.registerCommand("tds-vscode-dg.config", () => {
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
    vscode.window.createTreeView("tds_dg_server", options);
    vscode.window.registerTreeDataProvider("tds_dg_server", serverProvider);

    vscode.commands.registerCommand(
      "tds-vscode-dg.connect",
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
      "tds-vscode-dg.reconnect",
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
      "tds-vscode-dg.disconnect",
      (serverItem: ServerItem) => {
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
        }
      }
    );

    vscode.commands.registerCommand(
      "tds-vscode-dg.selectenv",
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
      "tds-vscode-dg.delete",
      (serverItem: ServerItem) => {
        let ix = serverProvider.localServerItems.indexOf(serverItem);
        if (ix >= 0) {
          ServersConfig.deleteServer(serverItem.id);
        }
      }
    );

    vscode.commands.registerCommand(
      "tds-vscode-dg.delete.environment",
      (environmentItem: EnvSection) => {
        ServersConfig.deleteEnvironmentServer(environmentItem);
      }
    );

    vscode.commands.registerCommand(
      "tds-vscode-dg.rename",
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
  ServersConfig.saveConnectionToken(serverItem.id, token, environment);
  ServersConfig.saveSelectServer(
    serverItem.id,
    token,
    environment,
    serverItem.username
  );

  runCommandUpdateMonitor();
  //let isSafeRPO = serverItem.isSafeRPO; // this is not working returning => undefined
  let isSafeRPO = serverItem.buildVersion.localeCompare("7.00.191205P") > 0;
  // custom context tds-vscode-dg.isSafeRPO
  vscode.commands.executeCommand(
    "setContext",
    "tds-vscode-dg.isSafeRPO",
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
  executeCommand("_tds-vscode-dg.updateMonitorPanel");
}

// Keep connection changes ordered so a delayed disconnect cannot clear a new session.
let connectionQueue: Promise<void> = Promise.resolve();

function queueConnection(operation: () => Thenable<void>): Promise<void> {
  const next = connectionQueue.then(operation, operation);
  connectionQueue = next.catch((error: any) => {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(vscode.l10n.t("Server connection failed: {0}", message));
  });
  return connectionQueue;
}

export function connectServer(
  serverItem: ServerItem,
  environment: string,
  connType: ConnTypeIds
): Promise<void> {
  return queueConnection(async () => {
    const current = ServersConfig.getCurrentServer();
    if (current && current.id === serverItem.id && current.environment === environment) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("The server selected is already connected.")
      );
      return;
    }

    const previous = serverProvider.connectedServerItem;
    if (previous) {
      await doDisconnect(previous);
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Connecting to the server {0}", serverItem.name),
      },
      async (progress) => {
        progress.report({ increment: 0 });
        await doConnect(serverItem, environment, connType);
        progress.report({ increment: 100 });
      }
    );
  });
}

export function authenticate(
  serverItem: ServerItem,
  environment: string,
  username: string,
  password: string
): Promise<void> {
  const encoding: string =
    vscode.env.language === "ru" ? ENABLE_CODE_PAGE.CP1251 : ENABLE_CODE_PAGE.CP1252;

  return queueConnection(async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Authenticating user [{0}] in server [{1}]", username, serverItem.name),
      },
      async (progress) => {
        progress.report({ increment: 0 });
        const result = await sendAuthenticateRequest(serverItem, environment, username, password, encoding);
        if (!result.sucess || !result.token) {
          throw new Error(vscode.l10n.t("Server authentication failed."));
        }
        serverItem.username = username;
        doFinishConnectProcess(serverItem, result.token, environment);
        progress.report({ increment: 100 });
      }
    );
  });
}

function doReconnect(
  serverItem: ServerItem,
  environment: string,
  connType: ConnTypeIds
): Thenable<boolean> {
  const token = ServersConfig.getSavedTokens(serverItem.id, environment);

  if (token) {
    return sendReconnectRequest(serverItem, token, connType).then(
      (ri: IReconnectInfo) => {
        if (ri.sucess) {
          doFinishConnectProcess(serverItem, ri.token, environment);
        }
        return ri.sucess;
      }
    );
  } else {
    return Promise.resolve(false);
  }
}

export function reconnectServer(
  serverItem: ServerItem,
  environment: string,
  connType: ConnTypeIds
): Promise<void> {
  return queueConnection(async () => {
    const previous = serverProvider.connectedServerItem;
    // Reconnect uses the saved token: disconnecting the same session first could
    // invalidate that token. Disconnect only when switching servers/environments.
    if (previous && (previous.id !== serverItem.id || previous.environment !== environment)) {
      await doDisconnect(previous);
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Reconnecting to the server {0}", serverItem.name),
      },
      async (progress) => {
        progress.report({ increment: 0 });
        try {
          const reconnected = await doReconnect(serverItem, environment, connType);
          if (!reconnected) {
            throw new Error(vscode.l10n.t("Saved session is invalid. Connect again using your credentials."));
          }
        } catch (error) {
          ServersConfig.markConnectionLost();
          throw error;
        } finally {
          progress.report({ increment: 100 });
        }
      }
    );
  });
}

export function reconnectLastServer() {
  const lastConnectedServer = ServersConfig.lastConnectedServer();
  if (lastConnectedServer) {
    reconnectServer(
      lastConnectedServer,
      lastConnectedServer.environment,
      ConnTypeIds.CONNT_DEBUGGER
    );
  }
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
    // The local session is disconnected regardless of the remote response.
    // Avoid invalidating another session if a late response arrives.
    const current = ServersConfig.getCurrentServer();
    if (current && current.id === serverItem.id) {
      ServersConfig.clearConnectedServerConfig();
    }
    await executeCommand("_tds-vscode-dg.clearMonitorPanel");
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
  connType: ConnTypeIds
): Promise<void> {
  const result = await sendConnectRequest(serverItem, environment, connType);
  if (!result.sucess) {
    throw new Error(vscode.l10n.t("The server refused the connection."));
  }
  if (result.needAuthentication) {
    serverItem.token = result.token;
    inputAuthenticationParameters(serverItem, environment);
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
