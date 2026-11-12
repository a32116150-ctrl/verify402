// Crash matrix for the durable recovery store.
//
// Each case kills a real process at one durable write — before or after SQLite
// commits it — then starts a fresh process over the same database and asks what
// the caller would see. The invariants:
//
//   * at most one charge per payment
//   * at most one handler run per payment
//   * a free replay only when the settlement was durably promoted
//   * a charge always leaves a recoverable (staged) or settled record behind
//   * a staged record is pending, never replayable
//   * an expired verdict never replays
//
// The kill points live in src/recovery-store.mjs behind VERIFY402_CRASH_AT and
// are inert unless this test sets them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const fixture = join(root, "test/fixtures/recovery-crash.mjs");
const MINUTE = 60 * 1000;

function freshDir() {
  return mkdtempSync(join(tmpdir(), "verify402-crash-"));
}

function countLines(dir, file) {
  try {
    return readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function run(dir, scenario, { key, crash = "", clockOffset = 0 } = {}) {
  const r = spawnSync(process.execPath, [fixture, scenario, key], {
    cwd: root,
    env: {
      ...process.env,
      TEST_OFFLINE: "1",
      NODE_OPTIONS: "--no-warnings",
      RECOVERY_DB_PATH: join(dir, "recovery.sqlite"),
      RECOVERY_MARKER_DIR: dir,
      VERIFY402_CRASH_AT: crash,
      RECOVERY_CLOCK_OFFSET_MS: String(clockOffset),
      X402_MODE: "",
      BYPASS_PAYMENT: "",
    },
    encoding: "utf8",
    timeout: 60000,
  });
  const lines = String(r.stdout || "").split("\n").filter((line) => line.startsWith("RESULT "));
  return {
    signal: r.signal,
    status: r.status,
    result: lines.length ? JSON.parse(lines[lines.length - 1].slice(7)) : null,
    stderr: String(r.stderr || ""),
  };
}

const cases = [
  { name: "stage crash before durable", scenario: "success", crash: "stage:before", charges: 0, lookup: "none" },
  { name: "stage crash after durable", scenario: "success", crash: "stage:after", charges: 0, lookup: "pending" },
  { name: "charged, reply lost before promote", scenario: "success", crash: "promote:before", charges: 1, lookup: "pending" },
  { name: "promoted, killed before the response", scenario: "success", crash: "promote:after", charges: 1, lookup: "hit", replay: true },
  { name: "settle hangs after staging", scenario: "hang", crash: "stage:after", charges: 0, lookup: "pending" },
  { name: "definitive fail, killed before abandon", scenario: "fail", crash: "abandon:before", charges: 0, lookup: "pending" },
  { name: "definitive fail, abandoned", scenario: "fail", crash: "abandon:after", charges: 0, lookup: "none" },
  { name: "expiry, killed before tombstone", scenario: "expire", crash: "tombstone:before", charges: 1, replay: false, clockOffset: 11 * MINUTE + 5000 },
  { name: "expiry, killed before evict", scenario: "expire", crash: "evict:before", charges: 1, replay: false, clockOffset: 11 * MINUTE + 5000 },
  { name: "expiry, evicted", scenario: "expire", crash: "evict:after", charges: 1, replay: false, clockOffset: 11 * MINUTE + 5000 },
];

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok ${passed} - ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${passed + 1} - ${name}\n      ${e.stack || e.message}`);
  }
}

for (const [index, c] of cases.entries()) {
  check(c.name, () => {
    const dir = freshDir();
    const key = `crash-${index}-${Date.now()}`;

    const killed = run(dir, c.scenario, { key, crash: c.crash });
    assert.equal(killed.signal, "SIGKILL", `expected the ${c.crash} write to kill the process, got signal=${killed.signal} status=${killed.status}\n${killed.stderr}`);
    assert.equal(countLines(dir, "handler.log"), 1, "the handler must run once in the first process");

    const resumed = run(dir, "resume", { key, clockOffset: c.clockOffset || 0 });
    assert.equal(resumed.status, 0, `resume must exit cleanly\n${resumed.stderr}`);
    assert.ok(resumed.result, "resume must print a result");

    assert.equal(countLines(dir, "handler.log"), 1, "resume must not run the handler");
    assert.equal(countLines(dir, "charge.log"), c.charges, "charge count must match the expected outcome");

    if (c.lookup === "none") {
      assert.equal(resumed.result.lookup, null, "no record means a fresh payment is allowed, never a replay");
    } else if (c.lookup === "pending") {
      assert.ok(resumed.result.lookup, "a staged record must be visible as pending");
      assert.equal(resumed.result.lookup.hit, false, "a staged record must never replay");
      assert.ok(resumed.result.lookup.pending, "a staged record must report a pending reason");
    } else if (c.lookup === "hit") {
      assert.equal(resumed.result.lookup?.hit, true, "a durably promoted record must replay");
      assert.ok(resumed.result.replay?.responseHash, "the replay must carry the recorded hash");
    }

    if (c.replay === false) {
      assert.equal(resumed.result.replay, null, "an expired verdict must not replay");
    }
  });
}

console.log(`\ncrash matrix: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
