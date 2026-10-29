"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");

const calls = { reconnect: [], disconnect: [], codepage: 0, users: 0, lock: 0 };
const active = {
  id: "CAASP", name: "CAASP PRD", environment: "CZA3BD_COMPILA",
  token: "AUTHENTICATED_TOKEN", address: "appserver.example", port: 7600
};
const logs = [];
const responses = [];
const configFor = id => ({ ...active, id });

const fakeVscode = {
  l10n: { t: str => str },
  window: { setStatusBarMessage: () => undefined },
  extensions: { getExtension: () => ({ extensionPath: "mock" }) }
};

const protocol = {
  ConnTypeIds: { CONNT_MONITOR: 13, CONNT_DEBUGGER: 3 },
  sendReconnectRequest: (item, token, type) => {
    calls.reconnect.push({ item, token, type });
    return new Promise((resolve, reject) => {
      responses.push({ resolve, reject });
    });
  },
  sendDisconnectRequest: item => {
    calls.disconnect.push(item);
    return Promise.resolve({ sucess: true });
  }
};

const fakeServersConfig = {
  getServerById: id => configFor(id),
  getCurrentServer: () => active
};

const originalLoad = Module._load;
let loader;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return fakeVscode;
    if (request === "../protocolMessages") return protocol;
    if (request === "../utils") return {
      __esModule: true,
      default: { deepCopy: data => JSON.parse(JSON.stringify(data)) },
      ServersConfig: fakeServersConfig,
      groupBy: () => new Map()
    };
    if (request === "../extension") return {
      languageClient: { outputChannel: { appendLine: msg => logs.push(msg) } }
    };
    if (request === "../serverItemProvider") return {
      __esModule: true, default: { connectedServerItem: active }
    };
    return originalLoad.apply(this, arguments);
  };
  loader = require("../../out/monitor/monitorLoader.js");
} finally {
  Module._load = originalLoad;
}

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function instance() {
  const state = Object.create(loader.MonitorLoader.prototype);
  state._isDisposed = false;
  state._monitorServer = null;
  state._monitorGeneration = 0;
  state._monitorConnecting = false;
  state._monitorTarget = undefined;
  state._panel = { webview: { postMessage: () => Promise.resolve(true) } };
  state.updateCodePage = () => { calls.codepage++; };
  state.updateUsers = () => { calls.users++; };
  state.isLockServer = () => { calls.lock++; };
  return state;
}

async function main() {
  const monitor = instance();

  // This reproduced the former crash: assigning null caused remote monitor
  // code-page and lock queries to run with no authenticated session.
  monitor._monitorServer = { token: "OLD_MONITOR" };
  monitor.monitorServer = null;
  assert.equal(calls.codepage, 0);
  assert.equal(calls.users, 0);
  assert.equal(calls.lock, 0);

  // A server with no token cannot initiate a reconnect or monitoring queries.
  monitor.toggleServerToMonitor({ ...active, token: "" });
  await drain();
  assert.equal(calls.reconnect.length, 0);
  assert.equal(calls.disconnect.length, 0);

  const selected = { ...active };
  monitor.toggleServerToMonitor(selected);
  assert.equal(calls.reconnect.length, 1);
  assert.equal(calls.reconnect[0].token, "AUTHENTICATED_TOKEN");
  // Repeated events include the result of the deferred permissions query.
  monitor.toggleServerToMonitor({ ...selected });
  assert.equal(calls.reconnect.length, 1, "avoid duplicate monitor reconnect");

  responses.shift().resolve({
    sucess: true, token: "MONITOR_TOKEN",
    environment: selected.environment, user: "admin"
  });
  await drain();
  assert.equal(monitor.monitorServer.token, "MONITOR_TOKEN");
  assert.equal(calls.codepage, 1);
  assert.equal(calls.users, 1);
  assert.equal(calls.lock, 1);

  monitor.toggleServerToMonitor({ ...selected });
  assert.equal(calls.reconnect.length, 1, "same-session refresh must not reattach");

  // The authenticated token changes after a new manual authentication.
  active.token = "NEW_AUTH_TOKEN";
  monitor.toggleServerToMonitor({ ...active });
  assert.equal(calls.disconnect.length, 1, "close old monitor session once");
  assert.equal(calls.reconnect.length, 2);
  assert.equal(calls.reconnect[1].token, "NEW_AUTH_TOKEN");
  responses.shift().resolve({
    sucess: true, token: "NEW_MONITOR_TOKEN",
    environment: active.environment
  });
  await drain();
  assert.equal(monitor.monitorServer.token, "NEW_MONITOR_TOKEN");

  // Switching servers before the asynchronous response returns cannot
  // restore the stale monitor token into the current session.
  active.token = "THIRD_AUTH_TOKEN";
  monitor.toggleServerToMonitor({ ...active });
  assert.equal(calls.reconnect.length, 3);
  active.id = "OTHER_SERVER";
  active.token = "OTHER_AUTH_TOKEN";
  monitor.toggleServerToMonitor({ ...active });
  assert.equal(calls.reconnect.length, 4);
  responses.shift().resolve({ sucess: true, token: "STALE_MONITOR" });
  await drain();
  assert.notEqual(monitor.monitorServer?.token, "STALE_MONITOR");
  responses.shift().resolve({ sucess: true, token: "NEW_SERVER_MONITOR" });
  await drain();
  assert.equal(monitor.monitorServer.token, "NEW_SERVER_MONITOR");

  monitor.toggleServerToMonitor(undefined);
  await drain();
  assert.equal(monitor.monitorServer, null);
  assert.equal(calls.reconnect.length, 4, "disconnect must not reconnect tokenless");

  console.log("Monitor authenticated session lifecycle tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
