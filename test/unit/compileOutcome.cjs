"use strict";
const assert = require("node:assert/strict");
const { getCompilationOutcome, formatCompilationFailure } =
  require("../../out/compile/compileOutcome.js");

function check(name, response, expectedFailure, expectedErrors, expectedWarnings) {
  const actual = getCompilationOutcome(response);
  assert.equal(actual.failed, expectedFailure, name + ": failure");
  assert.equal(actual.errors.length, expectedErrors, name + ": errors");
  assert.equal(actual.warnings.length, expectedWarnings, name + ": warnings");
}
const info = (status, message = "", detail = "") => ({
  status, message, detail, filePath: "C:\\src\\INTREPO.PRW",
});

check("successful build", { returnCode: 0, compileInfos: [info("SUCCESS")] }, false, 0, 0);
check("warning only", { returnCode: 0, compileInfos: [info("WARN", "Unused local")] }, false, 0, 1);
check("ERROR despite return code 0",
  { returnCode: 0, compileInfos: [info("ERROR", "C2090 File not found")] }, true, 1, 0);
check("fatal status", { returnCode: 0, compileInfos: [info("fatal")] }, true, 1, 0);
check("nonzero code without details", { returnCode: 500, compileInfos: [] }, true, 0, 0);
check("marked error in detail",
  { returnCode: 0, compileInfos: [info("INFO", "", "[ERROR] Compilation aborted")] }, true, 1, 0);
check("ordinary text not an error",
  { returnCode: 0, compileInfos: [info("INFO", "Compiled with 0 errors")] }, false, 0, 0);
check("missing response", undefined, true, 0, 0);
check("empty response", {}, true, 0, 0);

const failure = getCompilationOutcome({
  returnCode: 0, compileInfos: [info("ERROR", "C2090 File not found")]
});
const formatted = formatCompilationFailure(failure, ["C:\\src\\INTREPO.PRW"]);
assert.match(formatted, /INTREPO\.PRW/);
assert.match(formatted, /C2090/);
console.log("Compilation error detection tests passed.");
