// Cross-surface discovery contract.
//
// Values in this module are shared by the runtime handlers, OpenAPI, the
// service manifest, and the discovery tests. Keep limits and response shapes
// here so a docs edit cannot silently disagree with the running service.

export const PRICE_DEFAULTS = Object.freeze({
  verify: "$0.05",
  safety: "$0.10",
  route: "$0.03",
  quotecheck: "$0.05",
  depth: "$0.05",
});

export const PREFLIGHT_RATE_PER_MIN = 60;
export const PREFLIGHT_MAX_IN_FLIGHT = 8;
export const SHUTDOWN_TIMEOUT_MS_DEFAULT = 10000;

export const HEALTH_OK_KEYS = Object.freeze([
  "ok",
  "mode",
  "price",
  "preflight",
  "networks",
  "ready",
]);

export const READY_OK_KEYS = Object.freeze([
  "ok",
  "ready",
  "mode",
  "chainId",
  "blockNumber",
  "latencyMs",
]);

export const READY_FAILURE_KEYS = Object.freeze([
  "ok",
  "error",
  "message",
  "requestId",
  "ready",
  "chainId",
  "latencyMs",
]);

// Claims removed under C-3 / C-1. The same list drives the file scan and the
// live /info, OpenAPI, manifest, and llms.txt assertions.
export const BANNED_PUBLIC_CLAIMS = Object.freeze([
  /honeypot test/i,
  /honeypot probe/i,
  /every venue\b/i,
  /sell probe across every venue/i,
  /double-keying/i,
  /content-hash companion key/i,
  /scope_mismatch/i,
  /shared between the caller key/i,
  /different payer/i,
]);

export function bannedClaimHits(text) {
  const value = String(text ?? "");
  return BANNED_PUBLIC_CLAIMS.filter((re) => re.test(value)).map((re) => re.source);
}
