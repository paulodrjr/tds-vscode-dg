"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const patcher = path.join(__dirname, "../../registrar-configuracoes.cjs");
const expected = require("../../configuracoes-reconexao.json");
const fixture = {
  name: "tds-vscode",
  version: "2.0.14",
  contributes: {
    configuration: {
      type: "object",
      title: "TOTVS",
      properties: {
        "totvsLanguageServer.reconnectLastServer": { type: "boolean", default: true },
        "totvsLanguageServer.compilation.unresponsiveWarningSeconds": {
          type: "number", default: 600, description: "A value with } curly brackets in a quoted string"
        },
        "totvsLanguageServer.compilation.showErrorDialog": {
          type: "boolean", default: true,
          description: "compiler warnings still work"
        }
      }
    },
    commands: [{ command: "totvs-developer-studio.connect", title: "Connect" }]
  }
};

function run(root, option) {
  const result = spawnSync(process.execPath, [patcher, root, ...(option ? [option] : [])], {
    encoding: "utf8"
  });
  return { status: result.status, output: result.stdout + result.stderr };
}
function scenario(eol) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tds-reconnect-config-"));
  const repo = path.join(sandbox, "repo");
  fs.mkdirSync(repo);
  const source = JSON.stringify(fixture, null, 2).replace(/\n/g, eol) + eol;
  const file = path.join(repo, "package.json");
  fs.writeFileSync(file, source, "utf8");

  const before = fs.readFileSync(file, "utf8");
  const validation = run(repo, "--validate");
  assert.equal(validation.status, 0, validation.output);
  assert.equal(fs.readFileSync(file, "utf8"), before, "dry run cannot edit package.json");

  const first = run(repo);
  assert.equal(first.status, 0, first.output);
  const updated = fs.readFileSync(file, "utf8");
  const data = JSON.parse(updated);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(data.contributes.configuration.properties[key], value);
    assert.equal((updated.match(new RegExp('"' + key.replace(/\./g, '\\.') + '"', 'g')) || []).length, 1);
  }
  assert.ok(updated.includes("totvsLanguageServer.compilation.showErrorDialog"));
  assert.ok(updated.includes("A value with } curly brackets in a quoted string"));
  assert.deepEqual(data.contributes.commands, fixture.contributes.commands);
  assert.ok(updated.includes(eol), "preserve original newline convention");
  if (eol === "\r\n") assert.equal(updated.replace(/\r\n/g, "").includes("\n"), false);

  const check = run(repo, "--check");
  assert.equal(check.status, 0, check.output);
  const again = run(repo);
  assert.equal(again.status, 0, again.output);
  assert.equal(fs.readFileSync(file, "utf8"), updated, "second application is idempotent");

  // Accept compatible properties the user already entered manually in settings.
  data.contributes.configuration.properties["totvsLanguageServer.connection.heartbeatInterval"].type = "number";
  data.contributes.configuration.properties["totvsLanguageServer.connection.maxReconnectAttempts"].type = "number";
  data.contributes.configuration.properties["totvsLanguageServer.connection.heartbeatInterval"].description = "Custom description";
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const compatible = fs.readFileSync(file, "utf8");
  assert.equal(run(repo, "--check").status, 0, "VS Code number properties must be accepted");
  assert.equal(run(repo).status, 0, "Compatible manual settings must be preserved");
  assert.equal(fs.readFileSync(file, "utf8"), compatible, "Existing descriptions must be preserved");

  // Do not overwrite the user's local schema customization without review.
  data.contributes.configuration.properties["totvsLanguageServer.connection.autoReconnect"].default = true;
  const conflicting = JSON.stringify(data, null, 2);
  fs.writeFileSync(file, conflicting);
  const fail = run(repo);
  assert.notEqual(fail.status, 0, fail.output);
  assert.equal(fs.readFileSync(file, "utf8"), conflicting, "cannot mutate conflicting schemas");
  fs.rmSync(sandbox, { recursive: true, force: true });
}
scenario("\n");
scenario("\r\n");
console.log("PASS package registration: create, schema types and bounds, dry run, CRLF, idempotency, conflict rejection");
