// Behaviour tests for the DURABLE settlement recovery store.
//
// What a restart must never do: allow a second charge for a payment that
// already settled. These tests run real fresh processes against real SQLite
// files (RECOVERY_DB_PATH), including a SIGKILL, a corrupt database, a locked
// database and the mainnet start guard. Uses the scenario fixture
// test/fixtures/recovery-scenario.mjs; each fresh process re-boots
// recovery.mjs from the database exactly like the server does.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initRecoveryStore, loadRecoveryFromDb, closeRecoveryStore } from "../src/recovery-store.mjs";
import { setDurableRecovery, statePersistence, recoveryDoesNotGuarantee, persistenceLine } from "../src/recovery-persistence.mjs";

const root = new URL("..", import.meta.url).pathname;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${passed} - ${name}`);
  } catch (e) {
    console.error(`  FAIL ${passed + 1} - ${name}`);
    throw e;
  }
}

const NODE_OPTIONS = "--no-warnings";
function envFor(dbPath, extra = {}) {
  return {
    ...process.env,
    TEST_OFFLINE: "1",
    NODE_OPTIONS,
    RECOVERY_DB_PATH: dbPath,
    // never inherit a bypass/mainnet mode in fixtures
    X402_MODE: "",
    BYPASS_PAYMENT: "",
    ...extra,
  };
}

function runFixture(dir, scenario, args, extra = {}) {
  const dbPath = join(dir, "recovery.sqlite");
  const r = spawnSync(process.execPath, [join(root, "test/fixtures/recovery-scenario.mjs"), scenario, ...args], {
    cwd: root,
    env: envFor(dbPath, extra),
    encoding: "utf8",
    timeout: 60000,
  });
  const lines = String(r.stdout || "").split("\n").filter((l) => l.startsWith("RESULT "));
  const result = lines.length ? JSON.parse(lines[lines.length - 1].slice(7)) : null;
  return { status: r.status, result, stderr: String(r.stderr || ""), stdout: String(r.stdout || "") };
}

function freshDir(label) {
  return mkdtempSync(join(tmpdir(), `verify402-recovery-${label}-`));
}

function dbEntry(dbPath, key) {
  closeRecoveryStore();
  const opened = initRecoveryStore(dbPath);
  assert.equal(opened.ok, true, `driver could not reopen ${dbPath}`);
  const loaded = loadRecoveryFromDb();
  assert.notEqual(loaded, null, "driver loadRecoveryFromDb failed");
  let entry = null;
  for (const [opId, aliasKeys] of loaded.aliases) {
    if (aliasKeys.includes(key)) entry = loaded.entries.get(opId);
  }
  return { loaded, entry };
}

// The driver itself must NOT have the store enabled (fixtures own their own).
assert.equal(process.env.RECOVERY_DB_PATH, undefined, "driver must run without RECOVERY_DB_PATH");

// ---------------------------------------------------------------- tests ----

// Write-ahead: the staged record is on disk immediately after stage — BEFORE
// any promotion — so the settlement call can never run unjournaled.
{
  const dir = freshDir("writeahead");
  const dbPath = join(dir, "recovery.sqlite");
  const r = runFixture(dir, "stage-only", ["wa-key", String(Math.floor(Date.now() / 1000) - 3600)]);
  check("stage-only fixture ran clean", () => assert.equal(r.status, 0, r.stderr));
  const { entry } = dbEntry(dbPath, "wa-key");
  check("WRITE-AHEAD: staged row committed to disk before promotion", () => {
    assert.notEqual(entry, null, "staged row must exist on disk right after recordSettlement");
    assert.equal(entry.settled, false);
    assert.equal(typeof entry.payload.recovery.operationId, "string");
    assert.equal(entry.paymentRef.payer, "0x1111111111111111111111111111111111111111");
  });
}

// (a) A settled payment is still recognized after a simulated restart.
{
  const dir = freshDir("settled");
  const dbPath = join(dir, "recovery.sqlite");
  const stage = runFixture(dir, "stage-settled", ["settled-key"]);
  check("stage-settled promoted exactly once", () => {
    assert.equal(stage.status, 0, stage.stderr);
    assert.equal(stage.result.promoted, 1);
  });
  const lookup = runFixture(dir, "lookup", ["settled-key", "/verify", JSON.stringify({ target: "WETH", base: "USDC", size: 1000 })]);
  check("RESTART: settled payment replays with the original payload", () => {
    assert.equal(lookup.status, 0, lookup.stderr);
    assert.ok(lookup.result.result?.hit, "expected a replay hit");
    assert.equal(lookup.result.result.hit.payload.verdict, "no_edge");
    assert.equal(lookup.result.result.hit.payload.recovery.operationId, stage.result.opId);
  });
  const replay = runFixture(dir, "replay", ["settled-key"]);
  check("RESTART: replay counter is durable — fresh processes keep counting from the DB", () => {
    // the lookup process above consumed one replay, this one the next
    assert.equal(replay.result.hit.replays, 2);
  });
}

// (b) A staged but unconfirmed record after a restart: pending, never
// replayable, and reconciled on-chain before it may ever expire.
{
  const dir = freshDir("staged");
  const dbPath = join(dir, "recovery.sqlite");
  const validBefore = Math.floor(Date.now() / 1000) - 3600; // deadline already past
  const stage = runFixture(dir, "stage-only", ["staged-key", String(validBefore)]);
  assert.equal(stage.status, 0, stage.stderr);

  const lookup = runFixture(dir, "lookup", ["staged-key", "/verify", JSON.stringify({ target: "WETH", base: "USDC", size: 1000 })]);
  check("RESTART: staged-but-unconfirmed is pending, not replayable", () => {
    assert.equal(lookup.result.result.pending, "settlement_pending");
  });
  const replay = runFixture(dir, "replay", ["staged-key"]);
  check("RESTART: staged-but-unconfirmed must NOT replay", () => {
    assert.equal(replay.result.hit, null);
  });

  const consumed = runFixture(dir, "reconcile", ["staged-key", stage.result.opId, "consumed"]);
  check("RECONCILE: authorization consumed -> promoted, verdict replayable", () => {
    assert.equal(consumed.result.r, "settled");
    assert.equal(consumed.result.lookup.hit.payload.verdict, "no_edge");
  });
  const after = runFixture(dir, "replay", ["staged-key"]);
  check("RECONCILE: promoted verdict survives another restart", () => {
    // the reconcile process above consumed one replay, this one the next
    assert.equal(after.result.hit.replays, 2);
  });}

{
  const dir = freshDir("staged-free");
  const validBefore = Math.floor(Date.now() / 1000) - 3600;
  const stage = runFixture(dir, "stage-only", ["free-key", String(validBefore)]);
  assert.equal(stage.status, 0, stage.stderr);
  const unconsumed = runFixture(dir, "reconcile", ["free-key", stage.result.opId, "unconsumed"]);
  check("RECONCILE: not consumed past validBefore -> safe to expire (nothing settled)", () => {
    assert.equal(unconsumed.result.r, "expired_safe");
    assert.equal(unconsumed.result.lookup, null); // retry reaches the paywall and pays — correct
  });
}

{
  const dir = freshDir("staged-err");
  const validBefore = Math.floor(Date.now() / 1000) - 3600;
  const stage = runFixture(dir, "stage-only", ["err-key", String(validBefore)]);
  assert.equal(stage.status, 0, stage.stderr);
  const errored = runFixture(dir, "reconcile", ["err-key", stage.result.opId, "error"]);
  check("RECONCILE FAIL-CLOSED: check error -> record stays pending, never expires into charge-again", () => {
    assert.equal(errored.result.r, "failed");
    assert.ok(errored.result.lookup?.pending, "must stay pending");
  });
}

{
  const dir = freshDir("staged-absent");
  const validBefore = Math.floor(Date.now() / 1000) - 3600;
  const stage = runFixture(dir, "stage-only", ["absent-key", String(validBefore)]);
  assert.equal(stage.status, 0, stage.stderr);
  const absent = runFixture(dir, "reconcile", ["absent-key", stage.result.opId, "absent"]);
  check("RECONCILE FAIL-CLOSED: no checker wired -> stays pending (Solana-shaped record)", () => {
    assert.equal(absent.result.r, "unavailable");
    assert.ok(absent.result.lookup?.pending, "must stay pending");
  });
}

// (c) TTL and tombstone expiry still work — durably.
{
  const dir = freshDir("ttl");
  const dbPath = join(dir, "recovery.sqlite");
  const stage = runFixture(dir, "stage-settled", ["ttl-key"]);
  assert.equal(stage.status, 0, stage.stderr);

  const expired = runFixture(dir, "set-now", ["600001", "replay", "ttl-key"]);
  check("TTL: settled verdict stops replaying after the 10-minute TTL", () => {
    assert.equal(expired.result.hit, null);
  });
  const tomb = runFixture(dir, "set-now", ["600001", "tombstone", "ttl-key"]);
  check("TTL: the expired verdict leaves a tombstone with the response hash", () => {
    assert.equal(tomb.result.info.previousResponseHash, stage.result.responseHash);
    assert.ok(tomb.result.info.expiredAt);
  });
  const survived = runFixture(dir, "tombstone", ["ttl-key"]);
  check("RESTART: the tombstone survives a restart (durable mirror)", () => {
    assert.ok(survived.result.info?.previousResponseHash);
  });
  const gone = runFixture(dir, "set-now", [String(6 * 3600 * 1000 + 600001), "tombstone", "ttl-key"]);
  check("TOMBSTONE: expires after the 6-hour remeasure window", () => {
    assert.equal(gone.result.info, null);
  });
  const stillGone = runFixture(dir, "tombstone", ["ttl-key"]);
  check("TOMBSTONE: expiry is durable — gone after another restart too", () => {
    assert.equal(stillGone.result.info, null);
  });
}

// (d) A corrupted database fails safe: refuses to charge again, clear error.
{
  const dir = freshDir("corrupt");
  const dbPath = join(dir, "recovery.sqlite");
  writeFileSync(dbPath, Buffer.from("this is not a sqlite database, it is 512+ bytes of junk".repeat(12), "utf8"));
  const health = runFixture(dir, "health", ["corrupt-key"]);
  check("CORRUPT DB: store refuses to open and the stage fails CLOSED (RecoveryStoreError)", () => {
    assert.equal(health.result.health.enabled, false);
    assert.equal(health.result.health.healthy, false);
    assert.ok(health.result.health.failedToOpen);
    assert.deepEqual(health.result.threw, { name: "RecoveryStoreError", code: "recovery_unavailable" });
  });
}

// (d) A locked database fails safe: busy timeout, then a clear typed error.
{
  const dir = freshDir("locked");
  const dbPath = join(dir, "recovery.sqlite");
  const stage = runFixture(dir, "stage-only", ["seed-key", String(Math.floor(Date.now() / 1000) - 3600)]);
  assert.equal(stage.status, 0, stage.stderr);
  // Hold an exclusive transaction on the file, then make a fresh process try
  // to journal a payment. It must time out (busy) and fail closed.
  const blocker = new DatabaseSync(dbPath);
  blocker.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE;");
  const child = spawn(process.execPath, [join(root, "test/fixtures/recovery-scenario.mjs"), "health", "locked-key"], {
    cwd: root,
    env: envFor(dbPath),
    encoding: "utf8",
  });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  blocker.exec("ROLLBACK");
  blocker.close();
  check("LOCKED DB: journaling fails closed with RecoveryStoreError (busy timeout, no silent fallback)", () => {
    const lines = stdout.split("\n").filter((l) => l.startsWith("RESULT "));
    const result = JSON.parse(lines[lines.length - 1].slice(7));
    assert.equal(code, 0);
    assert.deepEqual(result.threw, { name: "RecoveryStoreError", code: "recovery_unavailable" });
  });
}

// (e) A child process journals a staged row, is SIGKILLed, and a fresh
// process loads the committed row: no double charge, no lost verdict.
{
  const dir = freshDir("sigkill");
  const dbPath = join(dir, "recovery.sqlite");
  const child = spawn(process.execPath, [join(root, "test/fixtures/recovery-scenario.mjs"), "stage-and-hold", "kill-key", String(Math.floor(Date.now() / 1000) - 3600)], {
    cwd: root,
    env: envFor(dbPath),
    encoding: "utf8",
  });
  const opId = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture never printed HOLDING")), 15000);
    child.stdout.on("data", (d) => {
      const m = String(d).match(/HOLDING ([0-9a-f-]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on("close", () => {});
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("close", resolve));

  const { entry } = dbEntry(dbPath, "kill-key");
  check("SIGKILL: the committed staged row survives the kill (synchronous=FULL)", () => {
    assert.notEqual(entry, null);
    assert.equal(entry.settled, false);
    assert.equal(entry.payload.recovery.operationId, opId);
  });
  const lookup = runFixture(dir, "lookup", ["kill-key", "/verify", JSON.stringify({ target: "WETH", base: "USDC", size: 1000 })]);
  check("SIGKILL: a fresh process treats the staged record as pending — never a free replay", () => {
    assert.equal(lookup.result.result.pending, "settlement_pending");
  });
}

// (f) Mainnet refuses to start without an explicit, openable RECOVERY_DB_PATH.
{
  const mainnetEnv = {
    X402_MODE: "mainnet",
    MAINNET_ALWAYS_ON_CONFIRMED: "yes",
    AGENT_URL: "https://verify402.example",
    PREFLIGHT_SECRET: "s".repeat(32),
    FACILITATOR_URL: "https://facilitator.payai.network",
    TEST_OFFLINE: "1",
    NODE_OPTIONS,
    // RECOVERY_DB_PATH deliberately absent
  };
  const refused = spawnSync(process.execPath, ["src/server.mjs"], { cwd: root, env: { ...process.env, ...mainnetEnv }, encoding: "utf8", timeout: 30000 });
  check("MAINNET GUARD: no RECOVERY_DB_PATH -> REFUSING TO START (exit 1)", () => {
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /REFUSING TO START/);
    assert.match(refused.stdout + refused.stderr, /RECOVERY_DB_PATH/);
  });

  // Positive control: with the store set, the server reaches listening.
  const dir = freshDir("mainnet-ok");
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: envFor(join(dir, "recovery.sqlite"), mainnetEnv),
    encoding: "utf8",
  });
  const listening = await new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve(false), 20000);
    child.stdout.on("data", (d) => {
      buf += String(d);
      if (buf.includes("listening on")) { clearTimeout(timer); resolve(true); }
    });
    child.on("close", () => {});
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("close", resolve));
  check("MAINNET GUARD: with RECOVERY_DB_PATH the server starts", () => {
    assert.equal(listening, true);
  });
}

// The public contract must describe the mode the process actually runs in.
// /info, /openapi.json and /.well-known/verify402.json all read this module,
// so a durable instance can never keep advertising memory-only semantics.
{
  setDurableRecovery(false);
  check("CONTRACT: without a durable store the published state is process-local", () => {
    const p = statePersistence();
    assert.equal(p.scope, "process-local");
    assert.equal(p.lostOnRestart, true);
    assert.match(p.warning, /process-local/i);
    assert.match(recoveryDoesNotGuarantee(), /does not survive a restart/i);
    assert.match(persistenceLine(), /process-local/i);
  });
  setDurableRecovery(true);
  check("CONTRACT: a healthy durable store flips every published surface", () => {
    const p = statePersistence();
    assert.equal(p.scope, "durable-single-instance");
    assert.equal(p.lostOnRestart, false);
    assert.match(p.warning, /SQLite/i);
    assert.match(p.warning, /one server process per database file/i);
    assert.match(recoveryDoesNotGuarantee(), /durable for the verdict record/i);
    assert.match(recoveryDoesNotGuarantee(), /\/usage counters stay process-local/i);
    assert.match(persistenceLine(), /durable SQLite store/i);
  });
  setDurableRecovery(false);
}

console.log(`\nrecovery-durable: ${passed} checks passed`);
