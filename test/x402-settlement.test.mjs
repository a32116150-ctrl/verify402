// Behaviour test for the x402 settlement guard.
//
// The source-reading guard in test/http.test.mjs pins the middleware's
// `if (res.statusCode >= 400)` branch. This test runs the real @x402/express
// middleware with a fake facilitator and a fake scheme, then proves the branch
// is actually taken: a 503 response must never call facilitator.settle, while a
// 200 control response must.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { FacilitatorTimeoutError } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  lookupRecovery, replayFor, recordSettlement, releaseRecovery, reserveRecovery,
} from "../src/recovery.mjs";
import { registerRecoveryHooks } from "../src/settlement-recovery.mjs";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ${name} ... PASS`);
  } catch (e) {
    failed++;
    console.log(`  ${name} ... FAIL\n      ${e.stack || e.message}`);
  }
}

const NETWORK = "eip155:8453";
const PAY_TO = "0x0000000000000000000000000000000000000001";

const accepts = [{
  scheme: "exact",
  price: "$0.01",
  network: NETWORK,
  payTo: PAY_TO,
}];

function makeFacilitator() {
  const counts = { supported: 0, verify: 0, settle: 0 };
  return {
    counts,
    async getSupported() {
      counts.supported++;
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
        extensions: [],
      };
    },
    async verify() {
      counts.verify++;
      return { isValid: true, payer: PAY_TO };
    },
    async settle() {
      counts.settle++;
      return {
        success: true,
        transaction: "0x" + "11".repeat(32),
        network: NETWORK,
        payer: PAY_TO,
      };
    },
  };
}

async function startApp() {
  const facilitator = makeFacilitator();
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactEvmScheme());

  const app = express();
  app.use(express.json());
  app.use(paymentMiddleware(
    {
      "POST /paid-fail": {
        accepts,
        description: "test route that fails closed",
        mimeType: "application/json",
      },
      "POST /paid-ok": {
        accepts,
        description: "test route that succeeds",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ));
  app.post("/paid-fail", (_req, res) => {
    res.status(503).json({ error: "rpc_unavailable", message: "no verdict" });
  });
  app.post("/paid-ok", (_req, res) => {
    res.json({ ok: true, verdict: "no_edge" });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, facilitator, base: `http://127.0.0.1:${server.address().port}` };
}

async function startRecoveryApp({ mode, key, payload }) {
  const facilitator = makeFacilitator();
  facilitator.settle = async () => {
    facilitator.counts.settle++;
    if (mode === "success") {
      return {
        success: true,
        transaction: "0x" + "44".repeat(32),
        network: NETWORK,
        payer: PAY_TO,
      };
    }
    if (mode === "definitive") {
      return {
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: NETWORK,
      };
    }
    if (mode === "pending") {
      return {
        success: false,
        errorReason: "settlement_pending",
        transaction: "0x" + "55".repeat(32),
        network: NETWORK,
      };
    }
    if (mode === "failed_with_tx") {
      return {
        success: false,
        errorReason: "transaction_failed",
        transaction: "0x" + "66".repeat(32),
        network: NETWORK,
      };
    }
    if (mode === "timeout") {
      throw new FacilitatorTimeoutError("settle", 10);
    }
    if (mode === "ambiguous") {
      throw new Error("socket hang up after the settle request was sent");
    }
    throw new Error(`unknown test mode: ${mode}`);
  };

  const resourceServer = registerRecoveryHooks(
    new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme()),
    { logError: () => {} },
  );

  const app = express();
  app.use(express.json());
  app.use(paymentMiddleware(
    {
      "POST /paid-recovery": {
        accepts,
        description: "test route that stages a verdict before settlement",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ));
  app.post("/paid-recovery", (_req, res) => {
    recordSettlement(key, payload);
    res.json(payload);
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, facilitator, base: `http://127.0.0.1:${server.address().port}` };
}

async function runRecovery(mode, key, payload) {
  const { server, facilitator, base } = await startRecoveryApp({ mode, key, payload });
  try {
    const challenge = await fetch(`${base}/paid-recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    const body = await readChallenge(challenge);
    const response = await payAndPost(base, "/paid-recovery", body.accepts[0]);
    await response.text();
    return { response, facilitator };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function paymentHeader(accepted) {
  const payload = {
    x402Version: 2,
    accepted,
    payload: {
      signature: "0x" + "22".repeat(65),
      authorization: {
        from: PAY_TO,
        to: PAY_TO,
        value: accepted.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "33".repeat(32),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

async function payAndPost(base, path, accepted) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": paymentHeader(accepted),
    },
    body: JSON.stringify({ test: true }),
  });
}

async function readChallenge(response) {
  const header = response.headers.get("payment-required");
  assert.ok(header, "402 must carry a payment-required header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

console.log("\nx402 settlement guard");

await check("503 handler does not call facilitator.settle", async () => {
  const { server, facilitator, base } = await startApp();
  try {
    const challenge = await fetch(`${base}/paid-fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(challenge.status, 402);
    const body = await readChallenge(challenge);
    assert.ok(Array.isArray(body.accepts) && body.accepts[0], "402 must carry accepts");

    const r = await payAndPost(base, "/paid-fail", body.accepts[0]);
    assert.equal(r.status, 503);
    assert.equal(facilitator.counts.verify, 1, "the payment must have been verified");
    assert.equal(facilitator.counts.settle, 0, "a 503 must not settle");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await check("200 control handler does call facilitator.settle", async () => {
  const { server, facilitator, base } = await startApp();
  try {
    const challenge = await fetch(`${base}/paid-ok`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    const body = await readChallenge(challenge);
    const r = await payAndPost(base, "/paid-ok", body.accepts[0]);
    assert.equal(r.status, 200);
    assert.equal(facilitator.counts.settle, 1, "the control must settle exactly once");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

console.log("\nx402 recovery hooks (real middleware callback path)");

await check("successful settlement promotes the staged record for replay", async () => {
  const key = randomUUID();
  const payload = { ok: true, verdict: "no_edge" };
  const { response } = await runRecovery("success", key, payload);

  assert.equal(response.status, 200);
  const hit = replayFor(key);
  assert.ok(hit, "the settled verdict must be replayable");
  assert.equal(hit.payload.verdict, "no_edge");
});

await check("definitive settlement failure abandons the staged record", async () => {
  const key = randomUUID();
  const payload = { ok: true, verdict: "no_edge" };
  const { response } = await runRecovery("definitive", key, payload);

  assert.equal(response.status, 402);
  assert.equal(lookupRecovery({ key }), null, "a refused settlement must not leave a pending gate");
});

await check("same-key retry is allowed after a definitive failure", async () => {
  const key = randomUUID();
  const first = await runRecovery("definitive", key, { ok: true, verdict: "first" });
  assert.equal(first.response.status, 402);
  assert.equal(lookupRecovery({ key }), null);

  const reservation = reserveRecovery({ key });
  assert.ok(reservation?.token, "the retry must be able to reserve the same key again");
  assert.equal(releaseRecovery(key, reservation.token), true);

  const second = await runRecovery("success", key, { ok: true, verdict: "second" });
  assert.equal(second.response.status, 200);
  assert.equal(replayFor(key)?.payload?.verdict, "second");
});

await check("pending settlement is not abandoned and blocks a second charge", async () => {
  const key = randomUUID();
  const payload = { ok: true, verdict: "no_edge" };
  const { response, facilitator } = await runRecovery("pending", key, payload);

  assert.equal(response.status, 402);
  assert.equal(facilitator.counts.settle, 2, "the middleware retries a pending settle once");
  assert.deepEqual(lookupRecovery({ key }), { pending: "settlement_pending" });
});

await check("a failed settlement carrying a transaction hash is ambiguous", async () => {
  const key = randomUUID();
  const payload = { ok: true, verdict: "no_edge" };
  const { response } = await runRecovery("failed_with_tx", key, payload);

  assert.equal(response.status, 402);
  assert.deepEqual(lookupRecovery({ key }), { pending: "settlement_pending" });
});

await check("settle timeout is ambiguous and leaves the staged record pending", async () => {
  const key = randomUUID();
  const payload = { ok: true, verdict: "no_edge" };
  const { response } = await runRecovery("timeout", key, payload);

  assert.equal(response.status, 502);
  assert.deepEqual(lookupRecovery({ key }), { pending: "settlement_pending" });
});

await check("unknown settle error is ambiguous and leaves the staged record pending", async () => {
  const key = randomUUID();
  const payload = { ok: true, verdict: "no_edge" };
  const { response } = await runRecovery("ambiguous", key, payload);

  assert.equal(response.status, 402);
  assert.deepEqual(lookupRecovery({ key }), { pending: "settlement_pending" });
});

console.log(`\nx402-settlement: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
