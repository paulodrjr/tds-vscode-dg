"use strict";

/**
 * Registra as três configurações do watchdog em package.json, preservando
 * a formatação existente do manifesto da extensão.
 *
 * Uso:
 *   node registrar-configuracoes.cjs <repositorio> [--validate | --check]
 *
 * --validate: valida se as configurações podem ser aplicadas, sem alterar nada
 * --check: confirma que as três configurações já estão registradas
 * O modo padrão aplica a alteração e cria um backup fora do repositório.
 */
const fs = require("node:fs");
const path = require("node:path");

const repoArg = process.argv[2];
const option = process.argv[3];
if (!repoArg || (option && !["--validate", "--check"].includes(option))) {
  console.error("Uso: node registrar-configuracoes.cjs <repositorio> [--validate | --check]");
  process.exit(2);
}

const root = path.resolve(repoArg);
const packageFile = path.join(root, "package.json");
const settingsFile = path.join(__dirname, "configuracoes-reconexao.json");
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const original = fs.readFileSync(packageFile, "utf8");
const manifest = JSON.parse(original);
const configuration = manifest.contributes && manifest.contributes.configuration;
const props = configuration && configuration.properties;
if (!props || typeof props !== "object" || Array.isArray(props)) {
  throw new Error("package.json não tem contributes.configuration.properties como objeto.");
}

for (const [key, required] of Object.entries(settings)) {
  if (Object.prototype.hasOwnProperty.call(props, key)) {
    const current = props[key];
    // Manually registered properties can have a different description, and
    // VS Code accepts both "number" and "integer" for these settings.
    // Preserve valid user customizations instead of blocking the installer.
    const compatibleType = current.type === required.type ||
      (required.type === "integer" && current.type === "number");
    if (!compatibleType || current.default !== required.default ||
        (current.minimum !== undefined && current.minimum !== required.minimum) ||
        (current.maximum !== undefined && current.maximum !== required.maximum)) {
      throw new Error("A configuração " + key + " já existe com esquema incompatível. Não foi sobrescrita.");
    }
  }
}

const missing = Object.entries(settings).filter(([name]) =>
  !Object.prototype.hasOwnProperty.call(props, name));

if (option === "--check") {
  if (missing.length) {
    throw new Error("Configurações ainda não registradas: " + missing.map(v => v[0]).join(", "));
  }
  console.log("OK: três configurações reconhecíveis pelo VS Code já estão registradas.");
  process.exit(0);
}
if (!missing.length) {
  console.log("OK: as três configurações já estão registradas.");
  process.exit(0);
}

// Encontrar o objeto de propriedades dentro de contributes.configuration,
// sem alterar formatação, ordem ou qualquer outra configuração já existente.
function findObjectEnd(text, start) {
  let level = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "{") level++;
    if (ch === "}" && --level === 0) return i;
    // Avoid touching brackets, strings and curly braces inside descriptions.
  }
  throw new Error("Estrutura JSON malformada ao localizar o objeto de configurações.");
}

// Match the settings object structurally, using the unique namespace and
// validating that the parsed object is the expected contribution container.
const begin = original.indexOf('"configuration"');
if (begin < 0) throw new Error("contributes.configuration não encontrado no texto.");
const propsKey = original.indexOf('"properties"', begin);
if (propsKey < 0) throw new Error("contributes.configuration.properties não encontrado no texto.");
const colon = original.indexOf(":", propsKey + '"properties"'.length);
const open = original.indexOf("{", colon + 1);
if (open < 0 || original.slice(colon + 1, open).trim()) {
  throw new Error("Não foi possível localizar o início das propriedades.");
}
const close = findObjectEnd(original, open);
const body = original.slice(open + 1, close);
const trimmedBody = body.replace(/\s+$/, "");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const closeIndent = (original.slice(original.lastIndexOf("\n", close) + 1, close).match(/^[ \t]*/) || [""])[0];
const keyIndentMatch = [...trimmedBody.matchAll(/(?:^|\n)([ \t]*)"totvsLanguageServer\.[^"\n]+"[ \t]*:/g)].pop();
const keyIndent = keyIndentMatch ? keyIndentMatch[1] : closeIndent + "  ";
const newProperties = missing.map(([key, spec]) =>
  keyIndent + JSON.stringify(key) + ": " + JSON.stringify(spec, null, 2).replace(/\n/g, eol + keyIndent)
).join("," + eol);
const added = trimmedBody + (trimmedBody.trim() ? "," : "") + eol + newProperties + eol + closeIndent;
const modified = original.slice(0, open + 1) + added + original.slice(close);
const checked = JSON.parse(modified);
for (const [key, spec] of Object.entries(settings)) {
  for (const [attr, value] of Object.entries(spec)) {
    if (JSON.stringify(checked.contributes.configuration.properties[key][attr]) !== JSON.stringify(value)) {
      throw new Error("Validação após a modificação falhou: " + key + "." + attr);
    }
  }
}

if (option === "--validate") {
  console.log("OK: package.json válido; " + missing.length + " configurações podem ser registradas.");
  process.exit(0);
}

// Backup outside the checkout, avoiding accidental Git changes besides the manifest.
const parent = path.dirname(root);
const backupDir = path.join(parent,
  path.basename(root) + "-backup-config-reconexao-" +
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-"));
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(packageFile, path.join(backupDir, "package.json"));

// Atomic replacement, with a temporary file in the same directory.
const tempFile = path.join(root, ".package.json.reconexao-" + process.pid + ".tmp");
try {
  fs.writeFileSync(tempFile, modified, "utf8");
  fs.renameSync(tempFile, packageFile);
} finally {
  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
}
console.log("Registradas " + missing.length + " configurações em package.json.");
console.log("Backup original: " + path.join(backupDir, "package.json"));
console.log("Reempacote o VSIX e reinstale/recarregue a extensão para o VS Code reconhecer as configurações.");
