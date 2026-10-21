// Behaviour test for the x402 settlement guard.
//
// The source-reading guard in test/http.test.mjs pins the middleware's
// `if (res.statusCode >= 400)` branch. This test runs the real @x402/express
// middleware with a fake facilitator and a fake scheme, then proves the branch
// is actually taken: a 503 response must never call facilitator.settle, while a
// 200 control response must.

import assert from "node:assert/strict";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";

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

console.log(`\nx402-settlement: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
