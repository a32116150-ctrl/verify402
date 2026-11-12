import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  protocolHealth,
  inspectEntry,
  diffEntry,
  createDirectory,
} from "../src/directory.mjs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function challenge(overrides = {}, acceptOverrides = {}) {
  return {
    x402Version: 2,
    resource: "https://example.com/paid",
    accepts: [{
      scheme: "exact",
      network: "eip155:84532",
      asset: USDC,
      amount: "30000",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      ...acceptOverrides,
    }],
    ...overrides,
  };
}

function fetchFor(challengeJson) {
  const header = Buffer.from(JSON.stringify(challengeJson)).toString("base64");
  return async () => ({ status: 402, headers: { "payment-required": header }, body: "" });
}

const ENTRY = {
  id: "test",
  name: "Test endpoint",
  url: "https://example.com/paid",
  method: "GET",
  note: "unit test",
};

test("protocolHealth passes a well-formed challenge", () => {
  const health = protocolHealth({ challenge: challenge(), status: 402 });
  assert.equal(health.verdict, "PASS");
  assert.ok(health.checks.includes("accepts"));
  assert.ok(health.checks.includes("resource"));
});

test("protocolHealth blocks a challenge with no accepts", () => {
  const health = protocolHealth({ challenge: { x402Version: 2, accepts: [] }, status: 402 });
  assert.equal(health.verdict, "BLOCK");
  assert.ok(health.reasons.some((r) => r.code === "no_challenge"));
});

test("protocolHealth blocks a missing payee and a zero amount", () => {
  const missingPayee = protocolHealth({ challenge: challenge({}, { payTo: undefined }), status: 402 });
  assert.equal(missingPayee.verdict, "BLOCK");
  assert.ok(missingPayee.reasons.some((r) => r.code === "missing_payee"));

  const zero = protocolHealth({ challenge: challenge({}, { amount: "0" }), status: 402 });
  assert.equal(zero.verdict, "BLOCK");
  assert.ok(zero.reasons.some((r) => r.code === "non_positive_amount"));
});

test("protocolHealth cautions on a non-https resource and duplicate same-network payees", () => {
  const http = protocolHealth({ challenge: challenge({ resource: "http://example.com/paid" }), status: 402 });
  assert.equal(http.verdict, "CAUTION");
  assert.ok(http.reasons.some((r) => r.code === "non_https_resource"));

  const two = challenge();
  two.accepts.push({ ...two.accepts[0], payTo: "0x2222222222222222222222222222222222222222" });
  const split = protocolHealth({ challenge: two, status: 402 });
  assert.ok(split.reasons.some((r) => r.code === "multiple_payees"));
});

test("protocolHealth is network-agnostic about chain support", () => {
  const other = protocolHealth({ challenge: challenge({}, { network: "eip155:4663" }), status: 402 });
  assert.equal(other.verdict, "PASS");
});

test("inspectEntry returns protocol and sign verdicts with the price", async () => {
  const record = await inspectEntry(ENTRY, { fetchImpl: fetchFor(challenge()) });
  assert.equal(record.ok, true);
  assert.equal(record.status, 402);
  assert.equal(record.price, 0.03);
  assert.equal(record.network, "eip155:84532");
  assert.equal(record.protocol.verdict, "PASS");
  assert.equal(record.sign.verdict, "PASS"); // resource matches the inspected URL
});

test("inspectEntry fails closed when the endpoint cannot be read", async () => {
  const record = await inspectEntry(ENTRY, {
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  assert.equal(record.ok, false);
  assert.equal(record.sign.verdict, "BLOCK");
  assert.equal(record.protocol.verdict, "BLOCK");
});

test("diffEntry records price, payee and verdict changes only", () => {
  const before = { status: 402, price: 0.03, payee: "0xaaa", network: "eip155:84532", sign: { verdict: "PASS" }, protocol: { verdict: "PASS" } };
  const after = { ...before, price: 0.05, payee: "0xbbb", measuredAt: "2026-01-01T00:00:00.000Z" };
  const changes = diffEntry(before, after);
  assert.deepEqual(changes.map((c) => c.field).sort(), ["payee", "price"]);
  assert.equal(diffEntry(before, { ...after, price: 0.03, payee: "0xaaa" }).length, 0);
});

test("createDirectory watches entries, records changes, and persists to a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verify402-dir-"));
  const filePath = join(dir, "directory.json");
  try {
    let current = challenge();
    const fetchImpl = async () => {
      const header = Buffer.from(JSON.stringify(current)).toString("base64");
      return { status: 402, headers: { "payment-required": header }, body: "" };
    };
    const entries = [ENTRY, { ...ENTRY, id: "second", url: "https://example.com/other", name: "Second" }];
    const directory = createDirectory({ entries, filePath, fetchImpl });

    const first = await directory.refresh();
    assert.equal(first.entries.length, 2);
    assert.equal(first.entries[0].current.protocol.verdict, "PASS");
    assert.equal(first.entries[0].changes.length, 0);

    // A price change and a payee change must be recorded, not silently rewritten.
    current = challenge({}, { amount: "50000", payTo: "0x2222222222222222222222222222222222222222" });
    const second = await directory.refresh();
    const changed = second.entries[0];
    assert.ok(changed.changes.some((c) => c.field === "price" && c.from === 0.03 && c.to === 0.05));
    assert.ok(changed.changes.some((c) => c.field === "payee"));

    // A new instance on the same file restores history.
    const restored = createDirectory({ entries, filePath, fetchImpl });
    const snapshot = restored.snapshot();
    assert.equal(snapshot.mode, "file");
    assert.equal(snapshot.entries[0].changes.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDirectory keeps history in memory when no file is configured", async () => {
  const directory = createDirectory({ entries: [ENTRY], fetchImpl: fetchFor(challenge()) });
  const snapshot = await directory.refresh();
  assert.equal(snapshot.mode, "memory");
  assert.equal(snapshot.entries.length, 1);
});
