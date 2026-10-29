"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");

const requests = [];
const client = {
  sendRequest: (method, params) => {
    requests.push({ method, params });
    if (method === "$totvsserver/reconnect") {
      return Promise.resolve({
        connectionToken: "RECONNECTED_TOKEN",
        environment: "PROD", user: "admin"
      });
    }
    if (method === "$totvsmonitor/getUsers") return Promise.resolve({ mntUsers: [] });
    if (method === "$totvsmonitor/getConnectionStatus") return Promise.resolve({ status: true });
    return Promise.resolve({ message: "OK" });
  }
};

const originalLoad = Module._load;
let protocol;
try {
  Module._load = function(request, parent, main) {
    if (request === "vscode") return {};
    if (request === "./extension") return { languageClient: client };
    if (request === "vscode-languageclient") return {
      DidChangeConfigurationNotification: { type: "mock" }
    };
    if (request === "./debug") return { _debugEvent: undefined };
    if (request === "./utils") return { ServersConfig: {} };
    return originalLoad.apply(this, arguments);
  };
  protocol = require("../../out/protocolMessages.js");
} finally {
  Module._load = originalLoad;
}

async function main() {
  const invalid = { id: "CAASP", name: "CAASP PRD", token: "" };
  await assert.rejects(
    protocol.sendGetServerInformationsInfo(invalid),
    /missing authenticated session token/i
  );
  await assert.rejects(
    protocol.sendGetServerPermissionsInfo(invalid),
    /missing authenticated session token/i
  );
  await assert.rejects(
    protocol.sendIsLockServer(invalid),
    /authenticated connection token/i
  );
  assert.deepEqual(await protocol.sendGetUsersRequest(invalid), []);
  const reconnect = await protocol.sendReconnectRequest(
    invalid, "", protocol.ConnTypeIds.CONNT_DEBUGGER
  );
  assert.equal(reconnect.sucess, false);
  assert.equal(requests.length, 0,
    "no Language Server RPC may receive a missing connection token");

  const valid = { ...invalid, token: "AUTHENTICATED_TOKEN" };
  await protocol.sendGetServerInformationsInfo(valid);
  await protocol.sendGetServerPermissionsInfo(valid);
  await protocol.sendIsLockServer(valid);
  const success = await protocol.sendReconnectRequest(
    valid, valid.token, protocol.ConnTypeIds.CONNT_MONITOR
  );
  assert.equal(success.sucess, true);
  assert.equal(requests.length, 4);
  assert.equal(
    requests[0].params.serverInformationsInfo.connectionToken, valid.token
  );
  assert.equal(
    requests[1].params.serverPermissionsInfo.connectionToken, valid.token
  );
  assert.equal(
    requests[2].params.getConnectionStatusInfo.connectionToken, valid.token
  );
  assert.equal(
    requests[3].params.reconnectInfo.connectionToken, valid.token
  );
  console.log("Tokenless session RPC guards passed.");
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
