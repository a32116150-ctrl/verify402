// Durable persistence for the settlement recovery store (src/recovery.mjs).
//
// Purpose: a process restart must never allow a second charge for a payment
// that already settled. The in-memory Maps in recovery.mjs are the fast cache;
// this module is the write-ahead source of truth, backed by SQLite:
//
//   stage   (recordSettlement)      -> INSERT committed BEFORE the facilitator
//                                      settlement call is made (synchronous,
//                                      WAL + synchronous=FULL => fsynced).
//   promote (promoteSettlement)     -> UPDATE to state 'settled'.
//   abandon (abandonSettlement)     -> DELETE, only on definitive failure.
//   expire  (TTL / replay cap)      -> DELETE + tombstone INSERT, mirroring the
//                                      in-memory lifecycle.
//
// Driver: `node:sqlite` (built into Node >= 22.13 unflagged). No native
// dependency is added, so the published bridge package stays untouched.
//
// Single-instance by construction: a plain SQLite file on one disk. Never run
// two server instances against the same path (see DEPLOY.md).
//
// Enabled ONLY when RECOVERY_DB_PATH is set. Without it, the server keeps the
// historical memory-only behavior exactly (same tests, same semantics); with
// it, every mutation is mirrored and a write-ahead stage failure fails CLOSED:
// the paid route answers 503 recovery_unavailable instead of risking an
// unrecorded settlement.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class RecoveryStoreError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "RecoveryStoreError";
    this.code = "recovery_unavailable";
  }
}

let db = null;
let dbPath = null;
let healthy = true;
let lastError = null;
// Distinguishes "store disabled (RECOVERY_DB_PATH unset — legacy memory-only)"
// from "store enabled but failed to open" — the second MUST fail closed, never
// silently degrade to memory-only.
let openFailed = false;

export function storeEnabled() {
  return db !== null;
}

export function storeFailedToOpen() {
  return openFailed;
}

export function storeHealthy() {
  return healthy;
}

export function storeHealth() {
  return {
    enabled: db !== null,
    healthy,
    failedToOpen: openFailed,
    path: dbPath,
    lastError: lastError ? String(lastError?.message || lastError) : null,
  };
}

// An unhealthy store clears on the next successful operation: every op first
// probes (SELECT 1) when unhealthy, so a transient lock/error is forgotten as
// soon as one op succeeds again. Latched only while every attempt fails.
function probeStore() {
  if (!db) return false;
  try {
    db.prepare("SELECT 1 AS ok").get();
    healthy = true;
    lastError = null;
    return true;
  } catch (e) {
    healthy = false;
    lastError = e;
    return false;
  }
}

function markUnhealthy(e) {
  healthy = false;
  lastError = e;
}

// Best-effort wrapper: run fn against the store; on failure mark unhealthy and
// return false. The caller keeps its in-memory mutation (degradation is toward
// fail-closed on restart: a lost tombstone/eviction can only make a retry MORE
// blocked after reload, never more chargeable).
function bestEffort(fn) {
  if (!db) return false;
  if (!healthy && !probeStore()) return false;
  try {
    fn();
    healthy = true;
    return true;
  } catch (e) {
    markUnhealthy(e);
    return false;
  }
}

// Strict wrapper for the write-ahead stage: the row MUST hit disk before the
// settlement call. Any failure throws RecoveryStoreError so the paid route can
// answer 503 instead of continuing to settlement unrecorded. A store that
// failed to open throws too — never a silent memory-only fallback.
function strict(fn) {
  if (!db) {
    if (openFailed) {
      throw new RecoveryStoreError("recovery store unavailable; refusing to accept a payment whose settlement could not be journaled", { cause: lastError });
    }
    return false; // store disabled: legacy memory-only behavior
  }
  try {
    fn();
    healthy = true;
    return true;
  } catch (e) {
    markUnhealthy(e);
    if (!probeStore()) throw new RecoveryStoreError("recovery store unavailable; refusing to accept a payment whose settlement could not be journaled", { cause: e });
    // The probe succeeded — the failure was specific to this statement. It is
    // still a stage failure: fail closed.
    throw new RecoveryStoreError("recovery store could not journal the staged settlement", { cause: e });
  }
}

export function initRecoveryStore(path) {
  if (db) return { ok: true, path: dbPath, alreadyOpen: true };
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    dbPath = path;
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS recovery_entry (
        operation_id TEXT PRIMARY KEY,
        state        TEXT NOT NULL CHECK (state IN ('staged','settled')),
        ts           INTEGER NOT NULL,
        entry        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_alias (
        key          TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recovery_alias_op ON recovery_alias(operation_id);
      CREATE TABLE IF NOT EXISTS recovery_tombstone (
        key           TEXT PRIMARY KEY,
        response_hash TEXT NOT NULL,
        settled_at    INTEGER NOT NULL,
        expired_at    INTEGER NOT NULL
      );
    `);
    const qc = db.prepare("PRAGMA quick_check").get();
    if (!qc || qc.quick_check !== "ok") {
      throw new Error(`sqlite integrity check failed: ${qc ? qc.quick_check : "no result"}`);
    }
    healthy = true;
    lastError = null;
    return { ok: true, path };
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    dbPath = null;
    openFailed = true;
    markUnhealthy(e);
    return { ok: false, error: e };
  }
}

// Reload the maps after a restart. Returns shared-per-operation entry objects,
// so alias rows point at ONE object exactly like the in-memory semantics.
// Returns null (and marks unhealthy) if the read fails.
export function loadRecoveryFromDb() {
  if (!db) return null;
  try {
    const entries = new Map();
    for (const row of db.prepare("SELECT operation_id, entry FROM recovery_entry").all()) {
      entries.set(row.operation_id, JSON.parse(row.entry));
    }
    const aliases = new Map(); // opId -> [keys]
    for (const row of db.prepare("SELECT key, operation_id FROM recovery_alias").all()) {
      const list = aliases.get(row.operation_id) || [];
      list.push(row.key);
      aliases.set(row.operation_id, list);
    }
    const tombstones = new Map();
    for (const row of db.prepare("SELECT key, response_hash, settled_at, expired_at FROM recovery_tombstone").all()) {
      tombstones.set(row.key, { responseHash: row.response_hash, settledAt: row.settled_at, expiredAt: row.expired_at });
    }
    return { entries, aliases, tombstones };
  } catch (e) {
    markUnhealthy(e);
    return null;
  }
}

// Write-ahead: the staged entry (including its paymentRef) is committed to
// disk before anything else may happen to the payment. Throws when the store
// is enabled but cannot journal the row (fail closed).
export function stageEntry(entry) {
  return strict(() => {
    const json = JSON.stringify(entry);
    // BYPASS mode settles immediately (settledNow) — journal the real state,
    // never a forced 'staged'.
    const state = entry.settled ? "settled" : "staged";
    const ts = entry.settledAt ?? entry.stagedAt;
    db.prepare(
      `INSERT INTO recovery_entry (operation_id, state, ts, entry) VALUES (?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state, ts=excluded.ts, entry=excluded.entry`,
    ).run(entry.operationId, state, ts, json);
    const aliasStmt = db.prepare(
      `INSERT INTO recovery_alias (key, operation_id) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET operation_id=excluded.operation_id`,
    );
    for (const a of entry.aliases) aliasStmt.run(a, entry.operationId);
  });
}

export function promoteEntry(operationId, entry) {
  return bestEffort(() => {
    db.prepare(
      `UPDATE recovery_entry SET state='settled', ts=?, entry=? WHERE operation_id=? AND state='staged'`,
    ).run(entry.settledAt, JSON.stringify(entry), operationId);
  });
}

export function abandonEntry(operationId) {
  return bestEffort(() => {
    db.prepare(`DELETE FROM recovery_alias WHERE operation_id=?`).run(operationId);
    db.prepare(`DELETE FROM recovery_entry WHERE operation_id=?`).run(operationId);
  });
}

// Generic rewrite (replays bump, reconciled flag). Best-effort.
export function updateEntry(operationId, entry) {
  return bestEffort(() => {
    db.prepare(`UPDATE recovery_entry SET entry=? WHERE operation_id=?`).run(JSON.stringify(entry), operationId);
  });
}

export function evictEntry(operationId) {
  return bestEffort(() => {
    db.prepare(`DELETE FROM recovery_alias WHERE operation_id=?`).run(operationId);
    db.prepare(`DELETE FROM recovery_entry WHERE operation_id=?`).run(operationId);
  });
}

export function tombstoneSet(key, tombstone) {
  return bestEffort(() => {
    db.prepare(
      `INSERT INTO recovery_tombstone (key, response_hash, settled_at, expired_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET response_hash=excluded.response_hash, settled_at=excluded.settled_at, expired_at=excluded.expired_at`,
    ).run(key, tombstone.responseHash, tombstone.settledAt, tombstone.expiredAt);
  });
}

export function tombstoneDelete(key) {
  return bestEffort(() => {
    db.prepare(`DELETE FROM recovery_tombstone WHERE key=?`).run(key);
  });
}

// Staged entries awaiting reconciliation (startup pass). Null on read failure.
export function listStagedEntries() {
  if (!db) return null;
  try {
    const out = [];
    for (const row of db.prepare(`SELECT entry FROM recovery_entry WHERE state='staged'`).all()) {
      try { out.push(JSON.parse(row.entry)); } catch { markUnhealthy(new Error("unparsable staged row")); return null; }
    }
    return out;
  } catch (e) {
    markUnhealthy(e);
    return null;
  }
}

export function closeRecoveryStore() {
  if (!db) return;
  try { db.close(); } catch { /* ignore */ }
  db = null;
  dbPath = null;
}
