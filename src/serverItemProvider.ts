import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { EnvSection, ServerItem, ServerType } from "./serverItem";
import Utils, { ServersConfig } from "./utils";
import { updateStatusBarItems } from "./statusBar";

class ServerItemProvider
  implements vscode.TreeDataProvider<ServerItem | EnvSection>
{
  isConnected(server: ServerItem) {
    return (
      this._connectedServerItem !== undefined &&
      this._connectedServerItem.id === server.id
    );
  }

  isCurrentEnvironment(environment: EnvSection) {
    return (
      this.isConnected(environment.serverItemParent) &&
      environment.serverItemParent.environment === environment.label
    );
  }

  private _onDidChangeTreeData: vscode.EventEmitter<
    ServerItem | EnvSection | undefined
  > = new vscode.EventEmitter<ServerItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<
    ServerItem | EnvSection | undefined
  > = this._onDidChangeTreeData.event;
  public localServerItems: Array<ServerItem>;

  private _connectedServerItem: ServerItem | undefined = undefined;

  private configFilePath: string = "";
  private configWatcher: fs.FSWatcher | undefined;
  private configListener: vscode.Disposable | undefined;

  constructor() {
    // check if there is an open folder
    if (vscode.workspace.workspaceFolders === undefined) {
      vscode.window.showErrorMessage("No folder opened.");
      return;
    }

    vscode.workspace.workspaceFolders.forEach((folder) => {
      if (!fs.existsSync(folder.uri.fsPath)) {
        vscode.window.showWarningMessage(
          `Folder not exist or access unavailable. Check it to avoid unwanted behavior. Path: ${folder.uri.fsPath}`
        );
      }
    });

    this.configListener = vscode.workspace.onDidChangeConfiguration(() => {
      this.checkServersConfigListener(true);
    });

  }

  dispose(): void {
    this.configWatcher?.close();
    this.configWatcher = undefined;
    this.configListener?.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(element?: ServerItem): void {
    this._onDidChangeTreeData.fire(element);
  }

  public get connectedServerItem(): ServerItem {
    return this._connectedServerItem;
  }

  // Unlike the public setter, this does not clear the last connected server:
  // it is used after a Language Server restart to allow session recovery.
  public invalidateConnection(): void {
    if (this._connectedServerItem !== undefined) {
      this._connectedServerItem = undefined;
      this.refresh();
    }
  }

  public set connectedServerItem(server: ServerItem) {
    if (this._connectedServerItem !== server) {
      this._connectedServerItem = server;

      let includes = ""; // XXX porque? apenas populando uma lista local e nao usa depois???
      if (server === undefined) {
        ServersConfig.clearConnectedServerConfig();
        const serversIncludes = ServersConfig.getGlobalIncludes();
        if (serversIncludes) {
          serversIncludes.forEach((includeItem) => {
            includes += includeItem + ";";
          });
        }
      } else {
        if (server.includes) {
          server.includes.forEach((includeItem) => {
            includes += includeItem + ";";
          });
        }
      }

      this.refresh();
    }
  }

  getTreeItem(element: ServerItem | EnvSection): vscode.TreeItem {
    element.updatePresentation();
    return element;
  }

  getChildren(element?: ServerItem): Thenable<ServerItem[] | EnvSection[]> {
    if (element) {
      return Promise.resolve(element.environments || []);
    }

    if (!this.localServerItems) {
      this.localServerItems = this.setConfigWithServerConfig();
    }
    return Promise.resolve([...this.localServerItems].sort((left, right) =>
      left.name.localeCompare(right.name)));
  }

  checkServersConfigListener(refresh: boolean): void {
    let serversJson: string = ServersConfig.getServerConfigFile();

    if (this.configFilePath !== serversJson) {
      if (this.configWatcher) {
        this.configWatcher.close();
        this.configWatcher = undefined;
      }

      if (!fs.existsSync(serversJson)) {
        ServersConfig.createServerConfig();
      }

      // Watch the directory, not the file inode: atomic renames replace the
      // file and would otherwise leave the watcher attached to the old inode.
      this.configWatcher = fs.watch(path.dirname(serversJson), (eventType, filename) => {
        if (filename && filename.toString() === path.basename(serversJson)) {
          updateStatusBarItems();
          this.localServerItems = this.setConfigWithServerConfig();
          this.refresh();
        }
      });

      this.configFilePath = serversJson;

      if (refresh) {
        this.localServerItems = this.setConfigWithServerConfig();
        this.refresh();
      }
    }

    ServersConfig.updateLinterIncludes();
  }

  /**
   * Cria os itens da arvore de servidores a partir da leitura do arquivo servers.json
   */
  private setConfigWithServerConfig() {
    const serverItem = (
      serverItem: string,
      type: ServerType,
      address: string,
      port: number,
      secure: number,
      id: string,
      buildVersion: string,
      token: string,
      environments: Array<EnvSection>,
      includes: string[]
    ): ServerItem => {
      return new ServerItem(
        serverItem,
        type,
        address,
        port,
        secure,
        vscode.TreeItemCollapsibleState.None,
        id,
        buildVersion,
        token,
        environments,
        includes
      );
    };
    const listServer = new Array<ServerItem>();

    ServersConfig.getServers().forEach((element) => {
      let environmentsServer = new Array<EnvSection>();
      // Do not overwrite the selected environment token with the token from
      // the last environment in the list (which may have no saved session).
      const selectedToken = element.environment
        ? ServersConfig.getSavedTokens(element.id, element.environment)
        : undefined;
      let token: string = element.token || selectedToken || "";

      if (element.environments) {
        element.environments.forEach((environment) => {
          const env = new EnvSection(
            environment,
            element,
          );

          // // XXX porque? sao dois forEach (servidores e environments) mas token seria sobrescrito e guardaria apenas o ultimo???
          // if (serverConfig.savedTokens) {
          //   serverConfig.savedTokens.forEach((savedToken) => {
          //     if (savedToken[0] === element.id + ":" + element.environment) {
          //       token = savedToken[1].token;
          //     }
          //   });
          // }
          environmentsServer.push(env);
        });
      }

      const si: ServerItem = serverItem(
        element.name,
        element.type,
        element.address,
        element.port,
        element.secure,
        element.id,
        element.buildVersion,
        token,
        environmentsServer,
        element.includes
      );
      if (element.smartclientBin) {
        si.smartclientBin = element.smartclientBin;
      }
      si.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      listServer.push(si);
    });

    return listServer;
  }
}

const serverProvider = new ServerItemProvider();
export default serverProvider;
