/**
 * Validate outgoing TOTVS RPC requests at one boundary. Previous guards in
 * individual helpers did not cover direct LanguageClient.sendRequest calls.
 *
 * No connection-token values are ever logged by this module.
 */
const WITHOUT_SESSION_TOKEN = new Set([
  "$totvsserver/connect",
  "$totvsserver/validation",
  "$totvsserver/telemetry",
]);

export interface TokenCheck {
  required: boolean;
  valid: boolean;
  operation: string;
}

/** Return a predictable diagnostic without exposing the credential itself. */
export function checkConnectionToken(method: string, params: any): TokenCheck {
  if (typeof method !== "string" ||
      (!method.startsWith("$totvsserver/") &&
       !method.startsWith("$totvsmonitor/")) ||
      WITHOUT_SESSION_TOKEN.has(method)) {
    return { required: false, valid: true, operation: method };
  }

  let token: unknown = params?.connectionToken;
  if (token === undefined && params && typeof params === "object") {
    // Protocol conventions: compilationInfo, serverInformationsInfo,
    // reconnectInfo, getUsersInfo, ... each carry connectionToken.
    for (const key of Object.keys(params)) {
      const payload = params[key];
      if (payload !== null && typeof payload === "object" &&
          Object.prototype.hasOwnProperty.call(payload, "connectionToken")) {
        token = (payload as any).connectionToken;
        break;
      }
    }
  }

  return {
    required: true,
    valid: typeof token === "string" && token.trim().length > 0,
    operation: method,
  };
}

export function describeMissingConnectionToken(method: string): string {
  return "Requisição TOTVS bloqueada: " + method +
    " tentou utilizar uma sessão sem token de conexão. " +
    "Conecte-se novamente ao AppServer ou verifique o ciclo de vida da rotina.";
}
