"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");

const dialogs = [];
const fakeVscode = {
  window: {
    showErrorMessage: (title, options, ...actions) => {
      dialogs.push({ title, options, actions });
      return Promise.resolve(undefined);
    },
  },
  commands: { executeCommand: () => Promise.resolve() }
};

const originalLoad = Module._load;
let alerts;
try {
  Module._load = function(request, parent, isMain) {
    if (request === "vscode") return fakeVscode;
    return originalLoad.apply(this, arguments);
  };
  alerts = require("../../out/compile/compileAlertMonitor.js");
} finally {
  Module._load = originalLoad;
}

const output = {
  name: "TOTVS LS", append: () => {}, appendLine: () => {},
  replace: () => {}, clear: () => {}, show: () => {},
  hide: () => {}, dispose: () => {}
};
const listener = new alerts.CompilerObservedOutputChannel(output);
const sleep = millis => new Promise(resolve => setTimeout(resolve, millis));

async function run() {
  // A successful compilation must not show a dialog.
  alerts.beginCompilationAlerts(101);
  alerts.setCompilationAlertSources(101, ["C:\\DEV\\CASCCLI.PRW"]);
  listener.appendLine("[Info - 6:37:22 PM] Start file recompile.");
  listener.appendLine("[Info - 6:37:22 PM] All files compiled successfully.");
  await sleep(220);
  assert.equal(dialogs.length, 0, "successful builds should be silent");

  // The exact failure reported by the user comes through the Output channel,
  // not necessarily via CompileResult.compileInfos.
  alerts.beginCompilationAlerts(102);
  alerts.setCompilationAlertSources(102, ["C:\\DEV\\CASCCLI.PRW"]);
  listener.appendLine("[Error - 6:37:22 PM] [FATAL] Aborting: CASCCLI.PRW(696)");
  listener.appendLine("unsupported assign to constant at line 696");
  await sleep(230);
  assert.equal(dialogs.length, 1, "a fatal compiler log must open one modal");
  assert.match(dialogs[0].title, /CASCCLI\.PRW.*696/);
  assert.equal(dialogs[0].options.modal, true);
  assert.match(dialogs[0].options.detail, /unsupported assign to constant at line 696/);
  assert.deepEqual(dialogs[0].actions, ["Abrir saída TOTVS", "Ver problemas"]);

  // A second result/error event from the same build cannot create another modal.
  alerts.reportCompilationFailure(102, "Falha na compilação", "C2090");
  await sleep(220);
  assert.equal(dialogs.length, 1, "only one alert per compilation");

  // Both append() and appendLine() may be used by the LSP.
  alerts.beginCompilationAlerts(103);
  alerts.setCompilationAlertSources(103, ["C:\\DEV\\OUTRO.PRW"]);
  listener.append("[Error - 6:37:22 PM] [FAT");
  listener.appendLine("AL] Aborting: OUTRO.PRW(21)");
  await sleep(230);
  assert.equal(dialogs.length, 2, "fragmented output must also be detected");

  // Ignore an unrelated Language Server error during compilation.
  alerts.beginCompilationAlerts(104);
  alerts.setCompilationAlertSources(104, ["C:\\DEV\\OUTRO.PRW"]);
  listener.appendLine("[Error - 6:37:22 PM] Invalid editor theme configuration");
  await sleep(230);
  assert.equal(dialogs.length, 2, "unrelated Language Server errors must be ignored");

  // After the request resolves, a late compiler notification is still caught.
  alerts.beginCompilationAlerts(105);
  alerts.setCompilationAlertSources(105, ["C:\\DEV\\LATE.PRW"]);
  alerts.finishCompilationAlerts(105);
  listener.appendLine("[Error - 6:37:22 PM] [FATAL] Aborting: LATE.PRW(77)");
  await sleep(230);
  assert.equal(dialogs.length, 3, "late fatal messages must still show a modal");

  alerts.resetCompilationAlerts();
  listener.dispose();
  console.log("Compiler OutputChannel modal alert tests passed.");
}
run().catch(error => {
  alerts.resetCompilationAlerts();
  console.error(error);
  process.exitCode = 1;
});
