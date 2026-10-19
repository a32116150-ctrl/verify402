// Offline tests for the reference executor. The gate and verifier are fake
// fetch responses, so the only thing under test is the refusal ordering.

import test from "node:test";
import assert from "node:assert/strict";
import {
  guardAndSign, PreflightBlockedError, PreflightUnavailableError,
} from "../examples/preflight-guard.mjs";

const FUTURE = () => new Date(Date.now() + 60_000).toISOString();

function pass(overrides = {}) {
  return {
    verdict: "PASS",
    sign_allowed: true,
    requires_ack: false,
    kind: "transaction",
    intentHash: "intent-abc",
    reasons: [],
    checked: ["calldata", "simulation"],
    notChecked: ["recipient reputation"],
    receipt: { spec: "verify402/preflight-receipt@1", intentHash: "intent-abc", expiresAt: FUTURE(), signature: "a".repeat(64) },
    ...overrides,
  };
}

function verifyOk(overrides = {}) {
  return {
    valid: true,
    reason: null,
    verdict: "PASS",
    kind: "transaction",
    intentHash: "intent-abc",
    blockNumber: 1,
    blockHash: "0x" + "ab".repeat(32),
    ...overrides,
  };
}

function fakeFetch(...responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body) });
      const spec = responses.shift();
      if (!spec) throw new Error("unexpected fetch call");
      return {
        ok: spec.status == null || spec.status < 400,
        status: spec.status ?? 200,
        text: async () => JSON.stringify(spec.body),
      };
    },
  };
}

const INTENT = {
  kind: "transaction",
  chainId: 8453,
  to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  data: "0x095ea7b3" + "00".repeat(64),
  value: "0",
};

async function run(responses, options = {}, state = { signed: 0 }) {
  const f = fakeFetch(...responses);
  let seen = null;
  const result = await guardAndSign({
    intent: INTENT,
    sign: async (intent, ctx) => {
      state.signed += 1;
      seen = { intent, ctx };
      return { hash: "0x" + "11".repeat(32) };
    },
    fetchImpl: f.fetch,
    baseUrl: "https://verify402.test",
    ...options,
  });
  return { result, signed: state.signed, seen, calls: f.calls };
}

test("PASS + verified receipt calls the signer exactly once", async () => {
  const out = await run([
    { body: pass() },
    { body: verifyOk() },
  ]);
  assert.equal(out.signed, 1);
  assert.equal(out.result.verdict, "PASS");
  assert.equal(out.calls.length, 2);
  assert.ok(out.calls[0].url.endsWith("/preflight"));
  assert.ok(out.calls[1].url.endsWith("/preflight/verify"));
  assert.equal(Object.isFrozen(out.seen.intent), true);
});

test("BLOCK never reaches the signer", async () => {
  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass({ verdict: "BLOCK", sign_allowed: false, reasons: [{ code: "simulation_revert", severity: "block", message: "reverted" }] }) }], {}, state),
    (e) => e instanceof PreflightBlockedError && e.verdict === "BLOCK" && e.reasons[0].code === "simulation_revert",
  );
  assert.equal(state.signed, 0);
});

test("CAUTION requires an explicit acknowledgement", async () => {
  const caution = pass({ verdict: "CAUTION", requires_ack: true, reasons: [{ code: "unlimited_approval", severity: "caution", message: "unlimited" }] });
  const checked = verifyOk({ verdict: "CAUTION" });

  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ body: caution }, { body: checked }], {}, state),
    (e) => e instanceof PreflightBlockedError && e.verdict === "CAUTION",
  );
  assert.equal(state.signed, 0);

  const acknowledged = await run([{ body: caution }, { body: checked }], { acknowledgeCaution: true });
  assert.equal(acknowledged.signed, 1);
});

test("a missing or invalid receipt never reaches the signer", async () => {
  const missing = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass({ receipt: null }) }], {}, missing),
    (e) => e instanceof PreflightBlockedError,
  );
  assert.equal(missing.signed, 0);

  const invalid = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass() }, { body: verifyOk({ valid: false, reason: "bad_signature" }) }], {}, invalid),
    (e) => e instanceof PreflightBlockedError && /bad_signature/.test(e.message),
  );
  assert.equal(invalid.signed, 0);
});

test("a receipt bound to a different intent never reaches the signer", async () => {
  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass() }, { body: verifyOk({ intentHash: "intent-other" }) }], {}, state),
    (e) => e instanceof PreflightBlockedError && /intent hash/.test(e.message),
  );
  assert.equal(state.signed, 0);
});

test("an expired receipt never reaches the signer", async () => {
  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass({ receipt: { ...pass().receipt, expiresAt: new Date(Date.now() - 1000).toISOString() } }) }], {}, state),
    (e) => e instanceof PreflightBlockedError && /expired/.test(e.message),
  );
  assert.equal(state.signed, 0);
});

test("a 503 from the gate is unavailable, not a pass", async () => {
  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ status: 503, body: { error: "preflight_unavailable", message: "chain unreadable" } }], {}, state),
    (e) => e instanceof PreflightUnavailableError && e.status === 503,
  );
  assert.equal(state.signed, 0);
});

test("the signer sees the same frozen intent the gate saw", async () => {
  const f = fakeFetch({ body: pass() }, { body: verifyOk() });
  let mutationBlocked = false;
  await guardAndSign({
    intent: INTENT,
    sign: async (intent) => {
      try {
        intent.to = "0x2222222222222222222222222222222222222222";
      } catch {
        mutationBlocked = true;
      }
      return {};
    },
    fetchImpl: f.fetch,
    baseUrl: "https://verify402.test",
  });
  assert.equal(mutationBlocked, true);
});
