// One paid operation = one idempotency key, reused on every retry.
//
// The key is a bearer credential (see README/recovery docs), so it is never
// logged or returned to the MCP client. The bridge only needs it to survive a
// lost response: the server returns the settled verdict with
// recovery.replayed=true instead of charging a second time.
//
// Retry rules:
//   * network/timeout/5xx-gateway failures: retry with the SAME key
//   * 402: never retry here (the x402 wrapper owns the payment handshake)
//   * 409: never retry (a conflicting body will not become valid)

import { randomUUID } from "node:crypto";

export const DEFAULT_RETRIES = 2;

const RETRYABLE_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ERR_NETWORK",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export function isRetryable(error) {
  const status = error?.response?.status;
  if (status != null) return RETRYABLE_STATUS.has(status);
  if (RETRYABLE_CODES.has(error?.code)) return true;
  // Axios tags transport failures as isAxiosError with no response. Anything
  // else (bad config, programmer error) is not retried.
  return error?.isAxiosError === true;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST a paid operation with one generated idempotency key.
 *
 * @param {{post: Function}} paidApi - x402-wrapped axios instance (or a fake)
 * @param {string} route
 * @param {object} body
 * @param {{idempotencyKey?: string, retries?: number, sleep?: Function}} options
 * @returns {Promise<object>} the final axios response
 */
export async function paidPost(paidApi, route, body, {
  idempotencyKey = randomUUID(),
  retries = DEFAULT_RETRIES,
  sleep = delay,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await paidApi.post(route, body, {
        headers: { "x-idempotency-key": idempotencyKey },
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === retries) throw error;
      // Keep the same key: a retry after a lost response must replay, not pay.
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}
