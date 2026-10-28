/**
 * Extract fatal compilation diagnostics emitted as plain Language Server logs.
 * Such messages are not guaranteed to be present in compilation.compileInfos.
 */
export interface CompileLogError {
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

const LOG_PREFIX = /^\s*\[(?:Info|Error|Warning|Warn|Log|Debug|Trace)\s*-\s*[^\]]+\]\s*/i;
const SOURCE_AND_LINE = /([\w.\-]+\.(?:prw|prg|prx|tlpp|ppx|ppp|4gl|per|apw|aph|apl|ahu))\s*\((\d+)\)/i;

export function isNewLanguageServerLogEntry(line: string): boolean {
  return LOG_PREFIX.test(line);
}

export function parseCompileLogError(line: string): CompileLogError | undefined {
  if (typeof line !== "string" || !line.trim()) return undefined;

  const body = line.replace(LOG_PREFIX, "").trim();
  const fatalMarker = /^\[(?:FATAL|ERROR|FAILED|FAILURE)\]\s*/i.test(body);
  const buildFailure = /^(?:Start build error|End build error|Compilation failed|Failed to compile|Error compiling|\[?COMPILEERROR-\d+)/i.test(body) ||
    /\bCOMPILEERROR-\d+\b/i.test(body);
  const sourceFailure = /^\[(?:Error|Fatal)\s*-\s*[^\]]+\]/i.test(line) &&
    /\b(?:Aborting|compil(?:ation|ing|e)|repository|RPO)\b/i.test(body);
  if (!fatalMarker && !buildFailure && !sourceFailure) return undefined;

  const matchedSource = body.match(SOURCE_AND_LINE);
  const file = matchedSource?.[1];
  const sourceLine = matchedSource ? Number(matchedSource[2]) : undefined;

  return {
    title: file
      ? "Falha na compilação: " + file + (sourceLine ? " (linha " + sourceLine + ")" : "")
      : "Falha na compilação",
    detail: line.trim(),
    file,
    line: sourceLine,
  };
}
