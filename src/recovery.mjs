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

const settled = new Map(); // key -> { payload, responseHash, settledAt, replays }

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

// Record a settled verdict for a key. Returns the responseHash of the payload
// (hash excludes evidence_bundle and recovery meta by design — those decorate
// the core verdict).
export function recordSettlement(key, payload) {
  const core = { ...payload };
  delete core.evidence_bundle;
  delete core.recovery;
  delete core.elapsedMs;
  delete core.cache;
  const responseHash = sha256Hex(canonicalStable(core));
  if (settled.size >= IDEMPOTENCY_MAX_KEYS) {
    // drop the oldest entry; the store is a cache, not a ledger
    settled.delete(settled.keys().next().value);
  }
  settled.set(key, { payload, responseHash, settledAt: Date.now(), replays: 0 });
  return { responseHash };
}

// Look up a replayable verdict. Applies TTL and replay cap; expired or
// exhausted keys are deleted and reported as null.
export function replayFor(key) {
  const entry = settled.get(key);
  if (!entry) return null;
  if (Date.now() - entry.settledAt > IDEMPOTENCY_TTL_MS) {
    settled.delete(key);
    return null;
  }
  if (entry.replays >= IDEMPOTENCY_MAX_REPLAYS) {
    settled.delete(key);
    return null;
  }
  entry.replays += 1;
  return { payload: entry.payload, responseHash: entry.responseHash, replays: entry.replays };
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
