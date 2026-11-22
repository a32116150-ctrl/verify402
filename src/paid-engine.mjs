// Shared client-side guard for the five paid checks.
//
// The public package contains no paid implementation. Every paid call is sent
// to the private service over the token-gated internal endpoint. When that
// service is not configured we fail closed: a hard, transport-shaped result if
// the chain cannot be read (so the HTTP route returns 503 with no verdict), or
// a typed refusal if it can. There is deliberately no local fallback.

import { requirePaidLicense } from "./license.mjs";
import { remoteEngine } from "./engine-client.mjs";
import { clientFor, classifyQuoteError } from "./measure.mjs";

export async function callPaidEngine(name, chainId, opts = {}) {
  requirePaidLicense(name);
  const remote = await remoteEngine(name, chainId, opts);
  if (remote !== null) return remote;

  try {
    const client = typeof opts.clientFactory === "function"
      ? opts.clientFactory(chainId)
      : clientFor(chainId);
    await client.getBlockNumber();
  } catch (error) {
    const classified = classifyQuoteError(error);
    return {
      ok: false,
      kind: classified.kind,
      reason: classified.reason ?? null,
      detail: classified.detail ?? null,
      quote_status: "failed",
      unavailable_reason: classified.kind,
      _detail: error,
    };
  }

  const error = new Error(`private paid-engine service is not configured for ${name}`);
  error.code = "engine_service_unavailable";
  throw error;
}
