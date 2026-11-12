import assert from "node:assert/strict";
import { recordPreflight, recordToolPing, usageSnapshot, resetUsage, initUsage, flushUsage, clientLabel, clientInfo } from "../src/usage.mjs";

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
  assert.deepEqual(
    clientInfo(req({ "x-verify402-client": "mcp/1.0.2", "user-agent": "python" })),
    { label: "mcp/1.0.2", source: "declared" },
  );
  assert.equal(clientLabel(req({ "x-verify402-client": "Verify402-MCP/1.0.8" })), "verify402-mcp/1.0.8");
  assert.equal(clientLabel(req({ "x-verify402-client": "bad label" })), "other");
  assert.equal(clientLabel(req({ "user-agent": "verify402-mcp/1.0.2" })), "mcp/1.0.2");
  assert.deepEqual(
    clientInfo(req({ "user-agent": "verify402-mcp/1.0.2" })),
    { label: "mcp/1.0.2", source: "user-agent" },
  );
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
  assert.deepEqual(snap.byClientSource, { declared: 1, "user-agent": 1, unknown: 1 });
  assert.deepEqual(snap.byStatus, { 200: 2, 503: 1 });
  assert.ok(Number.isFinite(Date.parse(snap.since)));
  assert.equal(snap.lastAt, "1970-01-01T00:00:03.000Z");
  assert.match(snap.note, /not a unique agent/);
  assert.match(snap.note, /self-declared/);
  assert.equal(events.length, 3);
  assert.ok(events.every((line) => JSON.parse(line).event === "verify402.preflight"));
  assert.ok(events.every((line) => !line.includes("intent")));
  assert.deepEqual(
    events.map((line) => JSON.parse(line).clientSource),
    ["declared", "user-agent", "unknown"],
  );

  resetUsage();
  for (let i = 0; i < 40; i++) {
    recordPreflight({
      req: req({ "x-verify402-client": `agent-${i}` }),
      result: { kind: "payment", verdict: "PASS", receipt: { signature: "x" } },
      status: 200,
      ms: 1,
      now: 4000 + i,
    });
  }
  const capped = usageSnapshot();
  assert.equal(capped.total, 40);
  assert.ok(Object.keys(capped.byClient).length <= 32);
  assert.ok(capped.byClient.other >= 1);
  assert.equal(Object.values(capped.byClient).reduce((a, b) => a + b, 0), 40);

  resetUsage();
  const empty = usageSnapshot();
  assert.equal(empty.total, 0);
  assert.equal(empty.lastAt, null);
  assert.deepEqual(empty.byClientSource, {});

  // Persistence: counters survive a simulated restart when a file is configured.
  const { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "verify402-usage-"));
  try {
    const file = join(dir, "usage.json");
    initUsage({ path: file });
    recordPreflight({
      req: req({ "x-verify402-client": "mcp/1.1.0" }),
      result: { kind: "payment", verdict: "PASS", receipt: { signature: "x" } },
      status: 200,
      ms: 3,
      now: 9000,
    });
    flushUsage();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.total, 1);
    assert.deepEqual(onDisk.byTool, {});

    // Simulate a restart: zero in memory, restore from disk.
    resetUsage();
    initUsage({ path: file });
    const again = usageSnapshot();
    assert.equal(again.total, 1);
    assert.equal(again.byClient["mcp/1.1.0"], 1);
    assert.equal(again.scope, "persisted; totals survive restart and deploy");

    // Corrupt file: fresh window, no throw.
    writeFileSync(file, "{ definitely not json", "utf8");
    resetUsage();
    initUsage({ path: file });
    const healed = usageSnapshot();
    assert.equal(healed.total, 0);
    assert.ok(healed.file);

    // Ping recorder: counts byTool, mcp-ping source, and refuses unknown names.
    const ping = recordToolPing({ tool: "preflight_gate", ok: true, client: "verify402-mcp/1.1.0", now: 10000 });
    assert.equal(ping.tool, "preflight_gate");
    const snapped = usageSnapshot();
    assert.equal(snapped.byTool.preflight_gate, 1);
    assert.equal(snapped.byClientSource["mcp-ping"], 1);
    assert.equal(snapped.byStatus[200], 1);
    assert.equal(recordToolPing({ tool: "not a tool!!", ok: true }), null);

    flushUsage();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).byTool.preflight_gate, 1);
  } finally {
    resetUsage();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log = originalLog;
  console.log("usage: 37 passed");
} catch (e) {
  console.log = originalLog;
  console.error(e);
  process.exitCode = 1;
}
