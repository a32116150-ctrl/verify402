// Contract watch: readings, change detection, storage and the check loop,
// against a fake chain. No network.
import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "viem";
import {
  readSnapshot, diffFacts, openWatchStore, runWatchCycle, validateWebhook, publicWatch, WATCH_DAYS,
} from "../src/watch.mjs";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADDR = "0x1111111111111111111111111111111111111111";
const IMPL_A = "0x2222222222222222222222222222222222222222";
const IMPL_B = "0x3333333333333333333333333333333333333333";
const OWNER_A = "0x4444444444444444444444444444444444444444";
const OWNER_B = "0x5555555555555555555555555555555555555555";
const word = (addr) => `0x${"0".repeat(24)}${addr.slice(2)}`;

function fakeChain(state) {
  return {
    async getBlockNumber() { return 100n; },
    async getCode({ address }) {
      if (state.down) throw new Error("rpc down");
      return state.code[address.toLowerCase()] ?? "0x";
    },
    async getStorageAt({ address, slot }) {
      if (state.down) throw new Error("rpc down");
      if (address.toLowerCase() === ADDR && slot === IMPL_SLOT && state.impl) return word(state.impl);
      return `0x${"0".repeat(64)}`;
    },
    async call({ to, data }) {
      if (state.down) throw new Error("rpc down");
      const t = to.toLowerCase();
      if (data === "0x8da5cb5b" && (t === ADDR || t === state.impl) && state.owner) return { data: word(state.owner) };
      if (data === "0x5c975abb" && t === ADDR && state.paused != null) return { data: `0x${"0".repeat(63)}${state.paused ? 1 : 0}` };
      throw new Error("execution reverted");
    },
  };
}

const baseState = () => ({
  code: { [ADDR]: "0x6001", [IMPL_A]: "0x6002", [IMPL_B]: "0x6003" },
  impl: IMPL_A,
  owner: OWNER_A,
  paused: false,
});

test("reading: proxy facts, implementation code hash, owner and paused", async () => {
  const s = await readSnapshot(fakeChain(baseState()), ADDR);
  assert.equal(s.ok, true);
  assert.equal(s.facts.codeHash, keccak256("0x6001"));
  assert.equal(s.facts.upgradeable, true);
  assert.equal(s.facts.implementation, IMPL_A);
  assert.equal(s.facts.implementationCodeHash, keccak256("0x6002"));
  assert.equal(s.facts.owner, OWNER_A);
  assert.equal(s.facts.paused, false);
});

test("reading: an address with no code is not a contract", async () => {
  const s = await readSnapshot(fakeChain(baseState()), "0x9999999999999999999999999999999999999999");
  assert.deepEqual([s.ok, s.reason], [false, "no_contract"]);
});

test("diff: only changed fields, in a fixed order", () => {
  const a = { codeHash: "0x1", implementation: IMPL_A, owner: OWNER_A, paused: false };
  const b = { codeHash: "0x1", implementation: IMPL_B, owner: OWNER_B, paused: false };
  assert.deepEqual(diffFacts(a, b), [
    { field: "implementation", from: IMPL_A, to: IMPL_B },
    { field: "owner", from: OWNER_A, to: OWNER_B },
  ]);
  assert.deepEqual(diffFacts(a, a), []);
});

test("cycle: an upgrade is detected once, delivered signed, and stored", async () => {
  const state = baseState();
  const store = openWatchStore();
  const t0 = 1_000_000;
  const snap = await readSnapshot(fakeChain(state), ADDR);
  const w = store.add({ chainId: 1, address: ADDR, webhook: "https://hooks.example/x", now: t0, snapshot: snap });
  assert.equal(w.expiresAt - w.createdAt, WATCH_DAYS * 86_400_000);

  const sent = [];
  const deliver = async (url, event, { signer }) => { sent.push({ url, event, signed: Boolean(signer) }); return { ok: true, status: 200 }; };
  const signer = { sign: (x) => x };

  // Not due yet: nothing is read.
  let r = await runWatchCycle({ store, clientFor: () => fakeChain(state), signer, deliver, now: t0 + 1000, intervalMs: 60_000 });
  assert.equal(r.checked, 0);

  // Upgrade + owner change.
  state.impl = IMPL_B;
  state.owner = OWNER_B;
  r = await runWatchCycle({ store, clientFor: () => fakeChain(state), signer, deliver, now: t0 + 61_000, intervalMs: 60_000 });
  assert.deepEqual(r, { checked: 1, changed: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://hooks.example/x");
  assert.equal(sent[0].signed, true);
  assert.equal(sent[0].event.type, "contract_changed");
  assert.deepEqual(sent[0].event.changes.map((c) => c.field), ["implementation", "implementationCodeHash", "upgradeController", "owner"]);

  // Same state again: no second event.
  r = await runWatchCycle({ store, clientFor: () => fakeChain(state), signer, deliver, now: t0 + 122_000, intervalMs: 60_000 });
  assert.deepEqual(r, { checked: 1, changed: 0 });
  assert.equal(sent.length, 1);

  const view = publicWatch(store.get(w.id), store.events(w.id));
  assert.equal(view.changesDetected, 1);
  assert.equal(view.recentEvents.length, 1);
  assert.equal(view.webhookHost, "hooks.example");
  assert.ok(!JSON.stringify(view).includes("hooks.example/x"), "the full webhook URL is never shown");
});

test("cycle: a chain read failure keeps the last reading and sends nothing", async () => {
  const state = baseState();
  const store = openWatchStore();
  const snap = await readSnapshot(fakeChain(state), ADDR);
  const w = store.add({ chainId: 1, address: ADDR, webhook: "https://hooks.example/x", now: 0, snapshot: snap });
  state.down = true;
  let sent = 0;
  const r = await runWatchCycle({ store, clientFor: () => fakeChain(state), signer: null, deliver: async () => { sent++; return { ok: true }; }, now: 10_000_000, intervalMs: 60_000 });
  assert.deepEqual(r, { checked: 1, changed: 0 });
  assert.equal(sent, 0);
  const after = store.get(w.id);
  assert.deepEqual(after.facts, snap.facts);
  assert.match(after.lastError, /rpc down/);
});

test("cycle: a failed delivery is retried once and counted", async () => {
  const state = baseState();
  const store = openWatchStore();
  const snap = await readSnapshot(fakeChain(state), ADDR);
  const w = store.add({ chainId: 1, address: ADDR, webhook: "https://hooks.example/x", now: 0, snapshot: snap });
  state.paused = true;
  let tries = 0;
  await runWatchCycle({ store, clientFor: () => fakeChain(state), signer: null, deliver: async () => { tries++; return { ok: false, status: 500 }; }, now: 10_000_000, intervalMs: 60_000 });
  assert.equal(tries, 2);
  assert.equal(store.get(w.id).deliveriesFailed, 1);
  assert.equal(store.events(w.id)[0].delivered, false);
});

test("webhook: https and a public address only", async () => {
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  const priv = async () => [{ address: "10.0.0.5", family: 4 }];
  assert.equal(await validateWebhook("https://hooks.example/a?k=1", { resolveHost: pub }), "https://hooks.example/a?k=1");
  await assert.rejects(validateWebhook("http://hooks.example/a", { resolveHost: pub }), { code: "invalid_webhookUrl" });
  await assert.rejects(validateWebhook("https://hooks.example/a", { resolveHost: priv }), { code: "invalid_webhookUrl" });
  await assert.rejects(validateWebhook("not a url"), { code: "invalid_webhookUrl" });
});

test("payment: a pending watch is never checked; settlement switches it on once", async () => {
  const { activateFromSettlement, WATCH_SPEC } = await import("../src/watch.mjs");
  const state = baseState();
  const store = openWatchStore();
  const snap = await readSnapshot(fakeChain(state), ADDR);
  const T0 = Date.now();
  const w = store.add({ chainId: 1, address: ADDR, webhook: "https://hooks.example/x", now: T0, snapshot: snap, pending: true });
  assert.equal(publicWatch(store.get(w.id)).status, "pending_payment");

  state.paused = true;
  let r = await runWatchCycle({ store, clientFor: () => fakeChain(state), signer: null, deliver: async () => ({ ok: true }), now: T0 + 120_000, intervalMs: 60_000 });
  assert.equal(r.checked, 0, "pending watches are not checked");

  const body = Buffer.from(JSON.stringify({ ok: true, spec: WATCH_SPEC, watchId: w.id }));
  // A failed settlement, another route's answer, or a non-final phase: no change.
  assert.equal(activateFromSettlement(store, { phase: "after-handler", result: { success: false }, transportContext: { responseBody: body } }), false);
  assert.equal(activateFromSettlement(store, { phase: "after-handler", result: { success: true }, transportContext: { responseBody: Buffer.from('{"ok":true}') } }), false);
  assert.equal(activateFromSettlement(store, { phase: "before-handler", result: { success: true }, transportContext: { responseBody: body } }), false);
  assert.equal(store.get(w.id).pending, true);

  assert.equal(activateFromSettlement(store, { phase: "after-handler", result: { success: true, transaction: "0xabc" }, transportContext: { responseBody: body } }), true);
  assert.equal(activateFromSettlement(store, { phase: "after-handler", result: { success: true, transaction: "0xabc" }, transportContext: { responseBody: body } }), false, "only once");
  const after = store.get(w.id);
  assert.deepEqual([after.pending, after.paymentTx], [false, "0xabc"]);
  assert.equal(publicWatch(after).status, "active");

  r = await runWatchCycle({ store, clientFor: () => fakeChain(state), signer: null, deliver: async () => ({ ok: true }), now: T0 + 120_000, intervalMs: 60_000 });
  assert.equal(r.checked, 1);
});

test("storage: an older watch database gains the pending columns, existing watches stay active", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "watch-")), "watch.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE watches (id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, address TEXT NOT NULL, webhook TEXT NOT NULL, label TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_check_at INTEGER, last_block TEXT, facts TEXT, last_error TEXT,
    changes INTEGER NOT NULL DEFAULT 0, deliveries_failed INTEGER NOT NULL DEFAULT 0)`);
  old.prepare("INSERT INTO watches (id, chain_id, address, webhook, created_at, expires_at, facts) VALUES (?, 1, ?, ?, 0, ?, '{}')")
    .run("w_old", ADDR, "https://hooks.example/x", Date.now() + 86_400_000);
  old.close();
  const store = openWatchStore(path);
  assert.equal(store.get("w_old").pending, false);
  assert.equal(store.due(Date.now(), 0).length, 1);
  store.close();
});
