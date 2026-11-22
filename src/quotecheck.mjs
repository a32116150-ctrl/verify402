// Public client for the paid route and quote-audit engines.
//
// The venue book and fairness arithmetic live only in the private
// verify402-engine service. `parseRawPositive` stays here because the HTTP
// layer uses it for request validation before any paid work is done.

import { callPaidEngine } from "./paid-engine.mjs";

const MAX_UINT256 = (1n << 256n) - 1n;

export function parseRawPositive(value, label) {
  let n;
  if (typeof value === "bigint") {
    n = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive safe integer or a decimal string`);
    }
    n = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    n = BigInt(value.trim());
  } else {
    throw new Error(`${label} must be a positive integer in raw units`);
  }
  if (n <= 0n) throw new Error(`${label} must be positive`);
  if (n > MAX_UINT256) throw new Error(`${label} must fit in uint256 (<= 2^256-1)`);
  return n;
}

export async function bestRouteBook(client, chainId, opts = {}) {
  // The client argument is kept for API compatibility; the private service
  // owns its own RPC client.
  return callPaidEngine("route", chainId, opts);
}

export async function fairQuoteCheck(chainId, opts = {}) {
  return callPaidEngine("quotecheck", chainId, opts);
}
