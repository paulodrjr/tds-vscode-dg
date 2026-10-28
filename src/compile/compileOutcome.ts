import { CompileInfo } from "./CompileInfo";
import { CompileResult } from "./CompileResult";

const FAILURE_STATUSES = new Set([
  "ERROR", "FATAL", "FAILED", "FAILURE", "FAIL", "ABORTED", "ABORT", "COMPILEERROR"
]);

// Only recognize explicitly marked errors, not ordinary text such as
// "0 errors" or source names containing the word "error".
const ERROR_LINE = /(?:^|\r?\n)\s*(?:\[\s*(?:ERROR|FATAL|FAILED|FAILURE)\s*[:\]\-]|(?:ERROR|FATAL|FAILED|FAILURE)\s*[:\-])/i;

export interface CompilationOutcome {
  failed: boolean;
  errors: CompileInfo[];
  warnings: CompileInfo[];
  returnCode?: number;
}

function hasError(info: CompileInfo): boolean {
  const status = String(info?.status || "").trim().toUpperCase();
  return FAILURE_STATUSES.has(status) ||
    ERROR_LINE.test(String(info?.message || "")) ||
    ERROR_LINE.test(String(info?.detail || ""));
}

export function getCompilationOutcome(
  response: CompileResult | undefined | null
): CompilationOutcome {
  if (!response) {
    return { failed: true, errors: [], warnings: [] };
  }

  const infos = Array.isArray(response.compileInfos) ? response.compileInfos : [];
  const errors = infos.filter(info => info && hasError(info));
  const warnings = infos.filter(info => info &&
    String(info.status || "").trim().toUpperCase() === "WARN");

  const rawCode: any = response.returnCode;
  const returnCode = rawCode === undefined || rawCode === null
    ? undefined : Number(rawCode);
  const unsuccessfulCode = returnCode !== undefined &&
    (!Number.isFinite(returnCode) || returnCode !== 0);
  const missingResult = returnCode === undefined && infos.length === 0;

  return {
    failed: errors.length > 0 || unsuccessfulCode || missingResult,
    errors,
    warnings,
    returnCode,
  };
}

function fileName(filePath: string): string {
  return String(filePath || "").split(/[\\/]/).pop() || "";
}

function primaryDiagnostic(info: CompileInfo): string {
  const message = String(info.message || "").trim();
  const detail = String(info.detail || "").trim();
  const lines = (message + "\n" + detail).split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean);
  const useful = lines.find(line => ERROR_LINE.test(line)) || lines[0] ||
    String(info.status || "Erro de compilação");
  return useful.length > 280 ? useful.slice(0, 277) + "..." : useful;
}

export function formatCompilationFailure(
  outcome: CompilationOutcome,
  sourcePaths: string[] = []
): string {
  const lines: string[] = [];
  if (outcome.errors.length) {
    lines.push(outcome.errors.length + " erro(s) detectado(s).");
    for (const info of outcome.errors.slice(0, 5)) {
      const file = fileName(info.filePath);
      lines.push((file ? file + ": " : "") + primaryDiagnostic(info));
    }
    if (outcome.errors.length > 5) {
      lines.push("Mais " + (outcome.errors.length - 5) + " erro(s).");
    }
  } else if (sourcePaths.length === 1) {
    lines.push("Fonte: " + fileName(sourcePaths[0]));
  } else if (sourcePaths.length > 1) {
    lines.push("Arquivos solicitados: " + sourcePaths.length);
  }

  if (outcome.returnCode !== undefined &&
      (!Number.isFinite(outcome.returnCode) || outcome.returnCode !== 0)) {
    lines.push("Código de retorno: " + outcome.returnCode);
  }

  lines.push("Consulte a saída TOTVS LS para obter o diagnóstico completo.");
  return lines.join("\n");
}
