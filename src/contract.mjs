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
  assure: "$0.19",
});

export const PREFLIGHT_RATE_PER_MIN = 60;
// Anonymous free-gate calls are capped per IP per UTC day. The cap is a cost
// control, not a security boundary; a determined caller can rotate IPs.
export const FREE_GATE_DAILY_LIMIT = Number(process.env.FREE_GATE_DAILY_LIMIT || 100);
// Optional operator-issued free keys get a higher daily cap. Keys are supplied
// through FREE_API_KEYS and presented as X-Verify402-Key; this is not an
// account system and keys are not issued by the service itself.
export const FREE_API_KEY_DAILY_LIMIT = Number(process.env.FREE_API_KEY_DAILY_LIMIT || 1000);
// The inspector performs one outbound fetch per call, so its default budget is
// smaller than the purely local preflight gate.
export const INSPECT_RATE_PER_MIN = 20;
// /findings is a free chain read. It is cached for 30s, but without a per-IP
// budget a single caller can keep the cache permanently cold and turn a free
// endpoint into a public RPC proxy (AUDIT L-3).
export const FINDINGS_RATE_PER_MIN = 30;
export const PREFLIGHT_MAX_IN_FLIGHT = 8;
export const SHUTDOWN_TIMEOUT_MS_DEFAULT = 10000;

export const HEALTH_OK_KEYS = Object.freeze([
  "ok",
  "mode",
  "price",
  "preflight",
  "networks",
  "ready",
  "recoveryStore",
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
const hp = "honeypot";
const ev = "every";
const ve = "venue";
const sp = "sell probe";
const dk = "double";
const ky = "keying";
const ch = "content-hash";
const ck = "companion key";
const sm = "scope";
const mm = "mismatch";
const sh = "shared between the caller";
const dp = "different" + " " + "payer";

export const BANNED_PUBLIC_CLAIMS = Object.freeze([
  new RegExp(hp + " " + "test", "i"),
  new RegExp(hp + " " + "probe", "i"),
  new RegExp(ev + " " + ve + "\\b", "i"),
  new RegExp(sp + " across " + ev + " " + ve, "i"),
  new RegExp(dk + "-" + ky, "i"),
  new RegExp(ch + " " + ck, "i"),
  new RegExp(sm + "_" + mm, "i"),
  new RegExp(sh + " key", "i"),
  new RegExp(dp, "i"),
  // The board samples the first page of the catalog; the old copy claimed a
  // ranking the scan never computed.
  new RegExp("most" + "-" + "called", "i"),
]);

export function bannedClaimHits(text) {
  const value = String(text ?? "");
  return BANNED_PUBLIC_CLAIMS.filter((re) => re.test(value)).map((re) => re.source);
}
