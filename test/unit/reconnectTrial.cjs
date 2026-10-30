/*
 * Diagnostic test suite for the experimental reconnect implementation.
 * Run from the project root after npm install:
 *   node test/unit/reconnectTrial.cjs
 * No real TOTVS Language Server or credentials required.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const ts = require("typescript");

function load(relativePath, mocks) {
  const file = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2016, esModuleInterop: true }
  });
  const errors = (compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${relativePath} has syntax errors: ${errors.map(e => e.messageText).join(";")}`);
  const mod = { exports: {} };
  const localRequire = (request) => {
    if (!Object.prototype.hasOwnProperty.call(mocks, request)) {
      throw new Error(`Unexpected dependency ${request} in ${relativePath}`);
    }
    return mocks[request];
  };
  const factory = new Function("require", "module", "exports", "__filename", "__dirname", compiled.outputText);
  factory(localRequire, mod, mod.exports, file, path.dirname(file));
  return mod.exports;
}

function fakeVscode() {
  const warnings = [], progress = [];
  const mock = {
    l10n: { t: (key) => key },
    window: {
      showWarningMessage: (message) => { warnings.push(message); return Promise.resolve(); },
      showErrorMessage: (message) => { warnings.push(message); return Promise.resolve(); },
      showInformationMessage: () => Promise.resolve(),
      withProgress: async (options, work) => {
        progress.push(options.title);
        return work({ report: () => {} });
      },
      ProgressLocation: { Window: 1 }
    },
    ProgressLocation: { Window: 1 },
    commands: {
      getCommands: () => Promise.resolve([]),
      executeCommand: () => Promise.resolve(),
      registerCommand: () => ({ dispose() {} })
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }),
      onDidChangeConfiguration: () => ({ dispose() {} })
    },
    debug: {
      activeDebugSession: undefined,
      onDidTerminateDebugSession: () => ({ dispose() {} })
    },
    CancellationTokenSource: class {
      constructor() { this.token = {}; this.cancelled = false; this.disposed = false; }
      cancel() { this.cancelled = true; }
      dispose() { this.disposed = true; }
    }
  };
  mock.warnings = warnings;
  mock.progress = progress;
  return mock;
}

async function testProtocol() {
  const vscode = fakeVscode();
  const calls = [], output = [];
  let response = () => ({ connectionToken: "NEW_TOKEN", environment: "DEV", user: "demo" });
  const client = {
    isReady: true,
    outputChannel: { appendLine: line => output.push(line) },
    sendRequest: (method, payload, cancellationToken) => {
      calls.push({ method, payload, cancellationToken });
      return Promise.resolve().then(response);
    }
  };
  const protocol = load("src/server/sessionRecovery.ts", {
    "vscode": vscode,
    "../extension": { languageClient: client }
  });
  const server = { id: "S", name: "SERVER", environment: "DEV" };
  const recover = (token = "SECRET_TOKEN_123", env = "DEV", ms = 25) =>
    protocol.requestSessionRecovery(server, env, token, 1, "manual", ms);

  const success = await recover();
  assert.equal(success.sucess, true);
  assert.equal(success.token, "NEW_TOKEN");
  assert.equal(calls[0].method, "$totvsserver/reconnect");
  assert.equal(calls[0].payload.reconnectInfo.connectionToken, "SECRET_TOKEN_123");
  assert.ok(calls[0].cancellationToken);
  assert.ok(output.some(s => s.includes("token=present")));
  assert.ok(output.every(s => !s.includes("SECRET_TOKEN_123")));
  await assert.rejects(recover(""), e => e.code === "NO_SAVED_TOKEN");
  assert.equal(calls.length, 1, "empty tokens must never reach the Language Server");

  response = () => { throw Error("Connection token was not informed: SECRET_TOKEN_123"); };
  await assert.rejects(recover(), e => e.code === "SERVER_REJECTED_TOKEN");
  assert.ok(output.every(s => !s.includes("SECRET_TOKEN_123")), "no token must leak into Output");

  response = () => ({ environment: "DEV" });
  await assert.rejects(recover(), e => e.code === "EMPTY_REPLY_TOKEN");
  response = () => ({ connectionToken: "NEW_TOKEN", environment: "PROD" });
  await assert.rejects(recover(), e => e.code === "WRONG_ENVIRONMENT");

  const previousSend = client.sendRequest;
  let observedToken;
  client.sendRequest = (_method, _payload, cancel) => {
    observedToken = cancel;
    return new Promise(() => {});
  };
  await assert.rejects(recover("SECRET_TOKEN_123", "DEV", 10), e => e.code === "TIMED_OUT");
  assert.ok(observedToken, "cancellable request must receive a cancellation token");
  client.sendRequest = previousSend;

  client.isReady = false;
  await assert.rejects(recover(), e => e.code === "LS_NOT_READY");
  client.isReady = true;
  console.log("PASS sessionRecovery: correct payload, missing token, server rejection, timeout, stale env, logs");
}

async function testManualConnection() {
  const vscode = fakeVscode();
  const received = [];
  const server = { id: "S", name: "SERVER", environment: "DEV", token: "PROVISIONAL", username: "demo", buildVersion: "7.00.191205P" };
  let storedToken = "OLD_TOKEN";
  let current = server;
  let rejected = false;
  let resolveRecovery;
  let visualRecovery = false;
  const config = {
    getSavedTokens: () => storedToken,
    getCurrentServer: () => current,
    getServerById: () => server,
    saveConnectionToken: (_id, token) => { storedToken = token; received.push("save-token"); },
    saveSelectServer: () => received.push("save-selected"),
    markConnectionLost: () => received.push("mark-lost"),
    lastConnectedServer: () => server
  };
  const outputs = [];
  const mockedProtocol = {
    ConnTypeIds: { CONNT_DEBUGGER: 1 },
    ENABLE_CODE_PAGE: { CP1252: "CP1252", CP1251: "CP1251" },
    sendConnectRequest: () => { received.push("connect-rpc"); return Promise.resolve({}); },
    sendDisconnectRequest: () => { received.push("disconnect-rpc"); return Promise.resolve({}); },
    sendAuthenticateRequest: () => { received.push("auth-rpc"); return Promise.resolve({}); }
  };
  const mockedRecovery = {
    RecoveryFailure: class RecoveryFailure extends Error {},
    recoveryDiagnostic: (...args) => outputs.push(args.join("|")),
    recoveryMessage: e => e.message,
    requestSessionRecovery: () => {
      received.push("reconnect-rpc");
      if (rejected) return Promise.reject(new Error("Token rejected"));
      return Promise.resolve({ sucess: true, token: "AUTHENTICATED", user: "demo" });
    }
  };
  const mockedServerProvider = { connectedServerItem: undefined, localServerItems: [] };
  const module = load("src/serversView.ts", {
    "vscode": vscode,
    "fs": {}, "path": {},
    "./utils": { ServersConfig: config, default: {} },
    "./inputConnectionParameters": { inputConnectionParameters: () => Promise.resolve() },
    "./inputAuthenticationParameters": { inputAuthenticationParameters: () => Promise.resolve() },
    "vscode-languageclient": { ResponseError: class ResponseError extends Error {} },
    "./serverItemProvider": { default: mockedServerProvider },
    "./protocolMessages": mockedProtocol,
    "./serverItem": { EnvSection: class {}, ServerItem: class {} },
    "./server/connectionWatchdog": { ConnectionWatchdog: class {} },
    "./server/connectionPresentation": {
      connectionPresentation: {
        setReconnecting: () => {}, setDisconnected: () => {}, clear: () => {}, active: () => undefined,
        forEnvironment: () => visualRecovery ? {phase: "disconnected"} : undefined
      }
    },
    "./server/sessionRecovery": mockedRecovery,
    "./utilities/processSelectResource": { processSelectResourceMessage: () => true },
    "template-literal": () => () => ""
  });
  await module.reconnectServer(server, "DEV", 1);
  assert.equal(server.token, "AUTHENTICATED", "live server must receive authenticated token");
  assert.equal(storedToken, "AUTHENTICATED", "saved token must be refreshed");
  assert.deepEqual(received.slice(0, 3), ["reconnect-rpc", "save-token", "save-selected"]);
  assert.ok(!received.includes("connect-rpc"));

  storedToken = "OLD_TOKEN";
  rejected = true;
  received.length = 0;
  await module.reconnectServer(server, "DEV", 1);
  assert.deepEqual(received, ["reconnect-rpc", "mark-lost"],
    "failed reconnect cannot fall back to connect or clear token, and must invalidate the stale UI session");
  assert.equal(storedToken, "OLD_TOKEN");
  assert.ok(vscode.warnings.length >= 1);

  rejected = false;
  mockedRecovery.requestSessionRecovery = () => {
    received.push("reconnect-rpc");
    return new Promise(resolve => { resolveRecovery = resolve; });
  };
  const pending = module.reconnectServer(server, "DEV", 1);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  module.invalidateConnectionAttempts();
  resolveRecovery({ sucess: true, token: "LATE", user: "demo" });
  await pending;
  assert.equal(server.token, "AUTHENTICATED", "a late canceled response must not overwrite session");
  assert.equal(storedToken, "OLD_TOKEN", "a late canceled response must not be saved");

  // An explicit Connect must still work when the cache says connected but
  // the UI has detected a lost/recovering session.
  received.length = 0;
  visualRecovery = true;
  mockedProtocol.sendConnectRequest = () => {
    received.push("connect-rpc");
    return Promise.resolve({sucess:true, token:"FRESH", needAuthentication:false});
  };
  await module.connectServer(server, "DEV", 1);
  assert.ok(received.includes("mark-lost"), "retire the stale active session");
  assert.ok(received.includes("connect-rpc"), "explicit Connect cannot claim stale session is connected");
  assert.equal(storedToken, "FRESH");
  console.log("PASS serversView: token propagation, no credential fallback, stale response, explicit Connect during recovery");
}

function testInputDispatch() {
  const file = fs.readFileSync(path.join(root, "src/inputConnectionParameters.ts"), "utf8");
  assert.match(file, /if \(reconnect && !\(allowSelectFallback && !connectState\.reconnectionToken\)\)/);
  assert.match(file, /inputConnectionParameters\(context, args\[0\], ConnTypeIds\.CONNT_DEBUGGER, true, true\)/);
  console.log("PASS inputConnectionParameters: explicit reconnect and independent server-selection fallback");
}


async function testWatchdogRuntime() {
  const vscode = fakeVscode();
  const trace = [], output = [];
  const session = { id: "S", name: "SERVER", environment: "DEV", token: "SECRET_SESSION" };
  const cfg = { "connection.autoReconnect": false, "connection.heartbeatInterval": 30 };
  vscode.workspace.getConfiguration = () => ({
    get: (name, def) => Object.prototype.hasOwnProperty.call(cfg, name) ? cfg[name] : def
  });
  const mockConfig = {
    getCurrentServer: () => session,
    getServerById: () => session,
    onDidSelectedServer: () => ({ dispose() {} }),
    markConnectionLost: () => trace.push("mark-lost")
  };
  const client = {
    isReady: true,
    outputChannel: { appendLine: s => output.push(s) },
    sendRequest: (method, payload, cancel) => {
      trace.push({method, payload, cancel});
      return Promise.resolve({ message: "OK" });
    }
  };
  let compilation = false;
  const watcher = load("src/server/connectionWatchdog.ts", {
    vscode,
    "../extension": { languageClient: client, isBuildOperationInProgress: () => compilation },
    "../utils": { __esModule: true, default: { isServerP20OrGreater: () => true }, ServersConfig: mockConfig },
    "../serversView": {
      isConnectionOperationInProgress: () => false,
      trySilentReconnectSession: () => { throw new Error("No reconnect expected on a successful probe."); }
    },
    "./connectionPresentation": {
      connectionPresentation: { setReconnecting: () => {}, setDisconnected: () => {}, clear: () => {}, forEnvironment: () => undefined }
    }
  });
  const monitor = new watcher.ConnectionWatchdog();
  assert.equal(monitor.session, undefined, "heartbeat must start disabled by default");
  cfg["connection.autoReconnect"] = true;
  monitor.refresh(true);
  assert.equal(monitor.session.token, "SECRET_SESSION");
  await monitor.probe(session);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].method, "$totvsserver/serverInformations");
  assert.equal(trace[0].payload.serverInformationsInfo.connectionToken, "SECRET_SESSION");
  assert.ok(trace[0].cancel, "probe must be cancellable");
  compilation = true;
  assert.equal(monitor.shouldPause(), true, "compile must suspend the heartbeat");
  await monitor.check();
  assert.equal(trace.length, 1, "no probe during compile");
  monitor.dispose();
  assert.deepEqual(trace.filter(x => x === "mark-lost"), []);
  assert.ok(output.every(s => !s.includes("SECRET_SESSION")));
  console.log("PASS connectionWatchdog runtime: disabled by default, read-only probe, compiler pause, no token logging");
}

function testWatchdogDefaults() {
  const file = fs.readFileSync(path.join(root, "src/server/connectionWatchdog.ts"), "utf8");
  assert.match(file, /"connection\.autoReconnect", false/);
  assert.match(file, /const FAILURE_THRESHOLD = 2/);
  assert.match(file, /const RETRY_DELAYS_MS = \[3000, 10000, 30000\]/);
  assert.match(file, /!languageClient\?\.isReady \|\| isBuildOperationInProgress\(\)/);
  assert.match(file, /isConnectionOperationInProgress\(\)/);
  assert.doesNotMatch(file, /sendConnectRequest|sendAuthenticateRequest|doConnect\(/);
  console.log("PASS connectionWatchdog: disabled by default, two probes, bounded retries, no credential flow");
}

(async function main() {
  await testProtocol();
  await testManualConnection();
  testInputDispatch();
  testWatchdogDefaults();
  await testWatchdogRuntime();
  console.log("All experimental reconnect tests passed.");
})().catch(err => { console.error(err); process.exitCode = 1; });
