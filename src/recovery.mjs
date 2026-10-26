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
//   * The key is the ONLY replay credential. It is caller-chosen and secret;
//     anyone who presents it can replay the verdict for free, so callers should
//     not log it publicly. No header-derived payer identity is trusted here.
//   * There is no content-hash companion alias. A content hash is public, so
//     deriving a second credential from it turns "known body" into "free read".
//     A token returned only in the original response cannot help a caller whose
//     response was lost, which is the whole point of recovery. The original key
//     is the only secret that survives a lost response, so it is the only one.
//   * A settled record always retains the settlement-promoted payer (when the
//     facilitator supplied one) as `verified_payer` for audit. It is not used to
//     authorize a replay from an unverified header.
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

// The idempotency key is a bearer credential: anyone who presents it can replay
// a settled verdict until the TTL/replay cap. Reject low-entropy keys before
// they can be used, while keeping "no key" exactly as it was.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_SHAPE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_SAFE_KEY_RE = /^[A-Za-z0-9_-]+$/;
const MIN_IDEMPOTENCY_KEY_LENGTH = 32;
const MIN_IDEMPOTENCY_DISTINCT = 16;

const SEQUENTIAL_SOURCES = [
  "0123456789",
  "abcdefghijklmnopqrstuvwxyz",
  "abcdefghijklmnopqrstuvwxyz0123456789",
  "abcdefghijklmnopqrstuvwxyz1234567890",
  "0123456789abcdefghijklmnopqrstuvwxyz",
];

function isRepeatedBlock(value) {
  for (let size = 1; size <= value.length / 2; size++) {
    if (value.length % size !== 0) continue;
    if (value.slice(0, size).repeat(value.length / size) === value) return true;
  }
  return false;
}

function isSequentialPattern(value) {
  const lower = value.toLowerCase();
  return SEQUENTIAL_SOURCES.some((source) => {
    const repeated = source.repeat(Math.ceil(lower.length / source.length) + 1);
    return repeated.includes(lower) || [...repeated].reverse().join("").includes(lower);
  });
}

/**
 * Validate a caller-supplied idempotency key.
 *
 * Accepted:
 *   - a UUID v4, or
 *   - at least 32 URL-safe base64/hex characters with at least 16 distinct
 *     characters, not a repeated block and not a sequential pattern.
 *
 * Returns `{ ok: true, key }` or `{ ok: false, message }`. The message never
 * contains the key.
 */
export function validateIdempotencyKey(raw) {
  const key = String(raw ?? "").trim();
  if (!key) return { ok: false, message: "idempotency key is empty" };
  if (UUID_V4_RE.test(key)) return { ok: true, key };
  if (UUID_SHAPE_RE.test(key)) {
    return {
      ok: false,
      message:
        "idempotency key must be a UUID v4; use crypto.randomUUID() (or at least 32 URL-safe random characters with at least 16 distinct characters)",
    };
  }

  if (key.length < MIN_IDEMPOTENCY_KEY_LENGTH) {
    return {
      ok: false,
      message:
        "idempotency key is too short; use crypto.randomUUID() or at least 32 URL-safe characters (A-Z, a-z, 0-9, _, -) with at least 16 distinct characters",
    };
  }
  if (!URL_SAFE_KEY_RE.test(key)) {
    return {
      ok: false,
      message:
        "idempotency key must be URL-safe (A-Z, a-z, 0-9, _, -); use crypto.randomUUID() or a base64url/hex value",
    };
  }
  if (new Set(key).size < MIN_IDEMPOTENCY_DISTINCT) {
    return {
      ok: false,
      message:
        "idempotency key has too little entropy; use crypto.randomUUID() or a random value with at least 16 distinct characters",
    };
  }
  if (isRepeatedBlock(key) || isSequentialPattern(key)) {
    return {
      ok: false,
      message:
        "idempotency key looks sequential or repeated; use crypto.randomUUID() or a cryptographically random value",
    };
  }
  return { ok: true, key };
}
// After the replay window closes, the expired verdict is kept as a tombstone
// for this long. A retry within the tombstone window still re-measures (the
// paywall re-arms — anything else would be a free-measure loophole), but the
// new response carries a typed `recovery.remeasured` signal instead of
// silently pretending nothing happened. Feedback: prismdeadlines, Oct 2026.
export const IDEMPOTENCY_REMEASURE_MS = 6 * 60 * 60 * 1000;  // 6 hours

const settled = new Map();    // key -> entry (shared between aliases; settled flag gates replayability)
const tombstones = new Map(); // key -> { responseHash, settledAt, expiredAt }

// ------------------------------------------------------------- durability --
// When RECOVERY_DB_PATH is set, the maps above are write-through backed by a
// SQLite store (src/recovery-store.mjs): a staged record is committed to disk
// BEFORE the settlement call, and promotion/abandon/expiry are mirrored, so a
// restart cannot cause a double charge. Without the variable, behavior is
// exactly the historical memory-only one (all existing semantics and tests).
import {
  initRecoveryStore, loadRecoveryFromDb, listStagedEntries,
  stageEntry, promoteEntry, abandonEntry, evictEntry, updateEntry,
  tombstoneSet as storeTombstoneSet, tombstoneDelete as storeTombstoneDelete,
  storeHealth,
} from "./recovery-store.mjs";
import { logError, logWarn } from "./log.mjs";

const RECOVERY_DB_PATH = process.env.RECOVERY_DB_PATH || null;
let storeReady = false;
if (RECOVERY_DB_PATH) {
  const opened = initRecoveryStore(RECOVERY_DB_PATH);
  if (opened.ok) {
    storeReady = true;
    const loaded = loadRecoveryFromDb();
    if (loaded) {
      // The alias rows are the authority for alias membership after a restart;
      // entry objects stay shared per operation, exactly like in memory.
      for (const [opId, entry] of loaded.entries) {
        entry.aliases = loaded.aliases.get(opId) || [];
        for (const k of entry.aliases) settled.set(k, entry);
      }
      for (const [k, t] of loaded.tombstones) tombstones.set(k, t);
    }
  } else {
    logError(
      `REFUSING memory-only fallback: the recovery store failed to open (${opened.error?.message ?? opened.error}). Paid routes will fail closed (503 recovery_unavailable) until it is healthy.`,
    );
  }
}

export function recoveryStoreHealth() {
  return { ...storeHealth(), ready: storeReady };
}

// A staged entry may only be dropped/aged out when its payment is KNOWN not to
// have settled. In memory-only mode there is no durable state to protect, so
// the historical TTL applies; in durable mode only a definitive on-chain
// reconciliation ("not settled") may expire a staged record — anything else
// stays pending (fail closed) rather than risking a second payment.
function entryCanExpire(e) {
  if (!storeReady) return true;
  return e.reconciled === "not_settled";
}

function dropEntryFromMemory(e) {
  for (const a of e.aliases) {
    if (settled.get(a) === e) settled.delete(a);
    inFlight.delete(a);
  }
}
// In-process request reservations. This closes the concurrent-request window:
// the first same-key request reserves the key before the paywall, and a second
// request gets a typed pending response instead of doing the work twice.
// Reservations are process-local and disappear on restart, like the records.
const inFlight = new Map();   // key -> { token, requestHash, at }
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
//
// One key, one entry. The old content-hash companion is deliberately gone: a
// companion key derived from public request content is a second credential, and
// it made a settled verdict readable by anyone who could reproduce the body.
//
// Every operation gets a server-generated `operationId`, embedded in the
// response under `recovery.operationId` (excluded from the projection hash).
// The settlement hook promotes by THAT identity — never by response bytes
// alone, because two different operations can produce byte-identical output
// (review: NSPG13 on x402-foundation/x402#3848, Oct 2026).
// The responseHash is computed from a copy of payload with `recovery.operationId`
// removed, so it stays stable across operations that embed their own identity.
export function recordSettlement(key, payload, _companionKey = null, {
  settledNow = false,
  requestHash: operationRequestHash = null,
  operationId = randomUUID(),
  // How to re-check this payment on-chain if the process restarts before the
  // settle hook fires. Shape: { chainId, token, payer, nonce, validBefore,
  // network }. Extracted by server.mjs from the verified x-payment header —
  // never part of the response payload or its hash.
  paymentRef = null,
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
    verified_payer: null,
    settlement: null,
    settled: settledNow ? true : false,
    stagedAt: t,
    settledAt: settledNow ? t : null,
    replays: 0,
    aliases: [key].filter(Boolean),
    paymentRef: paymentRef ?? null,
  };
  // WRITE-AHEAD: the staged record is committed to disk here — BEFORE the x402
  // middleware submits the settlement (which happens after this handler
  // returns). If the journaling fails, the paid route fails closed (503
  // recovery_unavailable) instead of reaching an unrecorded settlement.
  stageEntry(entry); // no-op when the store is disabled; throws when enabled+broken
  // staged-entry GC: drop staged records that were never promoted — but only
  // when their payment is known not to have settled (reconciliation), never
  // "silently expire into charge again" while the outcome is unknown.
  for (const [k, e] of settled) {
    if (!e.settled && t - e.stagedAt > IDEMPOTENCY_STAGE_TTL_MS && entryCanExpire(e)) {
      dropEntryFromMemory(e);
      evictEntry(e.operationId);
    }
  }
  if (settled.size >= IDEMPOTENCY_MAX_KEYS && !settled.has(key)) {
    // drop the oldest entry; the store is a cache, not a ledger. Only an
    // entry that may expire may be evicted: an unresolved staged payment
    // cannot be discarded to make room.
    for (const k of settled.keys()) {
      const oe = settled.get(k);
      if (oe && entryCanExpire(oe)) {
        for (const a of oe.aliases) if (settled.get(a) === oe) settled.delete(a);
        evictEntry(oe.operationId);
        break;
      }
    }
  }
  for (const k of entry.aliases) {
    tombstones.delete(k); // a fresh settlement re-opens the window
    inFlight.delete(k);
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
//   5. if the entry already carries a verified payer, the settlement must agree.
// The settlement's payer is stored as `verified_payer` for audit. It does not
// authorize replays from a raw header; the caller's key does that.
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

  const payer = typeof settlement.payer === "string" && settlement.payer.trim()
    ? settlement.payer.trim().toLowerCase()
    : null;
  if (e.verified_payer && e.verified_payer !== payer) return 0;

  const t = nowFn();
  e.settled = true;
  e.settledAt = t;
  e.verified_payer = payer;
  e.identity = payer ? "settlement_payer" : "settlement_only";
  e.settlement = {
    transaction: settlement.transaction,
    network: settlement.network ?? null,
    payer: settlement.payer ?? null,
  };
  for (const a of e.aliases) tombstones.delete(a);
  // Mirror to the durable store (best-effort): if this write fails, the row
  // stays 'staged' on disk, so a restart answers pending — fail closed, never
  // double-chargeable — and the unhealthy flag 503s paid routes meanwhile.
  promoteEntry(e.operationId, e);
  return 1;
}

// Reserve a key for one in-process request. Returns:
//   { token }                 this request owns the key
//   { pending: true }         another request is already working on it
//   { conflict: "request_mismatch" } same key, different request content
//   null                      no key supplied
// A reservation is released on response finish/close, when the verdict is
// staged, or when the process restarts. It is not a durable lock.
export function reserveRecovery({ key, requestHash: operationRequestHash = null } = {}) {
  if (!key) return null;
  const t = nowFn();
  const existing = inFlight.get(key);
  if (existing) {
    if (operationRequestHash && existing.requestHash && operationRequestHash !== existing.requestHash) {
      return { conflict: "request_mismatch" };
    }
    if (t - existing.at <= IDEMPOTENCY_STAGE_TTL_MS) return { pending: true };
    inFlight.delete(key); // stale reservation; let a retry proceed
  }
  const token = randomUUID();
  inFlight.set(key, { token, requestHash: operationRequestHash, at: t });
  return { token };
}

// Release only the reservation this request owns. A late finish from an old
// request must not clear a newer reservation for the same key.
export function releaseRecovery(key, token) {
  const existing = key ? inFlight.get(key) : null;
  if (!existing) return false;
  if (token && existing.token !== token) return false;
  inFlight.delete(key);
  return true;
}

// Drop a staged entry when the settlement is explicitly known to have failed.
// The caller can then retry with the same key instead of waiting for the
// stage TTL. A settled entry is never removed here.
export function abandonSettlement(body) {
  let obj = null;
  if (body && typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    try { obj = JSON.parse(body.toString("utf8")); } catch { return 0; }
  } else if (typeof body === "string") {
    try { obj = JSON.parse(body); } catch { return 0; }
  } else if (body && typeof body === "object") {
    obj = body;
  }
  const opId = obj?.recovery?.operationId;
  if (typeof opId !== "string" || !opId) return 0;
  let removed = 0;
  for (const [k, e] of settled) {
    if (e.operationId === opId && !e.settled) {
      dropEntryFromMemory(e);
      abandonEntry(opId); // durable mirror; a failed delete leaves the row pending (fail closed)
      removed = 1;
    }
  }
  return removed;
}

// Decide what an incoming request may do with an idempotency key. Returns
// `{ hit }` (replay), `{ pending }` (settlement still unresolved),
// `{ conflict }` (reject BEFORE payment or replay), or null (not recoverable
// — continue to the paywall).
//
// Authorization is possession of the original key, full stop. The key is bound
// to the operation's request fingerprint, so reusing it for different content
// is a conflict rather than a wrong answer. No payer scope is read from
// `x-payment`, `payment-signature`, or any other caller-controlled header:
// `authorization.from` is unverified at this layer, and treating it as an
// identity was C-1. The settled record's `verified_payer` comes only from the
// facilitator's settlement result.
export function lookupRecovery({
  key,
  requestHash: operationRequestHash = null,
} = {}) {
  const entry = key ? settled.get(key) : null;
  if (!entry) return null;
  if (operationRequestHash && entry.requestHash && operationRequestHash !== entry.requestHash) {
    return { conflict: "request_mismatch" };
  }
  if (!entry.settled) {
    // A staged entry means the handler ran and its settlement is still
    // unresolved (or failed without an explicit failure hook). Do not let a
    // retry do the work again while that outcome is unknown.
    //
    // Durable mode: a staged entry whose stage TTL has passed must NOT simply
    // expire into "charge again". The payment may already have settled (lost
    // settle hook). The entry stays pending and a reconciliation check —
    // EIP-3009 authorizationState on the token contract — decides: consumed
    // => promote to settled (replayable); past validBefore and not consumed
    // => definitive not-settled, expire; check unavailable/failed => stay
    // pending (the route answers recovery_unavailable rather than pay again).
    if (nowFn() - entry.stagedAt > IDEMPOTENCY_STAGE_TTL_MS && !entryCanExpire(entry)) {
      return { pending: "reconciliation_required", stale: true, operationId: entry.operationId };
    }
    if (nowFn() - entry.stagedAt > IDEMPOTENCY_STAGE_TTL_MS) {
      dropEntryFromMemory(entry);
      evictEntry(entry.operationId);
      return null;
    }
    return { pending: "settlement_pending" };
  }
  const hit = replayFor(key);
  return hit ? { hit } : null;
}

// Look up a replayable verdict. Applies the settled gate, TTL and replay cap.
// Expired SETTLED keys move to the tombstone map instead of vanishing.
// Staged-but-unpromoted entries are invisible here.
export function replayFor(key) {
  const entry = settled.get(key);
  if (!entry || !entry.settled) {
    // staged entries age out only when their payment is known not settled:
    // nothing was ever settled, so there is no "lost verdict" to report.
    if (entry && !entry.settled && nowFn() - entry.stagedAt > IDEMPOTENCY_STAGE_TTL_MS && entryCanExpire(entry)) {
      dropEntryFromMemory(entry);
      evictEntry(entry.operationId);
    }
    if (!entry) return null;
    if (!entry.settled) return null;
  }
  if (nowFn() - entry.settledAt > IDEMPOTENCY_TTL_MS) {
    for (const a of entry.aliases) {
      if (settled.get(a) === entry) settled.delete(a);
      if (settled.size + tombstones.size < 4000) {
        const t = { responseHash: entry.responseHash, settledAt: entry.settledAt, expiredAt: nowFn() };
        tombstones.set(a, t);
        storeTombstoneSet(a, t);
      }
    }
    evictEntry(entry.operationId);
    return null;
  }
  if (entry.replays >= IDEMPOTENCY_MAX_REPLAYS) {
    for (const a of entry.aliases) if (settled.get(a) === entry) settled.delete(a);
    evictEntry(entry.operationId);
    return null;
  }
  entry.replays += 1;
  updateEntry(entry.operationId, entry); // durable replay counter
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
    storeTombstoneDelete(key); // durable mirror; a failed delete is benign (typed signal reappears after reload)
    return null;
  }
  return { previousResponseHash: t.responseHash, expiredAt: new Date(t.expiredAt).toISOString() };
}

// ------------------------------------------------- payment reconciliation --
// Staged entries whose settle outcome was lost must not silently expire into
// "charge again". The codebase's available ground truth is the token contract
// itself: x402 v2 "exact" on EVM settles via EIP-3009 transferWithAuthorization,
// and the USDC contract exposes `authorizationState(authorizer, nonce)` — a
// free view call. Consumed => the payment moved (promote to settled); not
// consumed AFTER validBefore => the authorization can never settle now
// (definitively safe to expire). Before validBefore the outcome is genuinely
// unknown and the record stays pending. Solana staged records carry no
// checkable payment reference and fail closed (stay pending; the route answers
// recovery_unavailable) — no equivalent check exists in this codebase.
//
// The checker is injected (server.mjs wires the viem public client); tests
// inject a stub. It receives the paymentRef recorded at stage time and
// resolves true/false, or rejects when the check cannot be made.
let paymentChecker = null;
export function setRecoveryPaymentChecker(fn) {
  paymentChecker = fn;
}

const reconciling = new Set();     // operationIds with an attempt in flight
const reconcileFailures = new Map(); // operationId -> last failure reason

// Typed reconciliation status for the paid routes:
//   "ok"        the record resolved (settled or definitively expired)
//   "inflight"  an attempt is running — answer pending
//   "failed"    the last attempt errored — answer recovery_unavailable (503)
//   "unknown"   no attempt recorded — kick one off
export function reconciliationState(operationId) {
  if (reconciling.has(operationId)) return "inflight";
  return reconcileFailures.has(operationId) ? "failed" : "unknown";
}

function findStagedEntry(operationId) {
  for (const e of new Set(settled.values())) {
    if (e.operationId === operationId) return e.settled ? null : e;
  }
  return null;
}

// Promote a staged entry using on-chain evidence (no facilitator result
// exists — the settle hook was lost). The evidence is recorded in
// `settlement.reconciled`; transaction stays null because no receipt hash is
// available from a view call. replayable exactly like a hook-promoted entry.
function promoteReconciled(entry, ref) {
  const t = nowFn();
  entry.settled = true;
  entry.settledAt = t;
  entry.verified_payer = typeof ref.payer === "string" ? ref.payer.toLowerCase() : null;
  entry.identity = entry.verified_payer ? "settlement_payer" : "settlement_only";
  entry.settlement = {
    transaction: null,
    network: ref.network ?? null,
    payer: ref.payer ?? null,
    reconciled: "eip3009_authorizationState",
    note: "promoted after restart: the token contract reports this payment's authorization was consumed",
  };
  for (const a of entry.aliases) tombstones.delete(a);
  promoteEntry(entry.operationId, entry);
}

// Re-check one staged operation against the chain. Returns:
//   "settled"       payment found on-chain; promoted, replayable
//   "expired_safe"  past validBefore and not consumed; record expired
//   "pending"       still inside the validBefore window; outcome unknown
//   "failed"        the check errored — fail closed
//   "unavailable"   no checker / no paymentRef (e.g. Solana) — fail closed
export async function reconcileStagedEntry(operationId) {
  const entry = findStagedEntry(operationId);
  if (!entry) return "settled_or_gone";
  const ref = entry.paymentRef;
  if (!ref || !paymentChecker) {
    reconcileFailures.set(operationId, "no payment reference or no checker configured");
    return "unavailable";
  }
  if (reconciling.has(operationId)) return "inflight";
  reconciling.add(operationId);
  try {
    const t = nowFn();
    const deadlineMs = Number.isFinite(ref.validBefore) && ref.validBefore > 0
      ? ref.validBefore * 1000
      : null;
    const pastDeadline = deadlineMs !== null && t >= deadlineMs;
    let consumed;
    try {
      consumed = Boolean(await paymentChecker(ref));
    } catch (e) {
      reconcileFailures.set(operationId, e?.message ?? String(e));
      logWarn(`recovery reconciliation failed for ${operationId}: ${e?.message ?? e}`);
      return "failed";
    }
    reconcileFailures.delete(operationId);
    if (consumed) {
      promoteReconciled(entry, ref);
      return "settled";
    }
    if (pastDeadline) {
      entry.reconciled = "not_settled";
      dropEntryFromMemory(entry);
      evictEntry(entry.operationId);
      return "expired_safe";
    }
    return "pending"; // outcome unknown: stays pending, fail closed
  } finally {
    reconciling.delete(operationId);
  }
}

// Startup pass: reconcile every staged record loaded from the store. Runs
// before listen() in server.mjs; bounded by the staged-row count (<= key cap).
export async function reconcileStagedOnStartup() {
  if (!storeReady) return 0;
  const staged = listStagedEntries();
  if (staged === null) return 0; // store read failed: unhealthy, lookups fail closed
  let n = 0;
  for (const e of staged) {
    if (e.settled) continue;
    const r = await reconcileStagedEntry(e.operationId);
    n += 1;
    if (r !== "settled") {
      logWarn(`recovery startup: staged operation ${e.operationId} reconciles as ${r}`);
    }
  }
  return n;
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
