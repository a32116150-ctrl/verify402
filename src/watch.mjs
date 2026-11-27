// Contract watch: a paid, time-boxed watch on one contract. Each check reads
// the facts that decide who can change what the contract does, compares them
// with the last reading, and on any change POSTs one signed event to the
// caller's own webhook.
//
// Watched facts (read at one block):
//   codeHash               keccak256 of the deployed bytecode
//   upgradeable/pattern    EIP-1967 / ZeppelinOS proxy reading
//   implementation         the proxy's current logic contract
//   implementationCodeHash keccak256 of that logic contract's bytecode
//   upgradeController      who can upgrade it (address and kind)
//   owner                  owner(), when the contract has one
//   paused                 paused(), when the contract has one
//
// What it does not do: decode governance, timelock queues, role grants
// (AccessControl), multisig signer changes, or anything inside the logic
// beyond its bytecode hash. A change is reported after it happened, never
// before; this is monitoring, not prevention.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { keccak256 } from "viem";
import { readUpgradeControl } from "./upgrade-control.mjs";
import { resolvePublicUrl, safeFetchText } from "./inspect.mjs";

export const WATCH_SPEC = "verify402/watch@1";
export const WATCH_DAYS = 30;
export const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 60 * 60 * 1000);
export const WATCH_MAX_ACTIVE = Number(process.env.WATCH_MAX_ACTIVE || 500);
export const WATCH_FIELDS = Object.freeze([
  "codeHash", "upgradeable", "pattern", "implementation", "implementationCodeHash",
  "upgradeController", "owner", "paused",
]);
export const WATCH_CHECKED = Object.freeze([
  "bytecode hash", "proxy implementation (EIP-1967 / ZeppelinOS)", "implementation bytecode hash",
  "upgrade controller", "owner()", "paused()",
]);
export const WATCH_NOT_CHECKED = Object.freeze([
  "AccessControl role grants", "timelock / governance queues (before execution)",
  "multisig signer or threshold changes", "storage other than the proxy slots",
  "diamond (EIP-2535) facets and custom proxies",
]);

const SEL = { owner: "0x8da5cb5b", paused: "0x5c975abb" };

export class WatchError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── reading ─────────────────────────────────────────────────────────────

const wordToAddress = (hex) => {
  if (typeof hex !== "string" || hex.length < 66) return null;
  const a = `0x${hex.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(a) ? null : a;
};

async function optionalCall(client, to, data, blockNumber) {
  try {
    const r = await client.call({ to, data, blockNumber });
    const out = r?.data;
    return typeof out === "string" && out.length >= 66 ? out : null;
  } catch {
    return null;
  }
}

async function codeHashAt(client, address, blockNumber) {
  const code = await client.getCode({ address, blockNumber });
  if (!code || code === "0x") return null;
  return keccak256(code);
}

/**
 * One reading of the watched facts at one block. Throws on a transport
 * failure (the caller keeps the previous reading and retries later); returns
 * { ok: false, reason } when the address holds no contract.
 */
export async function readSnapshot(client, address, { blockNumber = null } = {}) {
  const a = String(address).toLowerCase();
  const block = blockNumber ?? await client.getBlockNumber();
  const codeHash = await codeHashAt(client, a, block);
  if (!codeHash) return { ok: false, reason: "no_contract", blockNumber: String(block) };
  const [upgrade, ownerWord, pausedWord] = await Promise.all([
    readUpgradeControl(client, a),
    optionalCall(client, a, SEL.owner, block),
    optionalCall(client, a, SEL.paused, block),
  ]);
  if (upgrade.upgradeable === null) throw new Error(upgrade.error || "upgrade control could not be read");
  const implementation = upgrade.implementation ? String(upgrade.implementation).toLowerCase() : null;
  const implementationCodeHash = implementation ? await codeHashAt(client, implementation, block) : null;
  const ctl = upgrade.controller ?? null;
  return {
    ok: true,
    blockNumber: String(block),
    facts: {
      codeHash,
      upgradeable: upgrade.upgradeable === true,
      pattern: upgrade.pattern ?? null,
      implementation,
      implementationCodeHash,
      upgradeController: ctl ? `${ctl.kind ?? "unknown"}:${ctl.address ? String(ctl.address).toLowerCase() : "none"}` : null,
      owner: wordToAddress(ownerWord),
      paused: pausedWord == null ? null : BigInt(pausedWord) !== 0n,
    },
  };
}

/** The fields that differ between two readings, in a fixed order. */
export function diffFacts(prev, next) {
  if (!prev || !next) return [];
  return WATCH_FIELDS
    .filter((f) => (prev[f] ?? null) !== (next[f] ?? null))
    .map((field) => ({ field, from: prev[field] ?? null, to: next[field] ?? null }));
}

// ── webhook ─────────────────────────────────────────────────────────────

/** Validate a webhook URL before anyone pays: https, public address only. */
export async function validateWebhook(raw, { resolveHost } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new WatchError(400, "invalid_webhookUrl", "webhookUrl must be an absolute https URL");
  }
  if (url.protocol !== "https:") throw new WatchError(400, "invalid_webhookUrl", "webhookUrl must use https");
  if (String(raw).length > 500) throw new WatchError(400, "invalid_webhookUrl", "webhookUrl is too long (max 500 characters)");
  try {
    await resolvePublicUrl(url.href, resolveHost ? { resolveHost } : {});
  } catch (e) {
    throw new WatchError(400, "invalid_webhookUrl", `webhookUrl is not reachable as a public https address (${e.code || "rejected"})`);
  }
  return url.href;
}

/** POST one signed event. Never follows redirects; 2xx is delivered. */
export async function deliverWebhook(url, event, { signer, fetchText = safeFetchText } = {}) {
  const body = signer ? signer.sign(JSON.parse(JSON.stringify(event))) : event;
  try {
    const r = await fetchText(url, { method: "POST", body: JSON.stringify(body), timeoutMs: 8000, maxBytes: 4096 });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) {
    return { ok: false, status: null, error: e?.code || "fetch_failed" };
  }
}

// ── storage ─────────────────────────────────────────────────────────────

export function openWatchStore(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      webhook TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_check_at INTEGER,
      last_block TEXT,
      facts TEXT,
      last_error TEXT,
      changes INTEGER NOT NULL DEFAULT 0,
      deliveries_failed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS watch_events (
      watch_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      block TEXT,
      changes TEXT NOT NULL,
      delivered INTEGER NOT NULL,
      status INTEGER
    );
    CREATE INDEX IF NOT EXISTS watch_events_by_watch ON watch_events (watch_id, at);
  `);
  const q = {
    insert: db.prepare(`INSERT INTO watches (id, chain_id, address, webhook, label, created_at, expires_at, last_check_at, last_block, facts)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare("SELECT * FROM watches WHERE id = ?"),
    activeCount: db.prepare("SELECT COUNT(*) AS n FROM watches WHERE expires_at > ?"),
    due: db.prepare("SELECT * FROM watches WHERE expires_at > ? AND (last_check_at IS NULL OR last_check_at <= ?) ORDER BY last_check_at LIMIT ?"),
    checked: db.prepare("UPDATE watches SET last_check_at = ?, last_block = ?, facts = ?, last_error = NULL, changes = changes + ? WHERE id = ?"),
    failed: db.prepare("UPDATE watches SET last_check_at = ?, last_error = ? WHERE id = ?"),
    deliveryFailed: db.prepare("UPDATE watches SET deliveries_failed = deliveries_failed + 1 WHERE id = ?"),
    event: db.prepare("INSERT INTO watch_events (watch_id, at, block, changes, delivered, status) VALUES (?, ?, ?, ?, ?, ?)"),
    events: db.prepare("SELECT at, block, changes, delivered, status FROM watch_events WHERE watch_id = ? ORDER BY at DESC LIMIT 20"),
  };
  const row = (r) => r && ({
    id: r.id, chainId: r.chain_id, address: r.address, webhook: r.webhook, label: r.label,
    createdAt: r.created_at, expiresAt: r.expires_at, lastCheckAt: r.last_check_at, lastBlock: r.last_block,
    facts: r.facts ? JSON.parse(r.facts) : null, lastError: r.last_error, changes: r.changes, deliveriesFailed: r.deliveries_failed,
  });
  return {
    add({ chainId, address, webhook, label = null, now = Date.now(), snapshot }) {
      const id = `w_${randomBytes(16).toString("hex")}`;
      q.insert.run(id, chainId, address, webhook, label, now, now + WATCH_DAYS * 86_400_000, now, snapshot.blockNumber, JSON.stringify(snapshot.facts));
      return row(q.get.get(id));
    },
    get: (id) => row(q.get.get(String(id))),
    activeCount: (now = Date.now()) => q.activeCount.get(now).n,
    due: (now = Date.now(), intervalMs = WATCH_INTERVAL_MS, limit = 200) => q.due.all(now, now - intervalMs, limit).map(row),
    recordCheck(id, { now = Date.now(), blockNumber, facts, changeCount = 0 }) {
      q.checked.run(now, blockNumber, JSON.stringify(facts), changeCount ? 1 : 0, id);
    },
    recordError: (id, error, now = Date.now()) => q.failed.run(now, String(error).slice(0, 200), id),
    recordEvent(id, { now = Date.now(), blockNumber, changes, delivered, status }) {
      q.event.run(id, now, blockNumber, JSON.stringify(changes), delivered ? 1 : 0, status ?? null);
      if (!delivered) q.deliveryFailed.run(id);
    },
    events: (id) => q.events.all(String(id)).map((e) => ({ ...e, changes: JSON.parse(e.changes), delivered: Boolean(e.delivered) })),
    close: () => db.close(),
  };
}

// ── the check loop ──────────────────────────────────────────────────────

/** The event body a webhook receives (signed by the caller of deliverWebhook). */
export function changeEvent(watch, { blockNumber, changes, now = Date.now() }) {
  return {
    spec: WATCH_SPEC,
    type: "contract_changed",
    watchId: watch.id,
    chainId: watch.chainId,
    address: watch.address,
    label: watch.label ?? null,
    blockNumber,
    detectedAt: new Date(now).toISOString(),
    changes,
    note: "Detected on a scheduled check after the change happened. Verify on-chain before acting.",
  };
}

/**
 * Check every due watch once. Transport failures leave the last reading in
 * place and are retried on the next cycle; they never produce an event.
 */
export async function runWatchCycle({ store, clientFor, signer, deliver = deliverWebhook, now = Date.now(), intervalMs = WATCH_INTERVAL_MS }) {
  const due = store.due(now, intervalMs);
  let changed = 0;
  for (const w of due) {
    let snap;
    try {
      snap = await readSnapshot(clientFor(w.chainId), w.address);
    } catch (e) {
      store.recordError(w.id, e?.shortMessage || e?.message || "read failed", now);
      continue;
    }
    const facts = snap.ok ? snap.facts : { ...(w.facts ?? {}), codeHash: null };
    const changes = diffFacts(w.facts, facts);
    store.recordCheck(w.id, { now, blockNumber: snap.blockNumber, facts, changeCount: changes.length });
    if (!changes.length) continue;
    changed += 1;
    const event = changeEvent(w, { blockNumber: snap.blockNumber, changes, now });
    let result = await deliver(w.webhook, event, { signer });
    if (!result.ok) result = await deliver(w.webhook, event, { signer });
    store.recordEvent(w.id, { now, blockNumber: snap.blockNumber, changes, delivered: result.ok, status: result.status });
  }
  return { checked: due.length, changed };
}

/** Public status view of one watch: no webhook URL (it may carry a secret). */
export function publicWatch(w, events = []) {
  if (!w) return null;
  let host = null;
  try { host = new URL(w.webhook).host; } catch {}
  return {
    spec: WATCH_SPEC,
    watchId: w.id,
    chainId: w.chainId,
    address: w.address,
    label: w.label ?? null,
    webhookHost: host,
    createdAt: new Date(w.createdAt).toISOString(),
    expiresAt: new Date(w.expiresAt).toISOString(),
    active: w.expiresAt > Date.now(),
    checkEveryMinutes: Math.round(WATCH_INTERVAL_MS / 60000),
    lastCheckAt: w.lastCheckAt ? new Date(w.lastCheckAt).toISOString() : null,
    lastBlock: w.lastBlock,
    lastError: w.lastError,
    facts: w.facts,
    changesDetected: w.changes,
    deliveriesFailed: w.deliveriesFailed,
    recentEvents: events.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    checked: [...WATCH_CHECKED],
    notChecked: [...WATCH_NOT_CHECKED],
  };
}
