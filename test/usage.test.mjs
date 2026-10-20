import assert from "node:assert/strict";
import { recordPreflight, usageSnapshot, resetUsage, clientLabel } from "../src/usage.mjs";

const req = (headers = {}) => ({
  get(name) {
    return headers[String(name).toLowerCase()];
  },
});

const originalLog = console.log;
const events = [];
console.log = (...args) => events.push(args.join(" "));

try {
  resetUsage();

  assert.equal(clientLabel(req({ "x-verify402-client": "mcp/1.0.2", "user-agent": "python" })), "mcp/1.0.2");
  assert.equal(clientLabel(req({ "user-agent": "verify402-mcp/1.0.2" })), "mcp");
  assert.equal(clientLabel(req({ "user-agent": "python-requests/2.32" })), "python");
  assert.equal(clientLabel(req({ "user-agent": "curl/8.7.1" })), "curl");
  assert.equal(clientLabel(req()), "unknown");

  recordPreflight({
    req: req({ "x-verify402-client": "mcp/1.0.2" }),
    result: { kind: "payment", verdict: "PASS", receipt: { signature: "x" } },
    status: 200,
    ms: 12.4,
    now: 1000,
  });
  recordPreflight({
    req: req({ "user-agent": "python-requests/2.32" }),
    result: { kind: "transaction", verdict: "BLOCK", receipt: { signature: "x" } },
    status: 200,
    ms: 20.6,
    now: 2000,
  });
  recordPreflight({
    req: req({}),
    result: null,
    status: 503,
    ms: 2,
    code: "preflight_unavailable",
    now: 3000,
  });

  const snap = usageSnapshot();
  assert.equal(snap.spec, "verify402/usage@1");
  assert.equal(snap.total, 3);
  assert.deepEqual(snap.byVerdict, { PASS: 1, BLOCK: 1, UNAVAILABLE: 1 });
  assert.deepEqual(snap.byKind, { payment: 1, transaction: 1, unknown: 1 });
  assert.deepEqual(snap.byClient, { "mcp/1.0.2": 1, python: 1, unknown: 1 });
  assert.deepEqual(snap.byStatus, { 200: 2, 503: 1 });
  assert.ok(Number.isFinite(Date.parse(snap.since)));
  assert.equal(snap.lastAt, "1970-01-01T00:00:03.000Z");
  assert.match(snap.note, /not a unique agent/);
  assert.equal(events.length, 3);
  assert.ok(events.every((line) => JSON.parse(line).event === "verify402.preflight"));
  assert.ok(events.every((line) => !line.includes("intent")));

  resetUsage();
  const empty = usageSnapshot();
  assert.equal(empty.total, 0);
  assert.equal(empty.lastAt, null);
  console.log = originalLog;
  console.log("usage: 13 passed, 0 failed");
} catch (e) {
  console.log = originalLog;
  console.error(e);
  process.exitCode = 1;
}
