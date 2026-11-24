// Offline tests for the reference executor. The gate and verifier are fake
// fetch responses, so the only thing under test is the refusal ordering.

import test from "node:test";
import assert from "node:assert/strict";
import {
  guardAndSign, guardX402Payment, createX402PreflightHook, x402PaymentIntent,
  PreflightBlockedError, PreflightUnavailableError,
} from "../examples/preflight-guard.mjs";
import { preflightRequestHash } from "../src/preflight.mjs";

const FUTURE = () => new Date(Date.now() + 60_000).toISOString();

function pass(overrides = {}) {
  return {
    verdict: "PASS",
    sign_allowed: true,
    requires_ack: false,
    kind: "transaction",
    intentHash: "intent-abc",
    intent: { kind: "transaction", chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: "0x095ea7b3" + "00".repeat(64), value: "0", policy: {} },
    reasons: [],
    checked: ["calldata", "simulation"],
    notChecked: ["recipient reputation"],
    receipt: { spec: "verify402/preflight-receipt@1", intentHash: "intent-abc", requestHash: REQUEST_HASH, expiresAt: FUTURE(), signature: "a".repeat(64) },
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
    requestHash: REQUEST_HASH,
    intentBound: true,
    requestBound: true,
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
const REQUEST_HASH = preflightRequestHash(INTENT);

const X402_PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
const X402_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const X402_CHALLENGE = {
  x402Version: 2,
  resource: { url: "https://api.example/paid" },
  accepts: [],
};
const X402_SELECTED = {
  scheme: "exact",
  network: "eip155:8453",
  asset: X402_USDC,
  amount: "10000",
  payTo: X402_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2", facilitator: "https://facilitator.example" },
};
X402_CHALLENGE.accepts = [X402_SELECTED];
const X402_POLICY = { allowedResourceHosts: ["api.example"] };

function x402Responses(overrides = {}) {
  const intent = x402PaymentIntent({
    paymentRequired: X402_CHALLENGE,
    requirements: X402_SELECTED,
  });
  const request = { ...intent, policy: X402_POLICY };
  const requestHash = preflightRequestHash(request);
  const intentHash = "x402-intent";
  const verdict = overrides.verdict ?? "PASS";
  const passBody = {
    verdict,
    sign_allowed: verdict !== "BLOCK",
    requires_ack: verdict === "CAUTION",
    kind: "payment",
    intentHash,
    intent,
    reasons: overrides.reasons ?? [],
    checked: ["payee", "amount"],
    notChecked: ["recipient reputation"],
    receipt: {
      spec: "verify402/preflight-receipt@1",
      intentHash,
      requestHash,
      expiresAt: FUTURE(),
      signature: "a".repeat(64),
    },
    ...overrides.body,
  };
  return [
    { body: passBody },
    {
      body: {
        valid: true,
        reason: null,
        verdict,
        kind: "payment",
        intentHash,
        requestHash,
        intentBound: true,
        requestBound: true,
        blockNumber: 1,
        blockHash: "0x" + "ab".repeat(32),
        ...overrides.verify,
      },
    },
  ];
}

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
  assert.ok(out.calls[1].body.intent, "verification must send the canonical intent");
  assert.ok(out.calls[1].body.request, "verification must send the original request");
  assert.equal(out.calls[1].body.request.chainId, 8453);
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

test("a valid HMAC without caller-intent binding never reaches the signer", async () => {
  for (const unbound of [
    verifyOk({ intentBound: false }),
    verifyOk({ requestBound: false }),
  ]) {
    const state = { signed: 0 };
    await assert.rejects(
      () => run([{ body: pass() }, { body: unbound }], {}, state),
      (e) => e instanceof PreflightBlockedError && /bound to this caller/.test(e.message),
    );
    assert.equal(state.signed, 0);
  }
});

test("the removed verify:false option cannot bypass verification", async () => {
  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass() }, { body: verifyOk({ valid: false, reason: "bad_signature" }) }], { verify: false }, state),
    (e) => e instanceof PreflightBlockedError && /bad_signature/.test(e.message),
  );
  assert.equal(state.signed, 0);
});

test("a verifier cannot override a receipt with a different request hash", async () => {
  const state = { signed: 0 };
  const mismatched = pass();
  mismatched.receipt = { ...mismatched.receipt, requestHash: "c".repeat(64) };

  await assert.rejects(
    () => run([{ body: mismatched }, { body: verifyOk({ requestHash: REQUEST_HASH }) }], {}, state),
    (e) => e instanceof PreflightBlockedError && /request hash/.test(e.message),
  );
  assert.equal(state.signed, 0);
});

test("a verifier claiming a different request hash never reaches the signer", async () => {
  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass() }, { body: verifyOk({ requestHash: "c".repeat(64) }) }], {}, state),
    (e) => e instanceof PreflightBlockedError && /request hash/.test(e.message),
  );
  assert.equal(state.signed, 0);
});

test("a gate response without a canonical intent never reaches the signer", async () => {
  const state = { signed: 0 };
  await assert.rejects(
    () => run([{ body: pass({ intent: undefined }) }], {}, state),
    (e) => e instanceof PreflightBlockedError && /canonical intent/.test(e.message),
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

// ------------------------------------------------------------ x402 hook ---

test("x402PaymentIntent maps the selected requirement into a gate payment intent", () => {
  const from = "0x1111111111111111111111111111111111111111";
  const intent = x402PaymentIntent({
    paymentRequired: X402_CHALLENGE,
    requirements: X402_SELECTED,
    from,
  });
  assert.equal(intent.kind, "payment");
  assert.equal(intent.chainId, 8453);
  assert.equal(intent.from, from);
  assert.equal(intent.payment.scheme, "exact");
  assert.equal(intent.payment.network, "eip155:8453");
  assert.equal(intent.payment.asset, X402_USDC);
  assert.equal(intent.payment.amount, "10000");
  assert.equal(intent.payment.payTo, X402_PAY_TO);
  assert.equal(intent.payment.resource, "https://api.example/paid");
  assert.equal(intent.payment.maxTimeoutSeconds, 300);
  assert.equal(intent.payment.extra.facilitator, "https://facilitator.example");
});

test("x402 hook verifies the receipt and attaches it to the payment context", async () => {
  const f = fakeFetch(...x402Responses());
  let verified = null;
  const hook = createX402PreflightHook({
    policy: X402_POLICY,
    fetchImpl: f.fetch,
    baseUrl: "https://verify402.test",
    onVerified: (attachment) => { verified = attachment; },
  });
  const context = {
    paymentRequired: X402_CHALLENGE,
    selectedRequirements: X402_SELECTED,
  };
  const result = await hook(context);
  assert.equal(result, undefined);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.kind, "payment");
  assert.equal(f.calls[0].body.payment.amount, "10000");
  assert.equal(f.calls[1].body.receipt.signature, "a".repeat(64));
  assert.equal(context.verify402.verdict, "PASS");
  assert.equal(context.verify402.receipt.signature, "a".repeat(64));
  assert.equal(verified.receipt, context.verify402.receipt);
  assert.equal(verified.context, context);
});

test("x402 hook aborts on BLOCK without calling verify or attaching a receipt", async () => {
  const f = fakeFetch(...x402Responses({ verdict: "BLOCK" }));
  let blocked = null;
  const hook = createX402PreflightHook({
    policy: X402_POLICY,
    fetchImpl: f.fetch,
    baseUrl: "https://verify402.test",
    onBlocked: (e) => { blocked = e; },
  });
  const context = {
    paymentRequired: X402_CHALLENGE,
    selectedRequirements: X402_SELECTED,
  };
  const result = await hook(context);
  assert.equal(result.abort, true);
  assert.match(result.reason, /BLOCK/);
  assert.equal(context.verify402, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(blocked.verdict, "BLOCK");
});

test("x402 hook refuses CAUTION unless acknowledged", async () => {
  const context = {
    paymentRequired: X402_CHALLENGE,
    selectedRequirements: X402_SELECTED,
  };
  const f = fakeFetch(...x402Responses({ verdict: "CAUTION" }));
  const hook = createX402PreflightHook({
    policy: X402_POLICY,
    fetchImpl: f.fetch,
    baseUrl: "https://verify402.test",
  });
  const result = await hook(context);
  assert.equal(result.abort, true);
  assert.match(result.reason, /CAUTION/);
  assert.equal(context.verify402, undefined);

  const acknowledged = fakeFetch(...x402Responses({ verdict: "CAUTION" }));
  const ackHook = createX402PreflightHook({
    policy: X402_POLICY,
    acknowledgeCaution: true,
    fetchImpl: acknowledged.fetch,
    baseUrl: "https://verify402.test",
  });
  const ackContext = {
    paymentRequired: X402_CHALLENGE,
    selectedRequirements: X402_SELECTED,
  };
  assert.equal(await ackHook(ackContext), undefined);
  assert.equal(ackContext.verify402.verdict, "CAUTION");
  assert.equal(acknowledged.calls.length, 2);
});

test("x402 hook aborts when the challenge has no selected requirement", async () => {
  let fetched = false;
  const hook = createX402PreflightHook({
    fetchImpl: async () => { fetched = true; throw new Error("should not fetch"); },
    baseUrl: "https://verify402.test",
  });
  const result = await hook({ paymentRequired: { x402Version: 2, accepts: [] } });
  assert.equal(result.abort, true);
  assert.match(result.reason, /selected payment requirement/);
  assert.equal(fetched, false);
});

test("guardX402Payment returns the verified receipt without a signer", async () => {
  const f = fakeFetch(...x402Responses());
  const out = await guardX402Payment({
    paymentRequired: X402_CHALLENGE,
    requirements: X402_SELECTED,
    policy: X402_POLICY,
    fetchImpl: f.fetch,
    baseUrl: "https://verify402.test",
  });
  assert.equal(out.verdict, "PASS");
  assert.equal(out.receipt.signature, "a".repeat(64));
  assert.equal(f.calls.length, 2);
});
