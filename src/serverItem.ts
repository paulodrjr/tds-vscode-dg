import * as vscode from "vscode";
import * as path from "path";
import serverProvider from "./serverItemProvider";
import { connectionPresentation, ConnectionVisualState } from "./server/connectionPresentation";

const RESOURCE_FOLDER = path.join(vscode.extensions.getExtension("TOTVS.tds-vscode")?.extensionPath || path.resolve(__dirname, ".."), "resources");
const RESOURCE_DARK = path.join(RESOURCE_FOLDER, "dark");
const RESOURCE_LIGHT = path.join(RESOURCE_FOLDER, "light");

export type ServerType =
  | "totvs_server_protheus"
  | "totvs_server_logix"
  | "totvs_server_totvstec";

export interface IServerInformations {
  errorMessage: string;
  serverDetectedType: string;
  environmentDetectedType: ServerType;
  permissions: string[];
}

function reconnectText(status: ConnectionVisualState): string {
  return status.attempt > 0
    ? `Reconectando (${status.attempt}/${status.maxAttempts})`
    : "Reconectando (aguardando tentativa)";
}

function recoveryIcon(status: ConnectionVisualState): vscode.ThemeIcon {
  return status.phase === "verifying"
    ? new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.yellow"))
    : status.phase === "reconnecting"
      ? new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.yellow"))
      : new vscode.ThemeIcon("debug-disconnect", new vscode.ThemeColor("charts.red"));
}

export class ServerItem extends vscode.TreeItem {
  public environment: string = "";
  public username: string = "";
  public smartclientBin: string = "";
  public informations: IServerInformations;

  constructor(
    public name: string,
    public readonly type: ServerType,
    public readonly address: string,
    public readonly port: number,
    public secure: number,
    public collapsibleState: vscode.TreeItemCollapsibleState,
    public id: string,
    public buildVersion: string,
    public token: string,
    public environments?: Array<EnvSection>,
    public includes?: string[],
    public readonly command?: vscode.Command
  ) {
    super(name, collapsibleState);
  }

  public get isConnected(): boolean {
    // A session in recovery cannot be presented as already connected.
    return !connectionPresentation.forServer(this.id) && serverProvider.isConnected(this);
  }

  public get isServerP20OrGreater(): boolean {
    if (this.buildVersion) {
      return this.buildVersion.localeCompare("7.00.191205P") > 0;
    }
    return false;
  }

  description = `${this.address}:${this.port}`;
  tooltip = `${serverTypeString(this.type)} ${this.buildVersion}`;

  public updatePresentation(): void {
    const status = connectionPresentation.forServer(this.id);
    if (status) {
      const message = status.phase === "verifying" ? "Verificando conexão" :
        status.phase === "reconnecting" ? reconnectText(status) : "Desconectado";
      this.iconPath = recoveryIcon(status);
      this.description = `${this.address}:${this.port} · ${message}`;
      this.tooltip = `${this.name} / ${status.environment}: ${message}`;
      this.contextValue = "serverItemNotConnected";
      return;
    }

    const icon = serverTypeImage(this);
    this.iconPath = {
      light: vscode.Uri.file(path.join(RESOURCE_LIGHT, icon)),
      dark: vscode.Uri.file(path.join(RESOURCE_DARK, icon)),
    };
    this.description = `${this.address}:${this.port}`;
    this.tooltip = `${serverTypeString(this.type)} ${this.buildVersion}`;
    this.contextValue = this.isConnected ? "serverItem" : "serverItemNotConnected";
  }
}

export class EnvSection extends vscode.TreeItem {
  constructor(
    public label: string,
    public readonly serverItemParent: ServerItem,
  ) {
    super(label);
  }

  public get isCurrent(): boolean {
    return !connectionPresentation.forEnvironment(this.serverItemParent.id, this.label) &&
      serverProvider.isCurrentEnvironment(this);
  }

  public updatePresentation(): void {
    const status = connectionPresentation.forEnvironment(this.serverItemParent.id, this.label);
    if (status) {
      const message = status.phase === "verifying" ? "Verificando conexão" :
        status.phase === "reconnecting" ? reconnectText(status) : "Desconectado";
      this.iconPath = recoveryIcon(status);
      this.description = message;
      this.tooltip = `${this.label} @ ${this.serverItemParent.label}: ${message}`;
      this.contextValue = "envSectionNotCurrent";
      return;
    }

    const icon = environmentTypeImage(this);
    this.iconPath = {
      light: vscode.Uri.file(path.join(RESOURCE_LIGHT, icon)),
      dark: vscode.Uri.file(path.join(RESOURCE_DARK, icon)),
    };
    this.description = undefined;
    this.tooltip = environmentTypeString(this);
    this.contextValue = this.isCurrent ? "envSection" : "envSectionNotCurrent";
  }
}

function serverTypeString(type: ServerType): string {
  const label: string = type.substring(type.lastIndexOf("_") + 1);
  return label.charAt(0).toUpperCase() + label.substring(1);
}

function serverTypeImage(server: ServerItem): string {
  const type: ServerType = server.type;
  const connected: boolean = server.isConnected;
  const sufix: string = type.substring(type.lastIndexOf("_") + 1);
  return connected ? `server_${sufix}_connected.svg` : `server_${sufix}.svg`;
}

function environmentTypeString(environment: EnvSection): string {
  return `${environment.label} @ ${environment.serverItemParent.label} -> ${environment.serverItemParent.informations?.environmentDetectedType}`;
}

function environmentTypeImage(environment: EnvSection): string {
  let sufix: string = "";
  const server: ServerItem = environment.serverItemParent;
  if (server.buildVersion) {
    if ((server.buildVersion.localeCompare("7.00.191205P") > 0) && (environment.isCurrent)) {
      const type: ServerType = server.type;
      if (
        type == "totvs_server_totvstec" &&
        server.informations?.environmentDetectedType
      ) {
        const type: string = server.informations.environmentDetectedType;
        sufix = "_" + type.substring(type.lastIndexOf("_") + 1);
      }
    }
    const current: boolean = environment.isCurrent;
    if (current) sufix += "_connected";
  }
  return `environment${sufix}.svg`;
}
