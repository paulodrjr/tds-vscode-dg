"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");

function load(relativePath, dependencies) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2016, esModuleInterop: true }
  });
  const errors = (compiled.diagnostics || []).filter(x => x.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${relativePath}: ${errors.map(x => x.messageText)}`);
  const mod = {exports: {}};
  const requireMock = name => {
    if (!Object.prototype.hasOwnProperty.call(dependencies, name)) {
      throw new Error(`Missing mock for '${name}' in ${relativePath}`);
    }
    return dependencies[name];
  };
  new Function("require", "module", "exports", "__dirname", "__filename", compiled.outputText)
    (requireMock, mod, mod.exports, path.dirname(filename), filename);
  return mod.exports;
}

function fakeVscode() {
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = fn => {
        this.listeners.push(fn);
        return {dispose: () => {this.listeners = this.listeners.filter(x => x !== fn);}};
      };
    }
    fire() { this.listeners.slice().forEach(fn => fn()); }
    dispose() { this.listeners.length = 0; }
  }
  class TreeItem {
    constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
  }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  class ThemeColor { constructor(id) { this.id = id; } }
  return {
    EventEmitter, TreeItem, ThemeIcon, ThemeColor,
    extensions: { getExtension: () => ({extensionPath:"/mock/tds-vscode"}) },
    Uri: {file: path => ({fsPath:path})},
    TreeItemCollapsibleState: {Collapsed: 1}
  };
}

async function main() {
  const vscode = fakeVscode();
  const state = load("src/server/connectionPresentation.ts", {vscode}).connectionPresentation;
  const provider = { isConnected: () => true, isCurrentEnvironment: env => env.label === "CZA3BD_PAULO" };
  const models = load("src/serverItem.ts", {
    vscode,
    path,
    "./serverItemProvider": {__esModule: true, default: provider},
    "./server/connectionPresentation": {connectionPresentation: state}
  });
  let events = 0;
  const listener = state.onDidChange(() => events++);
  const server = new models.ServerItem("CAASP PRD", "totvs_server_protheus", "host", 7890,
    0, 1, "S", "7.00.240102P", "CURRENT", [], []);
  const environment = new models.EnvSection("CZA3BD_PAULO", server);
  const untouched = new models.EnvSection("CZA3BD_COMPLIA", server);
  server.updatePresentation();
  environment.updatePresentation();
  assert.match(server.iconPath.light.fsPath, /connected\.svg$/);
  assert.match(environment.iconPath.light.fsPath, /connected\.svg$/);

  state.setVerifying("S", "CZA3BD_PAULO");
  server.updatePresentation();
  environment.updatePresentation();
  assert.equal(server.iconPath.id, "loading~spin");
  assert.equal(environment.description, "Verificando conexão");
  assert.equal(environment.contextValue, "envSectionNotCurrent");
  state.setReconnecting("S", "CZA3BD_PAULO", 0, 3);
  server.updatePresentation();
  environment.updatePresentation();
  untouched.updatePresentation();
  assert.equal(server.iconPath.id, "sync~spin");
  assert.equal(environment.iconPath.id, "sync~spin");
  assert.equal(server.iconPath.color.id, "charts.yellow");
  assert.match(environment.description, /aguardando tentativa/);
  assert.equal(environment.contextValue, "envSectionNotCurrent");
  assert.equal(server.contextValue, "serverItemNotConnected");
  assert.equal(server.isConnected, false);
  assert.match(untouched.iconPath.light.fsPath, /environment\.svg$/,
    "Other environments cannot show a reconnection spinner");

  state.setReconnecting("S", "CZA3BD_PAULO", 2, 3);
  environment.updatePresentation();
  assert.equal(environment.description, "Reconectando (2/3)");
  assert.equal(environment.iconPath.id, "sync~spin");
  state.setReconnecting("S", "CZA3BD_PAULO", 2, 3);
  assert.equal(events, 3, "Idempotent state must not repaint the entire tree");

  state.setDisconnected("S", "CZA3BD_PAULO");
  server.updatePresentation();
  environment.updatePresentation();
  assert.equal(server.iconPath.id, "debug-disconnect");
  assert.equal(environment.iconPath.id, "debug-disconnect");
  assert.equal(environment.description, "Desconectado");
  assert.equal(environment.isCurrent, false);

  state.clear("OTHER");
  assert.equal(state.forServer("S").phase, "disconnected");
  state.clear("S", "CZA3BD_PAULO");
  server.updatePresentation();
  environment.updatePresentation();
  assert.equal(server.isConnected, true);
  assert.match(server.iconPath.light.fsPath, /connected\.svg$/);
  assert.match(environment.iconPath.light.fsPath, /connected\.svg$/);
  assert.equal(environment.description, undefined);
  assert.equal(events, 5);
  listener.dispose();
  console.log("PASS connectionPresentation: animated icon, environment isolation, progress, offline and restoration");
}
main().catch(error => {console.error(error); process.exitCode = 1;});
