"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");

// Deterministic timers: test two missed heartbeats and 3/10/30-second retry
// spacing without making CI wait several minutes.
let now = 0;
let nextTimer = 0;
const timers = new Map();
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
global.setTimeout = (callback, ms, ...args) => {
  const id = ++nextTimer;
  timers.set(id, { due: now + Number(ms || 0), fn: () => callback(...args) });
  return id;
};
global.clearTimeout = id => timers.delete(id);

async function flush() {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}
async function advance(ms) {
  const target = now + ms;
  for (let count = 0; count < 100; count++) {
    const next = [...timers.entries()]
      .filter(([, task]) => task.due <= target)
      .sort((a, b) => a[1].due - b[1].due)[0];
    if (!next) break;
    now = next[1].due;
    timers.delete(next[0]);
    next[1].fn();
    await flush();
  }
  now = target;
  await flush();
}

const handlers = { selection: new Set(), configuration: new Set(), startDebug: new Set(), endDebug: new Set() };
function subscribe(name, callback) {
  handlers[name].add(callback);
  return { dispose: () => handlers[name].delete(callback) };
}
function fire(name, event) {
  for (const handler of [...handlers[name]]) handler(event);
}

const settings = {
  "connection.autoReconnect": true,
  "connection.heartbeatInterval": 60,
  "connection.maxReconnectAttempts": 3
};
const warnings = [];
const log = [];
let currentServer;
let buildsRunning = false;
let manualConnectionRunning = false;
let probeCount = 0;
let reconnectCount = 0;
let probeImpl = async () => {};
let reconnectImpl = async () => "restored";
let cancellations = 0;

const fakeVscode = {
  workspace: {
    getConfiguration: section => {
      assert.equal(section, "totvsLanguageServer");
      return { get: (name, fallback) => settings[name] === undefined ? fallback : settings[name] };
    },
    onDidChangeConfiguration: callback => subscribe("configuration", callback)
  },
  debug: {
    activeDebugSession: undefined,
    onDidStartDebugSession: callback => subscribe("startDebug", callback),
    onDidTerminateDebugSession: callback => subscribe("endDebug", callback)
  },
  window: {
    showWarningMessage: (message) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    }
  },
  commands: { executeCommand: () => Promise.resolve() }
};

const fakeServersConfig = {
  getCurrentServer: () => currentServer,
  onDidSelectedServer: callback => subscribe("selection", callback),
  markConnectionLost: token => {
    if (currentServer?.token === token) {
      currentServer = undefined;
      cancellations++;
      fire("selection");
    }
  }
};
const fakeExtension = {
  languageClient: {
    isReady: true,
    outputChannel: { appendLine: message => log.push(message) }
  },
  isBuildOperationInProgress: () => buildsRunning
};
const originalLoad = Module._load;
let monitorModule;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return fakeVscode;
    if (request === "../utils") return { ServersConfig: fakeServersConfig };
    if (request === "../extension") return fakeExtension;
    if (request === "./connectionHealth") return {
      CONNECTION_PROBE_TIMEOUT_MS: 12000,
      probeAppServerSession: async () => {
        probeCount++;
        return probeImpl();
      }
    };
    if (request === "../serversView") return {
      isConnectionOperationInProgress: () => manualConnectionRunning,
      trySilentReconnectSession: async (session, timeoutMs, mayCommit) => {
        reconnectCount++;
        assert.equal(timeoutMs, 12000);
        if (!mayCommit()) return "stale";
        return reconnectImpl();
      }
    };
    return originalLoad.apply(this, arguments);
  };
  monitorModule = require("../../out/server/connectionHeartbeat.js");
} finally {
  Module._load = originalLoad;
}

const { ConnectionHeartbeatMonitor } = monitorModule;
const newServer = (id = "A", token = id + "-token") => ({
  id, name: "Server " + id, environment: "PRODUCTION", token
});
let monitor;

function reset() {
  monitor?.dispose();
  monitor = undefined;
  now = 0;
  timers.clear();
  nextTimer = 0;
  warnings.length = 0;
  log.length = 0;
  currentServer = newServer();
  probeCount = 0;
  reconnectCount = 0;
  cancellations = 0;
  buildsRunning = false;
  manualConnectionRunning = false;
  fakeVscode.debug.activeDebugSession = undefined;
  fakeExtension.languageClient.isReady = true;
  settings["connection.autoReconnect"] = true;
  settings["connection.heartbeatInterval"] = 60;
  settings["connection.maxReconnectAttempts"] = 3;
  probeImpl = async () => {};
  reconnectImpl = async () => "restored";
}

async function main() {
  reset();
  monitor = new ConnectionHeartbeatMonitor();
  await advance(59999);
  assert.equal(probeCount, 0, "the first heartbeat must honor the interval");
  await advance(1);
  assert.equal(probeCount, 1);
  await advance(60000);
  assert.equal(probeCount, 2);
  assert.equal(reconnectCount, 0, "healthy sessions must not reconnect");

  reset();
  probeImpl = async () => { throw new Error("Network unavailable"); };
  monitor = new ConnectionHeartbeatMonitor();
  await advance(120000);
  assert.equal(probeCount, 2, "require two failed probes before recovery");
  assert.equal(reconnectCount, 0);
  await advance(2999);
  assert.equal(reconnectCount, 0, "first retry must wait three seconds");
  await advance(1);
  assert.equal(reconnectCount, 1);
  assert.equal(warnings.length, 0, "successful recovery should remain quiet");
  assert.equal(cancellations, 0, "successful recovery must preserve the connection");

  reset();
  probeImpl = async () => { throw new Error("AppServer did not answer"); };
  reconnectImpl = async () => { throw new Error("temporary failure"); };
  monitor = new ConnectionHeartbeatMonitor();
  await advance(120000);
  await advance(3000);
  assert.equal(reconnectCount, 1);
  await advance(10000);
  assert.equal(reconnectCount, 2);
  await advance(30000);
  assert.equal(reconnectCount, 3);
  assert.equal(cancellations, 1, "after exhausting 3 attempts mark the session disconnected");
  assert.equal(warnings.length, 1, "notify once after exhausting the retry budget");

  reset();
  buildsRunning = true;
  monitor = new ConnectionHeartbeatMonitor();
  await advance(120000);
  assert.equal(probeCount, 0, "no heartbeat while compiling");
  buildsRunning = false;
  await advance(60000);
  assert.equal(probeCount, 1, "resume checking after compilation");
  fakeVscode.debug.activeDebugSession = { id: "debug" };
  await advance(60000);
  assert.equal(probeCount, 1, "no heartbeat during debugging");

  reset();
  probeImpl = async () => { throw new Error("disconnected"); };
  monitor = new ConnectionHeartbeatMonitor();
  await advance(120000);
  currentServer = newServer("B");
  fire("selection");
  await advance(30000);
  assert.equal(reconnectCount, 0, "manual server selection must cancel old recovery");
  assert.equal(cancellations, 0, "must never clear a newly selected session");

  reset();
  probeImpl = async () => { throw new Error("expired"); };
  reconnectImpl = async () => "invalid-token";
  monitor = new ConnectionHeartbeatMonitor();
  await advance(123000);
  assert.equal(reconnectCount, 1, "invalid token should stop further attempts");
  assert.equal(warnings.length, 1, "request manual login once");
  assert.equal(cancellations, 1);

  reset();
  settings["connection.autoReconnect"] = false;
  monitor = new ConnectionHeartbeatMonitor();
  await advance(300000);
  assert.equal(probeCount, 0, "disabled configuration must suppress checks");
  settings["connection.autoReconnect"] = true;
  fire("configuration", { affectsConfiguration: key => key === "totvsLanguageServer.connection" });
  await advance(60000);
  assert.equal(probeCount, 1, "enabling should take effect without reload");

  reset();
  console.log("Heartbeat monitoring and reconnection policy tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  monitor?.dispose();
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
});
