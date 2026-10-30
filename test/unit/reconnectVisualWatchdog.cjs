"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");

function load(relativePath, mocks) {
  const file = path.join(root, relativePath);
  const result = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2016,esModuleInterop:true}
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${relativePath} syntax errors: ${errors.map(x => x.messageText)}`);
  const mod = {exports:{}};
  const requireMock = id => {
    if (!Object.prototype.hasOwnProperty.call(mocks,id)) throw Error("Unknown dependency: " + id);
    return mocks[id];
  };
  new Function("require", "module", "exports", result.outputText)(requireMock,mod,mod.exports);
  return mod.exports;
}

function fakeVscode() {
  class EventEmitter {
    constructor() {
      this.listeners=[];
      this.event=fn => {this.listeners.push(fn);return {dispose(){}};};
    }
    fire(){for(const fn of this.listeners)fn();}
    dispose(){this.listeners=[];}
  }
  class CancellationTokenSource {
    constructor(){this.token={};}
    cancel(){}
    dispose(){}
  }
  return {
    EventEmitter,CancellationTokenSource,
    debug:{activeDebugSession:undefined,onDidTerminateDebugSession:()=>({dispose(){}})},
    workspace:{
      getConfiguration:()=>({get:(key,def)=>key==="connection.autoReconnect"?true:def}),
      onDidChangeConfiguration:()=>({dispose(){}})
    },
    window:{showWarningMessage:()=>Promise.resolve()}
  };
}

async function testFailureStates() {
  const vscode=fakeVscode();
  const presentation=load("src/server/connectionPresentation.ts",{vscode}).connectionPresentation;
  let selected={id:"S",name:"CAASP",environment:"CZA3BD_PAULO",token:"OLD",buildVersion:"7.00.240102P"};
  let statusEvents=0;
  presentation.onDidChange(()=>statusEvents++);
  const selectedListeners=[];
  const trace=[];
  const config={
    getCurrentServer:()=>selected,
    getServerById:()=>selected,
    onDidSelectedServer:fn=>{selectedListeners.push(fn);return{dispose(){}};},
    markConnectionLost:token=>{
      assert.equal(token,"OLD", "Cannot invalidate a newer session");
      trace.push("markLost");
      selected=undefined;
      for(const fn of selectedListeners)fn(undefined);
    }
  };
  const client={
    isReady:true,outputChannel:{appendLine:line=>trace.push(line)},
    sendRequest:()=>Promise.reject(new Error("Debugger gone"))
  };
  let tries=0;
  const Watchdog=load("src/server/connectionWatchdog.ts",{
    vscode,
    "../extension":{languageClient:client,isBuildOperationInProgress:()=>false},
    "../utils":{__esModule:true,default:{isServerP20OrGreater:()=>true},ServersConfig:config},
    "../serversView":{
      isConnectionOperationInProgress:()=>false,
      trySilentReconnectSession:async()=>{
        tries++;
        const state=presentation.forEnvironment("S","CZA3BD_PAULO");
        assert.equal(state.phase,"reconnecting");
        assert.equal(state.attempt,1);
        assert.equal(state.maxAttempts,3);
        return "rejected";
      }
    },
    "./connectionPresentation":{connectionPresentation:presentation}
  }).ConnectionWatchdog;
  const monitor=new Watchdog();
  monitor.clearScheduled();
  monitor.schedule=()=>{};
  monitor.wait=async()=>true;
  await monitor.check();
  assert.equal(monitor.failures,1);
  assert.equal(presentation.forEnvironment("S","CZA3BD_PAULO").phase,"verifying");
  assert.equal(tries,0);
  await monitor.check();
  assert.equal(tries,1, "Rejected token must stop the retry cycle");
  assert.equal(presentation.forEnvironment("S","CZA3BD_PAULO").phase,"disconnected");
  assert.equal(selected,undefined);
  assert.ok(trace.includes("markLost"));
  assert.ok(statusEvents>=3, "Verify -> reconnect -> offline must repaint the tree");
  monitor.dispose();
  presentation.dispose();
  console.log("PASS automatic watchdog: first failure shows checking, second shows spinner, rejection leaves offline icon");
}

async function testRecoverySuccess() {
  const vscode=fakeVscode();
  const presentation=load("src/server/connectionPresentation.ts",{vscode}).connectionPresentation;
  let selected={id:"S",name:"CAASP",environment:"DEV",token:"OLD",buildVersion:"7.00.240102P"};
  const listeners=[];
  let shouldFail=true, lost=false;
  const config={
    getCurrentServer:()=>selected,
    getServerById:()=>selected,
    onDidSelectedServer:fn=>{listeners.push(fn);return{dispose(){}};},
    markConnectionLost:()=>{lost=true;}
  };
  const client={
    isReady:true,outputChannel:{appendLine:()=>{}},
    sendRequest:()=>shouldFail?Promise.reject(Error("lost")):Promise.resolve({message:"OK"})
  };
  let tries=0;
  const Watchdog=load("src/server/connectionWatchdog.ts",{
    vscode,
    "../extension":{languageClient:client,isBuildOperationInProgress:()=>false},
    "../utils":{__esModule:true,default:{isServerP20OrGreater:()=>true},ServersConfig:config},
    "../serversView":{
      isConnectionOperationInProgress:()=>false,
      trySilentReconnectSession:async()=>{
        tries++;
        assert.equal(presentation.forEnvironment("S","DEV").phase,"reconnecting");
        selected={...selected,token:"NEW"};
        presentation.clear("S","DEV");
        listeners.forEach(fn=>fn(selected));
        return "restored";
      }
    },
    "./connectionPresentation":{connectionPresentation:presentation}
  }).ConnectionWatchdog;
  const monitor=new Watchdog();
  monitor.clearScheduled();
  monitor.schedule=()=>{};
  monitor.wait=async()=>true;
  await monitor.check();
  await monitor.check();
  assert.equal(tries,1);
  assert.equal(presentation.forServer("S"),undefined,"Successful recovery must restore the normal green icon");
  assert.equal(selected.token,"NEW");
  assert.equal(lost,false);
  monitor.dispose();
  presentation.dispose();
  console.log("PASS automatic watchdog: successful reconnect clears spinner without losing session");
}

(async()=>{await testFailureStates();await testRecoverySuccess();})().catch(e=>{console.error(e);process.exitCode=1;});
