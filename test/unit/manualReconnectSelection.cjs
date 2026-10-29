"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");

class ServerItem {
  constructor(id) { this.id = id; }
}
class EnvSection {}

const data = {
  id: "CAASP", name: "CAASP PRD", environment: "CZA3BD_COMPILA",
  environments: ["CZA3BD_COMPILA"], address: "example.test", port: 7600
};
const calls = { reconnect: 0, connect: 0, errors: [], tokenQueries: 0 };
const fakeVscode = {
  l10n: { t: value => value },
  Uri: { file: path => ({ fsPath: path }) },
  window: { showErrorMessage: msg => { calls.errors.push(msg); return Promise.resolve(); } }
};
const originalLoad = Module._load;
let input;
try {
  Module._load = function(request, parent, main) {
    if (request === "vscode") return fakeVscode;
    if (request === "./utils") return {
      __esModule: true, default: {},
      ServersConfig: {
        getServers: () => [data],
        getServerById: id => id === data.id ? data : undefined,
        getSavedTokens: () => { calls.tokenQueries++; return undefined; }
      }
    };
    if (request === "./multiStepInput") return {
      MultiStepInput: {
        run: async callback => {
          const dialog = {
            showQuickPick: async options => options.items[0]
          };
          await callback(dialog);
        }
      }
    };
    if (request === "./serversView") return {
      connectServer: async () => { calls.connect++; },
      reconnectServer: async () => { calls.reconnect++; }
    };
    if (request === "./protocolMessages") return {
      ConnTypeIds: { CONNT_DEBUGGER: 3 }
    };
    if (request === "./serverItem") return { ServerItem, EnvSection };
    return originalLoad.apply(this, arguments);
  };
  input = require("../../out/inputConnectionParameters.js");
} finally {
  Module._load = originalLoad;
}

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function main() {
  const item = new ServerItem(data.id);

  await input.inputConnectionParameters({}, item, 3, true);
  await flush();
  assert.equal(calls.reconnect, 1,
    "manual Reconnect must invoke reconnectServer even without a saved token");
  assert.equal(calls.connect, 0);
  assert.equal(calls.errors.length, 0);
  assert.equal(calls.tokenQueries, 0,
    "UI should not attempt to select reconnection strategy from cached tokens");

  await input.inputConnectionParameters({}, item, 3, false);
  await flush();
  assert.equal(calls.connect, 1, "normal Connect must remain a fresh connection");
  assert.equal(calls.reconnect, 1);
  console.log("Manual reconnect UI dispatch regression tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
