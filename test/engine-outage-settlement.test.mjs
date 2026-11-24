// Paid-route fail-closed proof with a fake facilitator.
//
// Runs entirely offline against local HTTP servers. It proves that when the
// private engine is unreachable, rejects the token, or returns 5xx, the paid
// route answers non-2xx and the facilitator's settle() is never called — so the
// payer is not charged. No live service or engine is touched.

import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { enableHostedMode } from "../src/license.mjs";

enableHostedMode();

const NETWORK = "eip155:8453";
const PAY_TO = "0x0000000000000000000000000000000000000001";
const accepts = [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAY_TO }];
const OLD_ENV = {
  url: process.env.VERIFY402_ENGINE_URL,
  token: process.env.VERIFY402_ENGINE_TOKEN,
};

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

async function readChallenge(response) {
  const header = response.headers.get("payment-required");
  assert.ok(header, "402 must carry a payment-required header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

function startEngine(status) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "engine_down" }));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function startPaidApp() {
  const { measureRoundTrip } = await import("../src/measure.mjs");
  const facilitator = makeFacilitator();
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactEvmScheme());
  const app = express();
  app.use(express.json());
  app.use(paymentMiddleware(
    {
      "POST /paid-verify": {
        accepts,
        description: "test route that depends on the private engine",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ));
  app.post("/paid-verify", async (_req, res) => {
    try {
      const result = await measureRoundTrip(1, {
        baseSymbol: "USDC",
        targetSymbol: "WETH",
        size: 1_000_000n,
        minNet: 0n,
      });
      if (!result || result.ok === false) {
        return res.status(503).json({ error: "engine_unavailable" });
      }
      return res.json(result);
    } catch {
      return res.status(503).json({ error: "engine_unavailable" });
    }
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    server,
    facilitator,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

async function runOutage({ label, engine }) {
  const previousUrl = process.env.VERIFY402_ENGINE_URL;
  const previousToken = process.env.VERIFY402_ENGINE_TOKEN;
  process.env.VERIFY402_ENGINE_URL = engine.url;
  process.env.VERIFY402_ENGINE_TOKEN = "test-token";
  const { server, facilitator, base } = await startPaidApp();
  try {
    const challenge = await fetch(`${base}/paid-verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(challenge.status, 402);
    const body = await readChallenge(challenge);
    const paid = await fetch(`${base}/paid-verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paymentHeader(body.accepts[0]),
      },
      body: JSON.stringify({ test: true }),
    });
    assert.ok(paid.status >= 400, `${label}: expected non-2xx, got ${paid.status}`);
    assert.equal(facilitator.counts.verify, 1, `${label}: payment must be verified`);
    assert.equal(facilitator.counts.settle, 0, `${label}: payer must not be charged`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.VERIFY402_ENGINE_URL;
    else process.env.VERIFY402_ENGINE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.VERIFY402_ENGINE_TOKEN;
    else process.env.VERIFY402_ENGINE_TOKEN = previousToken;
  }
}

console.log("\nprivate-engine outage: paid route never settles");

await check("unreachable engine -> non-2xx, settle not called", async () => {
  // A closed local port simulates a down service without stopping anything.
  const closed = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  await runOutage({ label: "unreachable", engine: { url: closed } });
});

for (const status of [401, 500]) {
  const engine = await startEngine(status);
  try {
    await check(`engine returns ${status} -> non-2xx, settle not called`, () =>
      runOutage({ label: `HTTP ${status}`, engine }));
  } finally {
    await engine.close();
  }
}

if (OLD_ENV.url === undefined) delete process.env.VERIFY402_ENGINE_URL;
else process.env.VERIFY402_ENGINE_URL = OLD_ENV.url;
if (OLD_ENV.token === undefined) delete process.env.VERIFY402_ENGINE_TOKEN;
else process.env.VERIFY402_ENGINE_TOKEN = OLD_ENV.token;

console.log(`\nengine-outage-settlement: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
