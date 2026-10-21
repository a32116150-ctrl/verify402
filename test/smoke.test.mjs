import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl, runSmoke } from "../scripts/smoke.mjs";

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

// Map-like headers support .get
function withGet(res) {
  const map = res.headers instanceof Map ? res.headers : new Map(Object.entries(res.headers));
  res.headers = { get: (name) => map.get(name.toLowerCase()) ?? map.get(name) ?? null };
  return res;
}

test("normalizeBaseUrl strips trailing slashes and defaults", () => {
  assert.equal(normalizeBaseUrl("http://example.com/"), "http://example.com");
  assert.equal(normalizeBaseUrl("http://example.com///"), "http://example.com");
  assert.equal(normalizeBaseUrl(""), "https://verify402.onrender.com");
});

test("runSmoke returns ok:false when a check fails", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return withGet(jsonResponse(200, { ok: true, mode: "testnet" }));
    if (url.endsWith("/ready")) return withGet(jsonResponse(200, { ok: true, ready: true, blockNumber: 123 }));
    if (url.includes("/preflight") && !url.includes("/verify")) {
      // missing chain test expects 400
      if (JSON.parse((await (async () => null)()) || "{}")) { }
    }
    return withGet(jsonResponse(500, { error: "boom" }));
  };
  // Simpler: just fail /health by returning not ok
  const failingFetch = async (url) => {
    if (url.endsWith("/health")) return withGet(jsonResponse(500, { ok: false }));
    return withGet(jsonResponse(200, { ok: true, ready: true, blockNumber: 1, verdict: "CAUTION", receipt: {}, checked: [], notChecked: [] }));
  };
  const result = await runSmoke({ baseUrl: "http://example.test", env: {}, fetchImpl: failingFetch, log: () => {} });
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
});

test("runSmoke returns ok:true when all mocked checks pass", async () => {
  const okResponse = (url) => {
    if (url.endsWith("/health")) return withGet(jsonResponse(200, { ok: true, mode: "testnet" }));
    if (url.endsWith("/ready")) return withGet(jsonResponse(200, { ok: true, ready: true, blockNumber: 123 }));
    if (url.includes("/preflight/verify")) return withGet(jsonResponse(200, { valid: true }));
    if (url.includes("/preflight")) {
      const body = JSON.parse; // placeholder
      return withGet(jsonResponse(200, { verdict: "CAUTION", receipt: { hmac: "x" }, checked: ["a"], notChecked: ["b"] }));
    }
    if (url.includes("/verify") && url.includes("idempotency-key")) {
      // weak key path uses POST /verify with header; handled by method not url; fallback 400
    }
    if (url.endsWith("/.well-known/agent-card.json")) return withGet(jsonResponse(200, "example.test host"));
    // default for POST /verify without payment: 402
    if (url.endsWith("/verify")) return withGet(jsonResponse(402, { x402Version: 2, accepts: [] }));
    // weak key: status 400
    return withGet(jsonResponse(400, { code: "weak_idempotency_key" }));
  };
  // The weak-key check sends POST /verify with empty body and header; our mock cannot distinguish easily.
  // Instead, make every /verify return 402 and accept weak-key failure? That would fail.
  // So this test only checks parsing/exit-code plumbing with a permissive mock.
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/health")) return withGet(jsonResponse(200, { ok: true, mode: "testnet" }));
    if (u.endsWith("/ready")) return withGet(jsonResponse(200, { ok: true, ready: true, blockNumber: 123 }));
    if (u.includes("/preflight/verify")) return withGet(jsonResponse(200, { valid: true }));
    if (u.includes("/preflight")) {
      const bodyText = String(init?.body || "");
      if (bodyText.includes("1000000000")) return withGet(jsonResponse(200, { verdict: "BLOCK", receipt: { hmac: "x" }, checked: ["a"], notChecked: ["b"] }));
      if (bodyText.includes('"kind":"transaction"')) return withGet(jsonResponse(400, { code: "missing_chain" }));
      return withGet(jsonResponse(200, { verdict: "CAUTION", receipt: { hmac: "x" }, checked: ["a"], notChecked: ["b"] }));
    }
    if (u.endsWith("/.well-known/agent-card.json")) return withGet(jsonResponse(200, "example.test"));
    // missing-chain check expects 400 missing_chain
    if (u.endsWith("/verify") && init?.body && String(init.body).includes('"kind":"transaction"')) {
      return withGet(jsonResponse(400, { code: "missing_chain" }));
    }
    // weak key check: if header present, 400 weak key
    if (u.endsWith("/verify") && init?.headers?.["x-idempotency-key"] === "test-1") {
      return withGet(jsonResponse(400, { code: "weak_idempotency_key" }));
    }
    // 402 challenge
    if (u.endsWith("/verify")) return withGet(jsonResponse(402, { x402Version: 2, accepts: [] }));
    return withGet(jsonResponse(404, {}));
  };
  const result = await runSmoke({ baseUrl: "http://example.test", env: { AGENT_URL: "http://example.test" }, fetchImpl, log: () => {} });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

import { wakeService } from "../scripts/smoke.mjs";

test("wakeService retries until /health succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("cold");
    return withGet(jsonResponse(200, { ok: true }));
  };
  const result = await wakeService({ baseUrl: "http://example.test", fetchImpl, retryDelayMs: 0, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test("wakeService returns ok:false when all attempts fail", async () => {
  const fetchImpl = async () => { throw new Error("still cold"); };
  const result = await wakeService({ baseUrl: "http://example.test", fetchImpl, retries: 2, retryDelayMs: 0, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});
