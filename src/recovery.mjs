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

import { createHash, randomUUID } from "node:crypto";

export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;   // 10 minutes
export const IDEMPOTENCY_MAX_REPLAYS = 3;
export const IDEMPOTENCY_MAX_KEYS = 1000;
// After the replay window closes, the expired verdict is kept as a tombstone
// for this long. A retry within the tombstone window still re-measures (the
// paywall re-arms — anything else would be a free-measure loophole), but the
// new response carries a typed `recovery.remeasured` signal instead of
// silently pretending nothing happened. Feedback: prismdeadlines, Oct 2026.
export const IDEMPOTENCY_REMEASURE_MS = 6 * 60 * 60 * 1000;  // 6 hours

const settled = new Map();    // key -> entry (shared between aliases; settled flag gates replayability)
const tombstones = new Map(); // key -> { responseHash, settledAt, expiredAt }
// Staged entries live at most this long before being silently dropped. A
// staged record was never settled — if the settle outcome is lost (SettleError,
// transport loss in our own tests, facilitator outage), the record MUST NOT
// become replayable: fail closed, not free. Feedback: SameDayDesk trace against
// cd59b105 (recovery recorded before settlement success), Oct 2026.
export const IDEMPOTENCY_STAGE_TTL_MS = 5 * 60 * 1000;
const PROJECTED_KEYS = ["evidence_bundle", "recovery", "elapsedMs", "cache", "operationId"];

function projectionHash(payload) {
  const core = { ...payload };
  for (const k of PROJECTED_KEYS) delete core[k];
  return sha256Hex(canonicalStable(core));
}

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

// Stage a verdict under a caller key. THE RECORD IS NOT REPLAYABLE YET: the
// caller must either pay through x402 (the `onAfterSettle` hook in server.mjs
// promotes the entry once the facilitator confirms the settlement), or run in
// BYPASS mode (settledNow: true, local testing only — loud warnings upstream).
// Two aliases share ONE entry object (caller key + content-hash companion), so
// the replay cap is per operation, not per alias (SameDayDesk: two aliases
// must not mean six free reads).
//
// Every operation gets a server-generated `operationId`, embedded in the
// response under `recovery.operationId` (excluded from the projection hash).
// The settlement hook promotes by THAT identity — never by response bytes
// alone, because two different operations can produce byte-identical output
// (review: NSPG13 on x402-foundation/x402#3848, Oct 2026).
// The responseHash is computed from a copy of payload with `recovery.operationId`
// removed, so it stays stable across operations that embed their own identity.
export function recordSettlement(key, payload, companionKey = null, {
  settledNow = false,
  requestHash: operationRequestHash = null,
  scope = null,
  operationId = randomUUID(),
} = {}) {
  // The projection strips `recovery` (and `operationId`) entirely, so the hash
  // is stable regardless of what operationId the caller or server attaches.
  const responseHash = projectionHash(payload);

  // Embed the operation identity in the response so the settlement hook can
  // match it exactly. `recovery` is excluded from the projection, so this
  // does not change responseHash.
  payload.recovery = { ...(payload.recovery || {}), operationId };
  const t = nowFn();
  const entry = {
    payload, responseHash, operationId,
    requestHash: operationRequestHash,
    scope,
    settlement: null,
    settled: settledNow ? true : false,
    stagedAt: t,
    settledAt: settledNow ? t : null,
    replays: 0,
    aliases: [key, companionKey].filter(Boolean),
  };
  // staged-entry GC: drop staged records that were never promoted
  for (const [k, e] of settled) {
    if (!e.settled && t - e.stagedAt > IDEMPOTENCY_STAGE_TTL_MS) {
      for (const a of e.aliases) if (settled.get(a) === e) settled.delete(a);
    }
  }
  if (settled.size >= IDEMPOTENCY_MAX_KEYS && !settled.has(key)) {
    // drop the oldest entry; the store is a cache, not a ledger
    const oldest = settled.keys().next().value;
    const oe = settled.get(oldest);
    for (const a of oe.aliases) if (settled.get(a) === oe) settled.delete(a);
  }
  for (const k of entry.aliases) {
    tombstones.delete(k); // a fresh settlement re-opens the window
    settled.set(k, entry);
  }
  return { responseHash, operationId };
}

// Promote a staged record to settled. Called from the x402 `onAfterSettle`
// hook with the final response body and the facilitator's settle result.
// Promotion requires ALL of:
//   1. the body names an operationId (fail closed without it),
//   2. a confirmed settlement (success + transaction reference),
//   3. exactly one staged entry with that operationId,
//   4. the projected bytes still match that entry (additional check),
//   5. the settlement's payer matches the staged authorization scope, if known.
// Response-hash equality alone is never enough: two operations can legitimately
// return identical bytes, and settling one must not promote the other.
export function promoteSettlement(body, settlement) {
  let obj = null;
  if (body && typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    try { obj = JSON.parse(body.toString("utf8")); } catch { return 0; }
  } else if (typeof body === "string") {
    try { obj = JSON.parse(body); } catch { return 0; }
  } else if (body && typeof body === "object") {
    obj = body;
  }
  if (!obj) return 0;

  const opId = obj?.recovery?.operationId;
  if (typeof opId !== "string" || !opId) return 0;
  if (!settlement || settlement.ok !== true) return 0;
  if (typeof settlement.transaction !== "string" || !settlement.transaction) return 0;

  const h = projectionHash(obj);
  const matches = [];
  for (const e of new Set(settled.values())) {
    if (e.operationId === opId) matches.push(e);
  }
  if (matches.length !== 1) return 0;           // ambiguous or unknown: fail closed
  const e = matches[0];
  if (e.settled) return 0;
  if (e.responseHash !== h) return 0;           // bytes changed since staging
  if (e.scope) {
    const payer = typeof settlement.payer === "string" ? settlement.payer.toLowerCase() : null;
    if (!payer || payer !== e.scope) return 0;  // scope must be confirmed, not assumed
  }

  const t = nowFn();
  e.settled = true;
  e.settledAt = t;
  e.settlement = {
    transaction: settlement.transaction,
    network: settlement.network ?? null,
    payer: settlement.payer ?? null,
  };
  for (const a of e.aliases) tombstones.delete(a);
  return 1;
}

// Decide what an incoming request may do with an idempotency key. Returns
// `{ hit }` (replay), `{ conflict }` (reject BEFORE payment or replay), or
// null (not recoverable — continue to the paywall).
//
// The key is bound to the operation's request fingerprint and authorization
// scope. Reusing a key for different content, or presenting a settled key from
// a different payer, is a conflict rather than a wrong answer or a free ride.
// The content companion is a recovery alias for the SAME caller, not a public
// cache: equal request bodies do not establish permission to see another
// caller's result (review: NSPG13 on x402-foundation/x402#3848).
export function lookupRecovery({
  key,
  companionKey = null,
  requestHash: operationRequestHash = null,
  scope = null,
} = {}) {
  const entry = key ? settled.get(key) : null;
  if (entry) {
    if (operationRequestHash && entry.requestHash && operationRequestHash !== entry.requestHash) {
      return { conflict: "request_mismatch" };
    }
    if (scope && entry.scope && scope !== entry.scope) {
      return { conflict: "scope_mismatch" };
    }
    if (entry.settled) {
      const hit = replayFor(key);
      return hit ? { hit } : null;
    }
    return null; // staged: same operation may pay; nothing is replayable yet
  }

  if (companionKey) {
    const c = settled.get(companionKey);
    if (c && c.settled) {
      // Equal content is not permission. Without a known, matching scope the
      // companion is not a recovery path for this caller.
      if (!scope || !c.scope || c.scope !== scope) return null;
      if (operationRequestHash && c.requestHash && operationRequestHash !== c.requestHash) return null;
      const hit = replayFor(companionKey);
      return hit ? { hit } : null;
    }
  }
  return null;
}

// Look up a replayable verdict. Applies the settled gate, TTL, replay cap and
// companion-key fallback; expired SETTLED keys move to the tombstone map
// instead of vanishing. Staged-but-unpromoted entries are invisible here.
export function replayFor(key) {
  const entry = settled.get(key);
  if (!entry || !entry.settled) {
    // staged entries that aged out silently leave no tombstone: nothing
    // was ever settled, so there is no "lost verdict" to report.
    if (entry && !entry.settled && nowFn() - entry.stagedAt > IDEMPOTENCY_STAGE_TTL_MS) {
      for (const a of entry.aliases) if (settled.get(a) === entry) settled.delete(a);
    }
    if (!entry) return null;
    if (!entry.settled) return null;
  }
  if (nowFn() - entry.settledAt > IDEMPOTENCY_TTL_MS) {
    for (const a of entry.aliases) {
      if (settled.get(a) === entry) settled.delete(a);
      if (settled.size + tombstones.size < 4000) {
        tombstones.set(a, { responseHash: entry.responseHash, settledAt: entry.settledAt, expiredAt: nowFn() });
      }
    }
    return null;
  }
  if (entry.replays >= IDEMPOTENCY_MAX_REPLAYS) {
    for (const a of entry.aliases) if (settled.get(a) === entry) settled.delete(a);
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

// Standard evidence bundle on every paid response. responseHash uses the SAME
// projection as recordSettlement (evidence_bundle, recovery, cache, elapsedMs
// excluded) — one projection everywhere, so any receiver recomputing per the
// documented recipe gets the same number from the first paid response, the
// replayed response and every response in between. (SameDayDesk: the two
// projections previously disagreed and the advertised hash was ambiguous.)
export function evidenceBundle({ route, body, pinnedBlock, payload }) {
  const core = { ...payload };
  delete core.evidence_bundle;
  delete core.recovery;
  delete core.elapsedMs;
  delete core.cache;
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
