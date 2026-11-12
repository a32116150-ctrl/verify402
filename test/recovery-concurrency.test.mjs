// Concurrency audit: three copies of one signed payment.
//
// Reproduces the scenario Hitek-cel reported for the recovery extension, against
// the real @x402/express middleware and a fake facilitator:
//
//   without a gate : 3 handler runs, 3 settle attempts, 1 success + 2 x 402
//   with the gate  : 1 handler run, 1 settle, 2 x 409 operation_in_flight
//
// The gate here uses the same primitives, in the same order, as the middleware
// in src/server.mjs (lookup -> reserve -> release on finish). It runs BEFORE
// the payment middleware, which is the point: a loser must not reach the
// handler or receive a payment challenge.

import assert from "node:assert/strict";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  lookupRecovery, reserveRecovery, releaseRecovery, recordSettlement, requestHash,
} from "../src/recovery.mjs";
import { registerRecoveryHooks } from "../src/settlement-recovery.mjs";

const NETWORK = "eip155:8453";
const PAY_TO = "0x0000000000000000000000000000000000000001";
const accepts = [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAY_TO }];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFacilitator() {
  const counts = { verify: 0, settle: 0 };
  let settledOnce = false;
  return {
    counts,
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [] };
    },
    async verify() {
      counts.verify++;
      return { isValid: true, payer: PAY_TO };
    },
    async settle() {
      counts.settle++;
      if (!settledOnce) {
        settledOnce = true;
        return { success: true, transaction: "0x" + "11".repeat(32), network: NETWORK, payer: PAY_TO };
      }
      return { success: false, errorReason: "nonce_already_used", transaction: "", network: NETWORK };
    },
  };
}

function recoveryGate() {
  return (req, res, next) => {
    const key = String(req.get("x-idempotency-key") || "").trim();
    if (!key) return next();
    const rh = requestHash(req.path, req.body || {});
    const found = lookupRecovery({ key, requestHash: rh });
    if (found?.conflict) {
      return res.status(409).json({ error: "recovery_conflict", conflict: found.conflict });
    }
    if (found?.hit) return res.json(found.hit.payload);
    if (found?.pending) {
      return res.status(409).json({ error: "recovery_conflict", code: "operation_in_flight" });
    }
    const reservation = reserveRecovery({ key, requestHash: rh });
    if (reservation?.pending) {
      return res.status(409).json({ error: "recovery_conflict", code: "operation_in_flight" });
    }
    if (reservation?.token) {
      req.recoveryKey = key;
      req.recoveryRequestHash = rh;
      const release = () => releaseRecovery(key, reservation.token);
      res.once("finish", release);
      res.once("close", release);
    }
    next();
  };
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

async function startApp({ gate }) {
  const facilitator = makeFacilitator();
  let resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  resourceServer = registerRecoveryHooks(resourceServer, { logError: () => {} });

  const handlerRuns = { count: 0 };
  const app = express();
  app.use(express.json());
  if (gate) app.use(recoveryGate());
  app.use(paymentMiddleware({
    "POST /paid": {
      accepts,
      description: "concurrency audit route",
      mimeType: "application/json",
    },
  }, resourceServer));

  app.post("/paid", async (req, res) => {
    handlerRuns.count++;
    await sleep(250);
    const { operationId } = recordSettlement(req.recoveryKey, { ok: true, verdict: "no_edge" }, null, {
      requestHash: req.recoveryRequestHash,
    });
    res.json({ ok: true, verdict: "no_edge", recovery: { operationId } });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, facilitator, handlerRuns, server };
}

async function challenge(base) {
  const r = await fetch(`${base}/paid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audit: true }),
  });
  assert.equal(r.status, 402);
  const header = r.headers.get("payment-required");
  assert.ok(header, "402 must carry a payment-required header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts[0];
}

async function fireThree(base, accepted, key) {
  const header = paymentHeader(accepted);
  const one = () => fetch(`${base}/paid`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": header,
      ...(key ? { "x-idempotency-key": key } : {}),
    },
    body: JSON.stringify({ audit: true }),
  });
  const responses = await Promise.all([one(), one(), one()]);
  return Promise.all(responses.map(async (r) => {
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* keep null */ }
    return { status: r.status, body };
  }));
}

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

console.log("\nrecovery concurrency audit");

await check("control: without a gate, three copies run the handler three times", async () => {
  const app = await startApp({ gate: false });
  try {
    const accepted = await challenge(app.base);
    const responses = await fireThree(app.base, accepted, null);
    const ok = responses.filter((r) => r.status === 200).length;
    const challenged = responses.filter((r) => r.status === 402).length;
    assert.equal(app.handlerRuns.count, 3, "control must reproduce three handler runs");
    assert.equal(app.facilitator.counts.settle, 3, "control must attempt three settles");
    assert.equal(ok, 1, "exactly one copy may succeed");
    assert.equal(challenged, 2, "the two losers get a payment challenge on the SDK alone");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

await check("with the gate: one handler run, one settle, losers get 409 not 402", async () => {
  const app = await startApp({ gate: true });
  try {
    const accepted = await challenge(app.base);
    const key = `audit-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const responses = await fireThree(app.base, accepted, key);
    const ok = responses.filter((r) => r.status === 200);
    const conflicted = responses.filter((r) => r.status === 409);
    assert.equal(app.handlerRuns.count, 1, "the handler must run exactly once");
    assert.equal(app.facilitator.counts.settle, 1, "exactly one settle may be attempted");
    assert.equal(ok.length, 1, "exactly one copy succeeds");
    assert.equal(conflicted.length, 2, "the other two are refused");
    assert.ok(
      conflicted.every((r) => r.body?.code === "operation_in_flight"),
      "losers must carry operation_in_flight",
    );
    assert.equal(responses.filter((r) => r.status === 402).length, 0, "a loser must never get a payment challenge");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

console.log(`\nconcurrency audit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
