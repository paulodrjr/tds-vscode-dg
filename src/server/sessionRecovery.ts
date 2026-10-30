import * as vscode from "vscode";
import { languageClient } from "../extension";
import { ServerItem } from "../serverItem";
import { ConnTypeIds, IReconnectInfo } from "../protocolMessages";

/** Failure categories are deliberately different from the Language Server's text. */
export type RecoveryFailureCode =
  | "NO_SAVED_TOKEN"
  | "LS_NOT_READY"
  | "TIMED_OUT"
  | "SERVER_REJECTED_TOKEN"
  | "EMPTY_REPLY_TOKEN"
  | "WRONG_ENVIRONMENT"
  | "RPC_ERROR";

export class RecoveryFailure extends Error {
  constructor(public readonly code: RecoveryFailureCode, message: string) {
    super(message);
    this.name = "RecoveryFailure";
  }
}

export const RECOVERY_TIMEOUT_MS = 18000;

/** Never include the token itself in the diagnostic channel, even on RPC errors. */
function redact(message: string, token?: string): string {
  let text = String(message || "");
  if (token) text = text.split(token).join("[TOKEN_REDACTED]");
  return text
    .replace(/(password|connectionToken|authorization|secret)\s*[=:]\s*[^,;\s]+/gi, "$1=[REDACTED]")
    .slice(0, 320);
}

export function recoveryDiagnostic(
  mode: "manual" | "automatic" | "startup",
  operation: string,
  state: string,
  token?: string,
  detail?: string
): void {
  const tokenStatus = token && token.trim() ? "present" : "absent";
  languageClient?.outputChannel?.appendLine(
    `[Session Recovery] mode=${mode}; method=$totvsserver/reconnect; ` +
    `state=${state}; token=${tokenStatus}; operation=${operation}` +
    (detail ? `; detail=${redact(detail, token)}` : "")
  );
}

export function recoveryMessage(error: unknown): string {
  if (!(error instanceof RecoveryFailure)) {
    return "O Language Server retornou um erro inesperado. Consulte TOTVS LS.";
  }
  switch (error.code) {
    case "NO_SAVED_TOKEN":
      return "Não existe token de sessão salvo para este servidor e ambiente.";
    case "LS_NOT_READY":
      return "O TOTVS Language Server não está pronto para receber requisições.";
    case "TIMED_OUT":
      return "O Language Server não respondeu dentro do limite estabelecido.";
    case "SERVER_REJECTED_TOKEN":
      return "O Language Server rejeitou a sessão salva, mesmo com token informado.";
    case "EMPTY_REPLY_TOKEN":
      return "A resposta de reconexão não continha um token autenticado.";
    case "WRONG_ENVIRONMENT":
      return "O servidor retornou um ambiente diferente do solicitado.";
    default:
      return "A requisição de reconexão falhou. Consulte os detalhes em TOTVS LS.";
  }
}

/**
 * Reuse the *official* $totvsserver/reconnect protocol, but use VS Code's
 * cancellation token to bound the request. A late reply cannot activate a
 * session: callers additionally compare the generation and session identity.
 */
export async function requestSessionRecovery(
  server: ServerItem,
  environment: string,
  token: string,
  connType: ConnTypeIds,
  mode: "manual" | "automatic" | "startup",
  timeoutMs = RECOVERY_TIMEOUT_MS
): Promise<IReconnectInfo> {
  if (typeof token !== "string" || !token.trim()) {
    recoveryDiagnostic(mode, "skip", "NO_SAVED_TOKEN");
    throw new RecoveryFailure("NO_SAVED_TOKEN", "No saved connection token.");
  }
  if (!languageClient?.isReady) {
    recoveryDiagnostic(mode, "skip", "LS_NOT_READY", token);
    throw new RecoveryFailure("LS_NOT_READY", "Language Server is not ready.");
  }

  const cancellation = new vscode.CancellationTokenSource();
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  recoveryDiagnostic(mode, "send", "STARTED", token);
  try {
    const reply = languageClient.sendRequest<any>(
      "$totvsserver/reconnect",
      { reconnectInfo: {
        connectionToken: token,
        serverName: server.name,
        connType
      } },
      cancellation.token
    );
    const result = await Promise.race([
      reply,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          cancellation.cancel();
          reject(new RecoveryFailure("TIMED_OUT", "Reconnect RPC timed out."));
        }, timeoutMs);
      })
    ]);

    if (!result || typeof result.connectionToken !== "string" ||
        !result.connectionToken.trim()) {
      throw new RecoveryFailure("EMPTY_REPLY_TOKEN", "Reconnect returned an empty session token.");
    }
    if (result.environment && result.environment !== environment) {
      throw new RecoveryFailure("WRONG_ENVIRONMENT", "Returned environment does not match requested environment.");
    }
    recoveryDiagnostic(mode, "receive", "SUCCESS", token);
    return {
      sucess: true,
      token: result.connectionToken,
      environment: result.environment || environment,
      user: result.user || ""
    };
  } catch (error) {
    let classified: RecoveryFailure;
    if (timedOut) {
      classified = new RecoveryFailure("TIMED_OUT", "Reconnect RPC timed out.");
    } else if (error instanceof RecoveryFailure) {
      classified = error;
    } else {
      const raw = error instanceof Error ? error.message : String(error);
      const rejected = /(?:connection|session)\s+token.{0,110}(?:not informed|was not informed|invalid|expired|rejected|not found|missing)/i.test(raw) ||
        /(?:invalid|expired|rejected|missing).{0,80}(?:connection|session)\s+token/i.test(raw);
      classified = new RecoveryFailure(rejected ? "SERVER_REJECTED_TOKEN" : "RPC_ERROR", redact(raw, token));
    }
    recoveryDiagnostic(mode, "receive", classified.code, token, classified.message);
    throw classified;
  } finally {
    if (timeout) clearTimeout(timeout);
    cancellation.dispose();
  }
}
