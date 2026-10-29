/**
 * A previously saved AppServer connection token may have been invalidated by
 * a server restart or by the Language Server. Only token-specific errors are
 * eligible for a fresh connection/authentication fallback.
 */
export function isRejectedReconnectToken(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message : String((error as any)?.message || error || "");
  return /(?:connection|session)\s+token.{0,100}(?:was not informed|not informed|missing|empty|invalid|expired|not found|unknown|rejected|not valid|not provided)/i.test(message) ||
    /(?:invalid|expired|missing|unknown|rejected).{0,70}(?:connection|session)\s+token/i.test(message) ||
    /(?:token\s+de\s+conex[aã]o).{0,100}(?:n[aã]o informado|inv[aá]lido|expirad|ausente)/i.test(message);
}
