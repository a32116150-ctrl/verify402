// Recovery + evidence bundle for verify402's paid routes.
//
// The failure mode an external agent (SameDayDesk, MoltJobs) described and we
// promised to fix: payment settles, the HTTP response is lost, and a retry
// would charge twice. This module implements the honest recovery contract:
//
//   * The caller sends `x-idempotency-key` (or `idempotency-key`) on the FIRST
//     call of an operation.
//   * If that key has a settled verdict on file — fresh within the TTL — a
//     replay returns the SAME verdict without requiring another payment.
//   * TTL is short (10 min), replays are capped (3), the store is small.
//   * The key is the caller's secret: anyone who presents it can replay the
//     verdict for free, so callers should not log it publicly. We bound the
//     free window tightly instead of pretending the web can do anything more
//     advanced without breaking the x402 paywall.
//
// Every paid response also carries a standard evidence bundle:
//   requestHash (sha256 of the canonical request), responseHash (sha256 of the
//   response body excluding evidence_bundle/recovery keys), pinned block, mode,
//   timestamps. Receivers can recompute and verify both hashes; the canonical
//   form is: JSON keys sorted recursively, no whitespace (see canonicalStable).

import { createHash } from "node:crypto";

export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;   // 10 minutes
export const IDEMPOTENCY_MAX_REPLAYS = 3;
export const IDEMPOTENCY_MAX_KEYS = 1000;
// After the replay window closes, the expired verdict is kept as a tombstone
// for this long. A retry within the tombstone window still re-measures (the
// paywall re-arms — anything else would be a free-measure loophole), but the
// new response carries a typed `recovery.remeasured` signal instead of
// silently pretending nothing happened. Feedback: prismdeadlines, Oct 2026.
export const IDEMPOTENCY_REMEASURE_MS = 6 * 60 * 60 * 1000;  // 6 hours

const settled = new Map();    // key -> { payload, responseHash, settledAt, replays }
const tombstones = new Map(); // key -> { responseHash, settledAt, expiredAt }

// Injectable clock for tests.
let nowFn = () => Date.now();
export function _setNow(fn) { nowFn = fn; }

// Canonical stringify: keys sorted recursively, no whitespace. The same
// function is documented (in README) as the way to recompute hashes, so it
// must stay plain and deterministic.
export function canonicalStable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStable).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStable(value[k])).join(",") + "}";
}

export function sha256Hex(str) {
  return createHash("sha256").update(str).digest("hex");
}

// sha256 over the canonical form of the request that produced the verdict.
export function requestHash(route, body) {
  return sha256Hex(canonicalStable({ route, body: body ?? {} }));
}

// Record a settled verdict for a key. Removes any tombstone for the same key
// (a fresh settlement re-opens the window). Records under BOTH keys when the
// caller supplied an id: the caller's key AND a hash-derived companion key
// (see note on double-keying below).
export function recordSettlement(key, payload, companionKey = null) {
  const core = { ...payload };
  delete core.evidence_bundle;
  delete core.recovery;
  delete core.elapsedMs;
  delete core.cache;
  const responseHash = sha256Hex(canonicalStable(core));
  for (const k of [key, companionKey]) {
    if (!k) continue;
    if (settled.size >= IDEMPOTENCY_MAX_KEYS) {
      // drop the oldest entry; the store is a cache, not a ledger
      settled.delete(settled.keys().next().value);
    }
    tombstones.delete(k);
    settled.set(k, { payload, responseHash, settledAt: nowFn(), replays: 0 });
  }
  return { responseHash };
}

// Look up a replayable verdict. Applies TTL, replay cap and companion-key
// fallback; expired keys move to the tombstone map instead of vanishing.
export function replayFor(key) {
  const entry = settled.get(key);
  if (!entry) return null;
  if (nowFn() - entry.settledAt > IDEMPOTENCY_TTL_MS) {
    settled.delete(key);
    if (settled.size + tombstones.size < 4000) {
      tombstones.set(key, { responseHash: entry.responseHash, settledAt: entry.settledAt, expiredAt: nowFn() });
    }
    return null;
  }
  if (entry.replays >= IDEMPOTENCY_MAX_REPLAYS) {
    settled.delete(key);
    return null;
  }
  entry.replays += 1;
  return { payload: entry.payload, responseHash: entry.responseHash, replays: entry.replays };
}

// Typed post-window signal: if this key has a tombstone (verdict existed,
// replay window expired) we give the caller what it lost — the response hash —
// so the next remeasure can be flagged instead of silent. Tombstones expire.
export function expiredRecoveryInfo(key) {
  const t = tombstones.get(key);
  if (!t) return null;
  if (nowFn() - t.expiredAt > IDEMPOTENCY_REMEASURE_MS) {
    tombstones.delete(key);
    return null;
  }
  return { previousResponseHash: t.responseHash, expiredAt: new Date(t.expiredAt).toISOString() };
}

// Standard evidence bundle on every paid response.
export function evidenceBundle({ route, body, pinnedBlock, payload }) {
  const core = { ...payload };
  delete core.evidence_bundle;
  delete core.recovery;
  return {
    spec: "verify402/evidence-bundle@1",
    route,
    requestHash: requestHash(route, body),
    responseHash: sha256Hex(canonicalStable(core)),
    pinnedBlock: pinnedBlock ?? null,
    mode: process.env.X402_MODE === "mainnet" ? "mainnet" : "testnet",
    createdAt: new Date().toISOString(),
    payment: { protocol: "x402", scheme: "exact", answerIn: "settlement response body" },
    recompute: "sha256 of sha256-canonical JSON (keys sorted, no whitespace) of the response body excluding evidence_bundle, recovery, cache, elapsedMs; requestHash covers { route, body }",
  };
}
