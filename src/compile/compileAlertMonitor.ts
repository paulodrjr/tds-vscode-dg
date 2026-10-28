import * as vscode from "vscode";
import { isNewLanguageServerLogEntry, parseCompileLogError } from "./compileLogParser";

interface PendingAlert {
  title: string;
  detail: string;
  fromLog: boolean;
}

interface CompileSession {
  id: number;
  alerted: boolean;
  finishedAt?: number;
  sourceFiles: string[];
  generatesPatch: boolean;
  pending?: PendingAlert;
  notificationTimer?: NodeJS.Timeout;
  expirationTimer?: NodeJS.Timeout;
}

let currentSession: CompileSession | undefined;

function clearSessionTimers(session: CompileSession): void {
  if (session.notificationTimer) clearTimeout(session.notificationTimer);
  if (session.expirationTimer) clearTimeout(session.expirationTimer);
}

export function beginCompilationAlerts(id: number): void {
  if (currentSession) clearSessionTimers(currentSession);
  currentSession = { id, alerted: false, sourceFiles: [], generatesPatch: false };
}

export function setCompilationAlertSources(
  id: number, sourceFiles: string[], generatesPatch = false
): void {
  if (currentSession?.id !== id) return;
  currentSession.sourceFiles = [...sourceFiles];
  currentSession.generatesPatch = generatesPatch;
}

export function resetCompilationAlerts(): void {
  if (currentSession) clearSessionTimers(currentSession);
  currentSession = undefined;
}

function showPendingAlert(session: CompileSession): void {
  if (currentSession !== session || session.alerted || !session.pending) return;
  session.alerted = true;
  const alert = session.pending;
  session.pending = undefined;
  session.notificationTimer = undefined;

  const title = session.generatesPatch
    ? alert.title + " — patch não gerado"
    : alert.title;
  void vscode.window.showErrorMessage(
    title,
    { modal: true, detail: alert.detail },
    "Abrir saída TOTVS",
    "Ver problemas"
  ).then(action => {
    if (action === "Abrir saída TOTVS") {
      monitoredOutputChannel?.show();
    } else if (action === "Ver problemas") {
      void vscode.commands.executeCommand("workbench.action.problems.focus");
    }
  });
}

function scheduleAlert(session: CompileSession): void {
  if (session.notificationTimer || session.alerted) return;
  // The LS may send [FATAL] and the subsequent compiler message on
  // separate lines. Briefly collect those lines before showing the dialog.
  session.notificationTimer = setTimeout(() => showPendingAlert(session), 180);
}

export function reportCompilationFailure(
  id: number, title: string, detail: string
): void {
  const session = currentSession;
  if (!session || session.id !== id || session.alerted) {
    // When there is no active session the caller can show its own error,
    // but never duplicate a message from an invalidated compilation.
    return;
  }
  if (!session.pending) {
    session.pending = { title, detail, fromLog: false };
  } else if (!session.pending.fromLog && detail && !session.pending.detail.includes(detail)) {
    session.pending.detail += "\n" + detail;
  }
  scheduleAlert(session);
}

function observeOutputLine(line: string): void {
  const session = currentSession;
  if (!session || session.alerted) return;
  if (session.finishedAt !== undefined &&
      Date.now() - session.finishedAt > 2000) return;

  const finding = parseCompileLogError(line);
  if (finding) {
    // Do not show diagnostics from a different source if both LSP indexing
    // and compilation are generating messages at the same time.
    if (finding.file && session.sourceFiles.length > 0) {
      const requested = session.sourceFiles.some(file =>
        file.replace(/\\/g, "/").toLowerCase().endsWith("/" + finding.file!.toLowerCase()));
      if (!requested) return;
    }
    session.pending = { title: finding.title, detail: finding.detail, fromLog: true };
    scheduleAlert(session);
  } else if (session.pending?.fromLog && line.trim() &&
      !isNewLanguageServerLogEntry(line) &&
      session.pending.detail.split("\n").length < 6) {
    session.pending.detail += "\n" + line.trim().slice(0, 500);
  }
}

export function finishCompilationAlerts(id: number): void {
  const session = currentSession;
  if (!session || session.id !== id) return;
  session.finishedAt = Date.now();
  if (session.expirationTimer) clearTimeout(session.expirationTimer);
  // Permit late LS notifications following a resolved compilation request.
  session.expirationTimer = setTimeout(() => {
    if (currentSession === session) {
      clearSessionTimers(session);
      currentSession = undefined;
    }
  }, 2500);
}

let monitoredOutputChannel: vscode.OutputChannel | undefined;

/**
 * The VS Code Output panel has no read API. Supply this forwarding channel to
 * LanguageClientOptions.outputChannel so ordinary LSP log messages are seen
 * as they are written, without losing the original TOTVS LS output.
 */
export class CompilerObservedOutputChannel implements vscode.OutputChannel {
  readonly name: string;
  private partialLine = "";

  constructor(private readonly actual: vscode.OutputChannel) {
    this.name = actual.name;
    monitoredOutputChannel = this;
  }

  private observe(value: string): void {
    const text = this.partialLine + value;
    const lines = text.split(/\r?\n/);
    this.partialLine = (lines.pop() || "").slice(-4000);
    for (const line of lines) observeOutputLine(line);
  }

  // Arrow functions preserve their receiver when extension code extracts
  // outputChannel.appendLine into an unbound local variable.
  append = (value: string): void => {
    this.observe(value);
    this.actual.append(value);
  };

  appendLine = (value: string): void => {
    this.observe(value + "\n");
    this.actual.appendLine(value);
  };

  replace = (value: string): void => {
    this.partialLine = "";
    this.observe(value + "\n");
    this.actual.replace(value);
  };

  clear = (): void => {
    this.partialLine = "";
    this.actual.clear();
  };

  show(preserveFocus?: boolean): void;
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(columnOrPreserveFocus?: boolean | vscode.ViewColumn, preserveFocus?: boolean): void {
    if (typeof columnOrPreserveFocus === "number") {
      this.actual.show(columnOrPreserveFocus, preserveFocus);
    } else {
      this.actual.show(columnOrPreserveFocus);
    }
  }

  hide = (): void => this.actual.hide();

  dispose = (): void => {
    if (monitoredOutputChannel === this) monitoredOutputChannel = undefined;
    this.actual.dispose();
  };
}
