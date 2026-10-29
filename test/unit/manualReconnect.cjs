"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");

const history = {
  reconnect: 0, connect: 0, authenticated: 0, prompts: [],
  removed: 0, saved: [], errors: [], warnings: []
};
let server, selected, savedToken, reconnectResponse;
let reuseSavedToken = true;

function reset() {
  server = {
    id: "CAASP", name: "CAASP PRD", buildVersion: "7.00.241021",
    environment: "CZA3BD_COMPILA", token: "STALE_TOKEN", username: "admin",
    address: "test-server", port: 7600
  };
  selected = server;
  savedToken = "STALE_TOKEN";
  reuseSavedToken = true;
  reconnectResponse = () => Promise.reject(new Error(
    "One or more validations errors detected:\n- Connection token was not informed."
  ));
  Object.keys(history).forEach(key => {
    if (Array.isArray(history[key])) history[key].length = 0;
    else history[key] = 0;
  });
}

const mockConfig = {
  getCurrentServer: () => selected || "",
  getSavedTokens: () => savedToken,
  getServerById: id => id === server.id ? server : undefined,
  removeSavedConnectionToken: () => { history.removed++; savedToken = undefined; },
  markConnectionLost: () => { selected = undefined; },
  clearConnectedServerConfig: () => { selected = undefined; },
  saveConnectionToken: (id, token, env) => {
    savedToken = token;
    history.saved.push({ id, token, env });
  },
  saveSelectServer: (id, token, env, username) => {
    server.token = token;
    server.environment = env;
    server.username = username;
    selected = server;
  }
};
const vscode = {
  workspace: {
    getConfiguration: section => {
      assert.equal(section, "totvsLanguageServer");
      return {
        get: (key, fallback) => key === "connection.useSavedToken"
          ? reuseSavedToken : fallback
      };
    }
  },
  l10n: { t: (value) => value },
  env: { language: "pt-br" },
  window: {
    withProgress: async (_options, callback) => callback({ report: () => {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: message => { history.warnings.push(message); return Promise.resolve(); },
    showErrorMessage: message => { history.errors.push(message); return Promise.resolve(); }
  },
  commands: {
    getCommands: () => Promise.resolve([]),
    executeCommand: () => Promise.resolve()
  },
  ProgressLocation: { Window: 1 }
};
const provider = { connectedServerItem: undefined };
const protocol = {
  ConnTypeIds: { CONNT_DEBUGGER: 3, CONNT_MONITOR: 13 },
  ENABLE_CODE_PAGE: { CP1252: "CP1252", CP1251: "CP1251" },
  sendReconnectRequest: () => { history.reconnect++; return reconnectResponse(); },
  sendConnectRequest: () => {
    history.connect++;
    return Promise.resolve({
      sucess: true, token: "PROVISIONAL", needAuthentication: true
    });
  },
  sendAuthenticateRequest: (serverItem, env, user) => {
    assert.equal(serverItem.token, "PROVISIONAL",
      "authentication must receive the newly issued provisional token");
    history.authenticated++;
    return Promise.resolve({ sucess: true, token: "NEW_AUTHENTICATED_TOKEN" });
  },
  sendDisconnectRequest: () => Promise.resolve({ sucess: true }),
};
const originalLoad = Module._load;
let methods;
try {
  Module._load = function(request, parent, isMain) {
    if (request === "vscode") return vscode;
    if (request === "./utils") return {
      __esModule: true, default: {}, ServersConfig: mockConfig
    };
    if (request === "./inputConnectionParameters") return {};
    if (request === "./inputAuthenticationParameters") return {
      inputAuthenticationParameters: async (item, env, generation) => {
        history.prompts.push({ item, env, generation });
      }
    };
    if (request === "vscode-languageclient") return { ResponseError: Error };
    if (request === "./serverItemProvider") return {
      __esModule: true, default: provider
    };
    if (request === "./protocolMessages") return protocol;
    if (request === "./serverItem") return {
      ServerItem: class {}, EnvSection: class {}
    };
    if (request === "./utilities/processSelectResource") return {
      processSelectResourceMessage: () => false
    };
    return originalLoad.apply(this, arguments);
  };
  methods = require("../../out/serversView.js");
} finally {
  Module._load = originalLoad;
}

async function main() {
  reset();
  await methods.reconnectServer(
    server, "CZA3BD_COMPILA", protocol.ConnTypeIds.CONNT_DEBUGGER
  );
  assert.equal(history.reconnect, 1);
  assert.equal(history.connect, 1,
    "manual reconnect must establish a fresh connection after LS rejects the saved token");
  assert.equal(history.removed, 1, "rejected saved session must be discarded");
  assert.equal(history.prompts.length, 1,
    "new connection must offer authentication instead of failing the command");
  assert.equal(history.errors.length, 0);
  await methods.authenticate(
    server, "CZA3BD_COMPILA", "admin", "password", history.prompts[0].generation
  );
  assert.equal(history.authenticated, 1);
  assert.equal(server.token, "NEW_AUTHENTICATED_TOKEN");
  assert.equal(selected, server);
  assert.equal(savedToken, "NEW_AUTHENTICATED_TOKEN");

  reset();
  reconnectResponse = () => Promise.resolve({
    sucess: false, token: "", environment: "", user: ""
  });
  await methods.reconnectServer(
    server, "CZA3BD_COMPILA", protocol.ConnTypeIds.CONNT_DEBUGGER
  );
  assert.equal(history.connect, 1,
    "explicit refusal should likewise start a fresh connection");
  assert.equal(history.removed, 1);

  reset();
  savedToken = undefined;
  await methods.reconnectServer(
    server, "CZA3BD_COMPILA", protocol.ConnTypeIds.CONNT_DEBUGGER
  );
  assert.equal(history.reconnect, 0,
    "never attempt reconnect RPC with no saved token");
  assert.equal(history.connect, 1);

  reset();
  reuseSavedToken = false;
  await methods.reconnectServer(
    server, "CZA3BD_COMPILA", protocol.ConnTypeIds.CONNT_DEBUGGER
  );
  assert.equal(history.reconnect, 0,
    "disabled token reuse must not call the LS reconnect endpoint");
  assert.equal(history.connect, 1,
    "disabled token reuse must start a fresh connection");
  assert.equal(history.prompts.length, 1,
    "fresh connection may require user authentication");
  assert.equal(history.removed, 0,
    "bypassing reuse must not destroy the existing saved token");
  await methods.reconnectLastServer();
  assert.equal(history.connect, 1,
    "disabled token reuse must not pop up a startup login dialog");

  reset();
  reconnectResponse = () => Promise.reject(new Error(
    "AppServer unavailable: socket closed"
  ));
  await assert.rejects(
    methods.reconnectServer(
      server, "CZA3BD_COMPILA", protocol.ConnTypeIds.CONNT_DEBUGGER
    ),
    /socket closed/
  );
  assert.equal(history.connect, 0,
    "unrelated transport errors must not be mistaken for token invalidation");
  assert.equal(history.removed, 0);

  console.log("Manual reconnection fallback integration tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
