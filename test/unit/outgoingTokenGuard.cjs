"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");

const outbound = [];
const logs = [];
class FakeLanguageClient {
  constructor() {
    this.outputChannel = { appendLine: msg => logs.push(msg) };
  }
  sendRequest(method, params, token) {
    outbound.push({ method, params, token });
    return Promise.resolve({ message: "OK" });
  }
  registerBuiltinFeatures() {}
}

const originalLoad = Module._load;
let Client;
try {
  Module._load = function(request, parent, main) {
    if (request === "vscode-languageclient/node") {
      return { LanguageClient: FakeLanguageClient };
    }
    return originalLoad.apply(this, arguments);
  };
  Client = require("../../out/TotvsLanguageClientA.js").TotvsLanguageClientA;
} finally {
  Module._load = originalLoad;
}
const client = new Client({}, {});

async function main() {
  const missing = {
    serverInformationsInfo: { connectionToken: "" }
  };
  const error = await client.sendRequest(
    "$totvsserver/serverInformations", missing
  ).then(() => null, failure => failure);
  assert.ok(error instanceof Error, "must fail before sending a missing-token RPC");
  assert.match(error.message, /serverInformations/);
  assert.equal(outbound.length, 0, "do not send tokenless request to LS");
  assert.ok(logs.some(line => /serverInformations/.test(line)),
    "log exactly which RPC attempted to use an invalid session");
  assert.ok(logs.some(line => /Origem/.test(line)),
    "log a caller location for follow-up diagnosis");
  assert.ok(!logs.join(" ").includes("MY_SECRET"),
    "diagnostics must never leak request payloads");

  const monitorMissing = await client.sendRequest(
    "$totvsmonitor/getUsers",
    { getUsersInfo: { connectionToken: undefined } }
  ).then(() => null, failure => failure);
  assert.ok(monitorMissing instanceof Error);
  assert.equal(outbound.length, 0);

  const unguardedDirectCall = await client.sendRequest(
    "$totvsserver/inspectorObjects",
    { inspectorObjectsInfo: { connectionToken: null } }
  ).then(() => null, failure => failure);
  assert.ok(unguardedDirectCall instanceof Error,
    "direct sendRequest callers must receive identical validation");
  assert.equal(outbound.length, 0);

  const valid = { serverInformationsInfo: { connectionToken: "MY_SECRET" } };
  await client.sendRequest("$totvsserver/serverInformations", valid);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].params, valid);
  assert.ok(!logs.join(" ").includes("MY_SECRET"),
    "accepted session tokens must never be echoed to diagnostics");

  // Authenticated reconnect, and initial connect/validation are allowed.
  await client.sendRequest("$totvsserver/reconnect",
    { reconnectInfo: { connectionToken: "MY_SECRET" } });
  await client.sendRequest("$totvsserver/connect", { connectionInfo: { address: "example" } });
  await client.sendRequest("$totvsserver/validation", { validationInfo: { address: "example" } });
  await client.sendRequest("$totvsserver/telemetry");
  assert.equal(outbound.length, 5);

  // Standard LSP messages must not be subjected to TOTVS token validation.
  await client.sendRequest("textDocument/hover", { textDocument: { uri: "file:///x" } });
  assert.equal(outbound.length, 6);

  console.log("Central outgoing connection-token guards passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
