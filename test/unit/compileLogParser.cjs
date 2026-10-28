"use strict";
const assert = require("node:assert/strict");
const { parseCompileLogError } = require("../../out/compile/compileLogParser.js");

const fatal = parseCompileLogError(
  "[Error - 6:37:22 PM] [FATAL] Aborting: CASCCLI.PRW(696)");
assert.ok(fatal, "The supplied fatal compiler log must be recognized");
assert.equal(fatal.file, "CASCCLI.PRW");
assert.equal(fatal.line, 696);
assert.match(fatal.title, /CASCCLI\.PRW.*696/);

assert.ok(parseCompileLogError(
  "[Error - 5:15:24 PM] Start build error: COMPILEERROR-300 Failed to open repository"));
assert.ok(parseCompileLogError(
  "[Info - 5:15:24 PM] [ERROR] Source ABC.PRW not compiled"));

assert.equal(parseCompileLogError("[Info - 6:37:22 PM] Start file recompile."), undefined);
assert.equal(parseCompileLogError("[Info - 6:37:22 PM] All files compiled successfully."), undefined);
assert.equal(parseCompileLogError("[Error - 6:37:22 PM] Invalid editor theme configuration"), undefined);
assert.equal(parseCompileLogError("Source ABC.PRW compiled with 0 errors"), undefined);
console.log("Compiler log parsing tests passed.");
