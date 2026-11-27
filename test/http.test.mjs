// HTTP-boundary tests for the paid routes. No real payment and no real chain:
//
//   * BYPASS_PAYMENT=1 lets us reach the handlers so we can prove the status
//     codes, typed bodies and honesty arrays without a wallet.
//   * ETH_RPC_URL points at a closed local port with a recognisable secret in
//     the path, so a 503 test can prove the URL never appears in the response.
//   * A child process with the paywall armed proves an unpaid request is 402.
//
//   node test/http.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";

process.env.X402_MODE = "testnet";
process.env.BYPASS_PAYMENT = "1";
process.env.ETH_RPC_URL = "http://127.0.0.1:1/FAKE_RPC_SECRET_DO_NOT_LEAK";
// `npm run test:offline` sets TEST_OFFLINE=1, which makes clientFor ignore the
// public fallbacks. Keep the same closed endpoint so the leak assertions still
// exercise the real error path.
process.env.TEST_OFFLINE_RPC_URL = "http://127.0.0.1:1/FAKE_RPC_SECRET_DO_NOT_LEAK";

const {
  PRICE_DEFAULTS,
  PREFLIGHT_RATE_PER_MIN,
  FINDINGS_RATE_PER_MIN,
  PREFLIGHT_MAX_IN_FLIGHT,
  HEALTH_OK_KEYS,
  READY_OK_KEYS,
  READY_FAILURE_KEYS,
  bannedClaimHits,
} = await import("../src/contract.mjs");
const { PAID_ROUTES } = await import("../src/honesty.mjs");
const { DEFAULT_PAID_ROUTES } = await import("../mcp-bridge/payment-policy.mjs");
const { PAID_TOOL_ROUTES } = await import("../mcp-bridge/index.mjs");
const {
  recordSettlement, requestHash, lookupRecovery, reserveRecovery, releaseRecovery,
  IDEMPOTENCY_TTL_MS, IDEMPOTENCY_MAX_REPLAYS, IDEMPOTENCY_STAGE_TTL_MS,
  reconcileStagedEntry, markSettling, setRecoveryPaymentChecker, _setNow,
} = await import("../src/recovery.mjs");
const { isDefinitiveSettlementFailure, registerRecoveryHooks } = await import("../src/settlement-recovery.mjs");
const { app, paymentRefFromRequest } = await import("../src/server.mjs");

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ${name} ... PASS`);
  } catch (e) {
    failed++;
    console.log(`  ${name} ... FAIL\n      ${e.message}`);
  }
}

async function withReadinessRpc({ chainId, rpcChainId, blockNumber = 42 }, fn) {
  const rpc = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let id = 1;
      let method = "";
      try {
        const parsed = JSON.parse(raw);
        id = parsed.id ?? id;
        method = parsed.method;
      } catch { /* keep defaults */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: method === "eth_chainId"
          ? `0x${rpcChainId.toString(16)}`
          : `0x${blockNumber.toString(16)}`,
      }));
    });
  });
  const port = await new Promise((resolve, reject) => {
    rpc.once("error", reject);
    rpc.listen(0, "127.0.0.1", () => resolve(rpc.address().port));
  });
  const previous = {
    offline: process.env.TEST_OFFLINE,
    url: process.env.READY_RPC_URL,
    chain: process.env.READY_CHAIN_ID,
  };
  process.env.TEST_OFFLINE = "0";
  process.env.READY_RPC_URL = `http://127.0.0.1:${port}`;
  process.env.READY_CHAIN_ID = String(chainId);
  try {
    await fn();
  } finally {
    if (previous.offline === undefined) delete process.env.TEST_OFFLINE;
    else process.env.TEST_OFFLINE = previous.offline;
    if (previous.url === undefined) delete process.env.READY_RPC_URL;
    else process.env.READY_RPC_URL = previous.url;
    if (previous.chain === undefined) delete process.env.READY_CHAIN_ID;
    else process.env.READY_CHAIN_ID = previous.chain;
    rpc.closeAllConnections?.();
    await new Promise((resolve) => rpc.close(resolve));
  }
}

async function post(path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON is itself a failure below */ }
  return { status: r.status, headers: r.headers, body: json };
}

async function postRaw(path, raw, headers = {}) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON is itself a failure below */ }
  return { status: r.status, headers: r.headers, body: json };
}

function getWithHost(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = JSON.parse(raw); } catch { /* leave null */ }
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const honesty = (body) => {
  assert.ok(Array.isArray(body.checked) && body.checked.length > 0, "checked[] must be non-empty");
  assert.ok(Array.isArray(body.notChecked) && body.notChecked.length > 0, "notChecked[] must be non-empty");
};

const errorShape = (r, status, code) => {
  assert.equal(r.status, status);
  assert.equal(r.body.error, code);
  assert.equal(typeof r.body.requestId, "string");
  assert.equal(r.headers.get("x-request-id"), r.body.requestId);
  honesty(r.body);
};

console.log("\nHTTP boundary");

await check("400: every paid route requires an integer chainId (missing_chain)", async () => {
  for (const route of ["/verify", "/safety", "/route", "/quotecheck", "/depth"]) {
    const r = await post(route, {});
    errorShape(r, 400, "missing_chain");
  }
});

await check("400: invalid_kind teaches a working request and links to /start", async () => {
  const bad = await post("/preflight", { kind: "not-a-kind" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_kind");
  assert.equal(bad.body.code, "invalid_kind");
  assert.equal(bad.body.message, "kind must be 'payment' or 'transaction' (or supply payment / transaction / to)");
  assert.equal(typeof bad.body.requestId, "string");
  assert.equal(bad.body.docs, "/start");
  const openapiRes = await fetch(`${base}/openapi.json`);
  assert.equal(openapiRes.status, 200);
  const openapi = await openapiRes.json();
  const expected = openapi.paths["/preflight"].post.requestBody.content["application/json"].example;
  assert.deepEqual(bad.body.example, expected);

  const worked = await post("/preflight", bad.body.example);
  assert.equal(worked.status, 200);
  assert.deepEqual(bannedClaimHits(worked.body), []);
  honesty(worked.body);
});

await check("400: numeric-string chainId is invalid_chain, not coerced", async () => {
  const r = await post("/verify", { chainId: "1", target: "WETH" });
  errorShape(r, 400, "invalid_chain");
});

await check("400: unsupported chainId is unsupported_chain", async () => {
  const r = await post("/verify", { chainId: 999, target: "WETH" });
  errorShape(r, 400, "unsupported_chain");
});

await check("400: missing token fields are typed bad requests", async () => {
  const cases = [
    ["/verify", { chainId: 1 }, "missing_target"],
    ["/safety", { chainId: 1 }, "missing_tokenAddress"],
    ["/route", { chainId: 1 }, "invalid_token"],
    ["/quotecheck", { chainId: 1 }, "missing_fields"],
    ["/depth", { chainId: 1 }, "missing_tokenAddress"],
  ];
  for (const [route, body, code] of cases) {
    const r = await post(route, body);
    errorShape(r, 400, code);
  }
});

await check("free POST routes ignore the idempotency header (no 409, no weak-key rejection)", async () => {
  // The header protects a payment. On a free route there is no payment to
  // protect, so a weak or reused key must be inert rather than an error: a
  // free caller must never be told to "retry the SAME payment".
  const key = "test-1"; // deliberately weak: rejected on /verify above
  const body = { tool: "verify_arbitrage", ok: true };
  const first = await post("/usage/ping", body, { "x-idempotency-key": key });
  assert.equal(first.status, 202);
  const second = await post("/usage/ping", body, { "x-idempotency-key": key });
  assert.equal(second.status, 202);
  assert.notEqual(second.body.code, "operation_in_flight");
  assert.notEqual(second.body.error, "weak_idempotency_key");
});

await check("400: weak idempotency keys are rejected before any work", async () => {
  const weak = [
    "test-1",
    "a".repeat(64),
    "0123456789".repeat(4),
    "9f2c7a1e5b8d3c6f9f2c7a1e5b8d3c6f",
    "abcdefghijklmnopqrstuvwxyz012345",
  ];
  for (const key of weak) {
    const r = await post("/verify", { chainId: 1, target: "WETH" }, { "x-idempotency-key": key });
    assert.equal(r.status, 400, `${key.slice(0, 12)} must be 400`);
    assert.equal(r.body.error, "weak_idempotency_key");
    assert.equal(r.body.code, "weak_idempotency_key");
    assert.equal(typeof r.body.requestId, "string");
    assert.match(r.body.message, /crypto\.randomUUID|random/i);
    assert.ok(!JSON.stringify(r.body).includes(key), "the weak key must not be echoed");
    honesty(r.body);
  }

  // The recommended format still reaches the (closed) chain and fails closed.
  const r = await post("/verify", { chainId: 1, target: "WETH" }, { "x-idempotency-key": randomUUID() });
  assert.equal(r.status, 503);
});

await check("400: malformed numeric inputs are typed on every paid route (no 500s)", async () => {
  const cases = [
    ["/verify", { chainId: 1, target: "WETH", size: "100" }, "invalid_size"],
    ["/verify", { chainId: 1, target: "WETH", size: true }, "invalid_size"],
    ["/verify", { chainId: 1, target: "WETH", size: {} }, "invalid_size"],
    ["/verify", { chainId: 1, target: "WETH", size: 0 }, "invalid_size"],
    ["/verify", { chainId: 1, target: "WETH", size: -1 }, "invalid_size"],
    ["/verify", { chainId: 1, target: "WETH", size: 1e12 }, "invalid_size"],
    ["/verify", { chainId: 1, target: "WETH", minNet: "0" }, "invalid_minNet"],
    ["/verify", { chainId: 1, target: "WETH", minNet: true }, "invalid_minNet"],
    ["/verify", { chainId: 1, target: "WETH", minNet: -1 }, "invalid_minNet"],
    ["/safety", { chainId: 1, tokenAddress: "WETH", intendedUsd: "500" }, "invalid_intendedUsd"],
    ["/safety", { chainId: 1, tokenAddress: "WETH", intendedUsd: true }, "invalid_intendedUsd"],
    ["/safety", { chainId: 1, tokenAddress: "WETH", intendedUsd: 0 }, "invalid_intendedUsd"],
    ["/safety", { chainId: 1, tokenAddress: "WETH", intendedUsd: 1e12 }, "invalid_intendedUsd"],
    ["/safety", { chainId: 1, tokenAddress: "WETH", offeredPriceUsd: "1" }, "invalid_offeredPriceUsd"],
    ["/safety", { chainId: 1, tokenAddress: "WETH", offeredPriceUsd: -1 }, "invalid_offeredPriceUsd"],
    ["/safety", { chainId: 1, tokenAddress: "WETH", offeredPriceUsd: true }, "invalid_offeredPriceUsd"],
    ["/route", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1.5" }, "invalid_amountIn"],
    ["/route", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "0" }, "invalid_amountIn"],
    ["/route", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "-1" }, "invalid_amountIn"],
    ["/route", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "abc" }, "invalid_amountIn"],
    ["/route", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: true }, "invalid_amountIn"],
    ["/route", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "9".repeat(79) }, "invalid_amountIn"],
    ["/quotecheck", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "0", quotedOut: "1" }, "invalid_amountIn"],
    ["/quotecheck", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1", quotedOut: "0" }, "invalid_quotedOut"],
    ["/quotecheck", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: 1.5, quotedOut: "1" }, "invalid_amountIn"],
    ["/quotecheck", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1", quotedOut: "9".repeat(79) }, "invalid_quotedOut"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", maxRoundTripPct: "1" }, "invalid_maxRoundTripPct"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", maxRoundTripPct: true }, "invalid_maxRoundTripPct"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", maxRoundTripPct: 0 }, "invalid_maxRoundTripPct"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", maxRoundTripPct: 101 }, "invalid_maxRoundTripPct"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", sizesUsd: "100" }, "invalid_sizesUsd"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", sizesUsd: [] }, "invalid_sizesUsd"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", sizesUsd: [0] }, "invalid_sizesUsd"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", sizesUsd: ["100"] }, "invalid_sizesUsd"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", sizesUsd: [true] }, "invalid_sizesUsd"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", sizesUsd: [1e7] }, "invalid_sizesUsd"],
    ["/depth", { chainId: 1, tokenAddress: "WETH", sizesUsd: Array(21).fill(1) }, "invalid_sizesUsd"],
  ];
  for (const [route, body, code] of cases) {
    const r = await post(route, body);
    assert.equal(r.status, 400, `${route} ${JSON.stringify(body)} must be 400, got ${r.status}`);
    assert.equal(r.body.error, code, `${route} ${JSON.stringify(body)} code`);
    assert.equal(typeof r.body.requestId, "string");
    honesty(r.body);
  }

  const infinite = await postRaw("/verify", '{"chainId":1,"target":"WETH","size":1e400}');
  assert.equal(infinite.status, 400);
  assert.equal(infinite.body.error, "invalid_size");
});

await check("200/503 honesty: every paid route returns checked[] and notChecked[]", async () => {
  // The chain is unreadable in this process, so every valid paid request must
  // fail closed with 503. This exercises each route's failure boundary.
  const cases = [
    ["/verify", { chainId: 1, target: "WETH", size: 1000 }],
    ["/safety", { chainId: 1, tokenAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", intendedUsd: 100 }],
    ["/route", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" }],
    ["/quotecheck", { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000", quotedOut: "1" }],
    ["/depth", { chainId: 1, tokenAddress: "WETH" }],
  ];
  for (const [route, body] of cases) {
    const key = randomUUID();
    const r = await post(route, body, { "x-idempotency-key": key });
    assert.equal(r.status, 503, `${route} status`);
    assert.ok(["rpc_unavailable", "rpc_rate_limited"].includes(r.body.error), `${route} code`);
    honesty(r.body);
    assert.deepEqual(r.body.checked, ["request validation"], `${route} must not claim work that did not run`);
    assert.ok(!JSON.stringify(r.body).includes("FAKE_RPC_SECRET_DO_NOT_LEAK"), `${route} leaked the RPC URL`);
    assert.equal(lookupRecovery({ key, requestHash: requestHash(route, body) }), null,
      `${route} must not stage a recovery record for a failed measurement`);
  }
});

await check("the installed x402 middleware cancels settlement for every >=400 response", () => {
  const source = readFileSync(
    new URL("../node_modules/@x402/express/dist/cjs/index.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(res\.statusCode >= 400\)/,
    "a failed measurement must not settle; this is the middleware guard the 503 contract relies on");
  assert.match(source, /responseStatus: res\.statusCode/);
});

await check("409: a settled idempotency key with changed content conflicts before any work", async () => {
  const key = randomUUID();
  const rh = requestHash("/verify", { chainId: 1, target: "WETH" });
  recordSettlement(key, { verdict: "no_edge" }, null, { settledNow: true, requestHash: rh });

  const r = await post("/verify", { chainId: 1, target: "USDC" }, { "x-idempotency-key": key });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "recovery_conflict");
  assert.equal(r.body.conflict, "request_mismatch");
  assert.equal(typeof r.body.requestId, "string");
  honesty(r.body);
});

await check("409: a reserved idempotency key rejects a concurrent request before work", async () => {
  const key = randomUUID();
  const body = { chainId: 1, target: "WETH" };
  const rh = requestHash("/verify", body);
  const reservation = reserveRecovery({ key, requestHash: rh });
  assert.ok(reservation.token, "test reservation exists");
  try {
    const r = await post("/verify", body, { "x-idempotency-key": key });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "recovery_conflict");
    assert.equal(r.body.code, "operation_in_flight");
    assert.equal(r.body.conflict, "operation_in_flight");
    assert.equal(r.headers.get("retry-after"), "1");
    honesty(r.body);
  } finally {
    releaseRecovery(key, reservation.token);
  }
});

await check("409: a staged settlement blocks a duplicate request", async () => {
  const key = randomUUID();
  const body = { chainId: 1, target: "WETH" };
  const rh = requestHash("/verify", body);
  recordSettlement(key, { verdict: "no_edge" }, null, { requestHash: rh });
  const r = await post("/verify", body, { "x-idempotency-key": key });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "recovery_conflict");
  assert.equal(r.body.code, "settlement_pending");
  assert.equal(r.body.conflict, "operation_in_flight");
  honesty(r.body);
});

await check("429: preflight rate limit is typed and carries a request id", async () => {
  let last;
  for (let i = 0; i < 62; i++) {
    last = await post("/preflight", {});
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error, "rate_limited");
  assert.equal(typeof last.body.requestId, "string");
  assert.equal(last.headers.get("retry-after"), "60");
});

await check("free findings are shareable pages with the evidence on them", async () => {
  const r = await fetch(`${base}/finding/WETH`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/html/);
  const html = await r.text();
  assert.match(html, /<link rel="canonical" href="https:\/\/vex402\.online\/finding\/WETH">/);
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /round trip/);
  // Offline the measurement cannot run; the page must say so and print no number.
  assert.match(html, /could not be measured|verdict/);

  const unknown = await fetch(`${base}/finding/NOTATOKEN`);
  assert.equal(unknown.status, 404, "an arbitrary token must not be a free /verify");

  const json = await (await fetch(`${base}/findings`)).json();
  assert.ok(Array.isArray(json.results) && json.results.length > 0);
  for (const row of json.results) {
    assert.equal(
      row.permalink,
      `https://vex402.online/finding/${encodeURIComponent(row.target)}`,
      "every row must carry the page that shows it",
    );
  }
});

await check("429: /findings has its own per-IP budget", async () => {
  // Audit L-3: /findings was the one free JSON surface with no budget, so it
  // could be driven at whatever rate the caller liked. Its bucket is separate
  // from /preflight's, so the test above is unaffected in either direction.
  let refused = null;
  for (let i = 0; i < FINDINGS_RATE_PER_MIN + 2; i++) {
    const r = await fetch(`${base}/findings`);
    if (r.status === 429) { refused = r; break; }
  }
  assert.ok(refused, `the ${FINDINGS_RATE_PER_MIN + 1}th call in a minute must be refused`);
  assert.equal(refused.status, 429);
  const body = await refused.json();
  assert.equal(body.error, "rate_limited");
  assert.match(body.message, /findings/);
  assert.equal(refused.headers.get("retry-after"), "60");
});

await check("503: RPC transport failure is rpc_unavailable, no verdict, no provider detail", async () => {
  const r = await post("/verify", { chainId: 1, target: "WETH", size: 1000 });
  assert.equal(r.status, 503);
  assert.ok(["rpc_unavailable", "rpc_rate_limited"].includes(r.body.error), `got ${r.body.error}`);
  assert.equal(typeof r.body.requestId, "string");
  honesty(r.body);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes("FAKE_RPC_SECRET_DO_NOT_LEAK"), "the fake RPC URL must never be echoed");
  assert.ok(!/https?:\/\//.test(raw), "no URL may appear in a public error body");
  assert.ok(!/viem|ECONNREFUSED|fetch failed/i.test(raw), "no provider internals may appear");
});

await check("503: /ready is a deep check and fails closed when the chain is unreadable", async () => {
  const r = await fetch(`${base}/ready`);
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.error, "rpc_unavailable");
  assert.equal(body.ok, false);
  assert.equal(body.ready, false);
  assert.equal(typeof body.requestId, "string");
  assert.deepEqual(Object.keys(body).sort(), [...READY_FAILURE_KEYS].sort());
  assert.ok(!JSON.stringify(body).includes("FAKE_RPC_SECRET_DO_NOT_LEAK"));
});

await check("503: /ready supports READY_CHAIN_ID=84532 and fails closed offline", async () => {
  const previous = process.env.READY_CHAIN_ID;
  process.env.READY_CHAIN_ID = "84532";
  try {
    const r = await fetch(`${base}/ready`);
    const body = await r.json();
    assert.equal(r.status, 503, "the closed offline RPC must fail closed");
    assert.equal(body.chainId, 84532, "the request must reach the Base Sepolia readiness path");
    assert.equal(body.ready, false);
    assert.deepEqual(Object.keys(body).sort(), [...READY_FAILURE_KEYS].sort());
    assert.ok(!/FAKE_RPC_SECRET_DO_NOT_LEAK|https?:\/\//.test(JSON.stringify(body)),
      "readiness errors must not echo the RPC URL");
  } finally {
    if (previous === undefined) delete process.env.READY_CHAIN_ID;
    else process.env.READY_CHAIN_ID = previous;
  }
});

await check("200: /ready verifies eth_chainId and returns the block", async () => {
  await withReadinessRpc({ chainId: 42161, rpcChainId: 42161, blockNumber: 42 }, async () => {
    const r = await fetch(`${base}/ready`);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.ready, true);
    assert.equal(body.chainId, 42161);
    assert.equal(body.blockNumber, 42);
    assert.deepEqual(Object.keys(body).sort(), [...READY_OK_KEYS].sort());
  });
});

await check("503: /ready rejects an RPC on the wrong chain", async () => {
  await withReadinessRpc({ chainId: 8453, rpcChainId: 1 }, async () => {
    const r = await fetch(`${base}/ready`);
    const body = await r.json();
    assert.equal(r.status, 503);
    assert.equal(body.error, "rpc_unavailable");
    assert.equal(body.ready, false);
    assert.equal(body.chainId, 8453);
    assert.deepEqual(Object.keys(body).sort(), [...READY_FAILURE_KEYS].sort());
    assert.ok(!/https?:\/\/|FAKE_RPC_SECRET_DO_NOT_LEAK/.test(JSON.stringify(body)));
  });
});

await check("/health stays liveness-only and advertises /ready", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.ready, "/ready");
  assert.equal(body.mode, "testnet");
  assert.equal(body.price, PRICE_DEFAULTS.verify);
  assert.equal(body.preflight, "free");
  assert.deepEqual(Object.keys(body).sort(), [...HEALTH_OK_KEYS].sort());
});

await check("security headers cover HTML and API routes and x-powered-by is disabled", async () => {
  for (const [path, accept] of [["/", "text/html"], ["/docs", "text/html"], ["/openapi.json", "application/json"]]) {
    const r = await fetch(`${base}${path}`, { headers: { accept } });
    assert.equal(r.status, 200, `${path} status`);
    assert.equal(r.headers.get("x-powered-by"), null, `${path} x-powered-by`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", `${path} nosniff`);
    assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin", `${path} referrer policy`);
    assert.equal(r.headers.get("x-frame-options"), "DENY", `${path} frame protection`);
    const csp = r.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /https:\/\/fonts\.googleapis\.com/);
  }
});

await check("CORS allows free GET discovery but never a wildcard on paid routes", async () => {
  const discovery = await fetch(`${base}/openapi.json`);
  assert.equal(discovery.headers.get("access-control-allow-origin"), "*");
  const health = await fetch(`${base}/health`);
  assert.equal(health.headers.get("access-control-allow-origin"), "*");
  const preflight = await fetch(`${base}/openapi.json`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-methods") || "", /GET/);

  const paid = await post("/verify", { chainId: 1, target: "WETH", size: 1000 });
  assert.ok(paid.status >= 400, "paid route must reject the unpaid test call");
  assert.equal(paid.headers.get("access-control-allow-origin"), null);
  const paidOptions = await fetch(`${base}/verify`, { method: "OPTIONS" });
  assert.equal(paidOptions.headers.get("access-control-allow-origin"), null);
  const freeWrite = await fetch(`${base}/preflight`, { method: "OPTIONS" });
  assert.equal(freeWrite.headers.get("access-control-allow-origin"), null);
});

await check("/info and /llms.txt describe quote-based sellability and no banned overclaims", async () => {
  const infoRes = await fetch(`${base}/info`);
  assert.equal(infoRes.status, 200);
  const info = await infoRes.json();
  const text = JSON.stringify(info);
  assert.match(text, /quote-based sellability/i);
  assert.deepEqual(bannedClaimHits(text), [], "no removed claims in /info");
  assert.match(info.chainIdRequired, /missing_chain/);
  assert.match(info.recovery.noCompanionAlias, /no content-hash companion/i);
  assert.equal(info.readiness.path, "/ready");
  assert.equal(info.state_persistence.scope, "process-local");
  assert.equal(info.state_persistence.lostOnRestart, true);
  assert.match(info.state_persistence.warning, /process-local/i);
  assert.match(info.state_persistence.warning, /restart or deploy/i);
  assert.match(info.state_persistence.warning, /not shared across instances/i);
  assert.match(info.hosting.status, /Demo instance runs on a free host/i);

  const llmsRes = await fetch(`${base}/llms.txt`);
  assert.equal(llmsRes.status, 200);
  const llms = await llmsRes.text();
  assert.match(llms, /quote-based sellability/i);
  assert.deepEqual(bannedClaimHits(llms), [], "no removed claims in llms.txt");
});

await check("/openapi.json requires chainId and documents typed 503s", async () => {
  const r = await fetch(`${base}/openapi.json`);
  assert.equal(r.status, 200);
  const doc = await r.json();
  const post = doc.paths["/verify"].post;
  const input = post.requestBody.content["application/json"].schema;
  assert.ok(input.required.includes("chainId"), "/verify requires chainId");
  assert.ok(input.properties.chainId.description.includes("no silent default"));
  assert.match(post.responses["503"].description, /not charged|settlement/i);
  assert.match(doc.info["x-state-persistence"], /process-local/i);
  assert.match(doc.info["x-state-persistence"], /lost on restart or deploy/i);
});

await check("discovery: OpenAPI, manifest, /info, and runtime agree on TTL, limits, prices, and shapes", async () => {
  const [infoRes, manifestRes, openapiRes, healthRes, llmsRes] = await Promise.all([
    fetch(`${base}/info`),
    fetch(`${base}/.well-known/verify402.json`),
    fetch(`${base}/openapi.json`),
    fetch(`${base}/health`),
    fetch(`${base}/llms.txt`),
  ]);
  for (const r of [infoRes, manifestRes, openapiRes, healthRes, llmsRes]) assert.equal(r.status, 200);
  const info = await infoRes.json();
  const manifest = await manifestRes.json();
  const openapi = await openapiRes.json();
  const health = await healthRes.json();
  const llms = await llmsRes.text();

  // Prices: runtime /info, manifest, and OpenAPI all come from the same strings.
  for (const route of ["verify", "safety", "route", "quotecheck", "depth"]) {
    const amount = PRICE_DEFAULTS[route].replace(/^\$/, "");
    assert.equal(info.prices[route], PRICE_DEFAULTS[route], `${route} runtime price`);
    assert.equal(manifest.paymentRequirements.pricing[route].priceUsd, Number(amount), `${route} manifest price`);
    assert.equal(openapi.paths[`/${route}`].post["x-payment-info"].price.amount, amount, `${route} openapi price`);
  }
  assert.equal(health.price, info.prices.verify, "health advertises the runtime /verify price");

  // Idempotency TTL/replays: recovery.mjs is the source; every contract follows it.
  const ttlSeconds = IDEMPOTENCY_TTL_MS / 1000;
  assert.equal(info.recovery.ttlMinutes * 60, ttlSeconds);
  assert.equal(info.recovery.maxReplays, IDEMPOTENCY_MAX_REPLAYS);
  assert.match(manifest.operationalPolicies.idempotency.description, new RegExp(`${ttlSeconds}s`));
  assert.match(manifest.operationalPolicies.idempotency.description, new RegExp(`max ${IDEMPOTENCY_MAX_REPLAYS} replays`));
  const idem = openapi.paths["/verify"].post.parameters.find((p) => p.name === "x-idempotency-key");
  assert.match(idem.description, new RegExp(`${ttlSeconds}s`));
  assert.match(idem.description, new RegExp(`up to ${IDEMPOTENCY_MAX_REPLAYS} times`));

  // Preflight limits: contract.mjs is the source for runtime and both contracts.
  assert.equal(info.preflight.limits.perMinutePerIp, PREFLIGHT_RATE_PER_MIN);
  assert.equal(info.preflight.limits.maxInFlight, PREFLIGHT_MAX_IN_FLIGHT);
  assert.match(manifest.operationalPolicies.rateLimits.preflight, new RegExp(`${PREFLIGHT_RATE_PER_MIN} requests/minute`));
  assert.match(manifest.operationalPolicies.rateLimits.preflight, new RegExp(`max concurrency ${PREFLIGHT_MAX_IN_FLIGHT}`));
  assert.match(openapi.paths["/preflight"].post.description, new RegExp(`max concurrency of ${PREFLIGHT_MAX_IN_FLIGHT}`));

  // Health and readiness shapes.
  const healthSchema = openapi.paths["/health"].get.responses[200].content["application/json"].schema;
  assert.deepEqual([...healthSchema.required].sort(), [...HEALTH_OK_KEYS].sort());
  assert.deepEqual(Object.keys(health).sort(), [...HEALTH_OK_KEYS].sort());
  assert.deepEqual([...manifest.operationalPolicies.endpoints.health.fields].sort(), [...HEALTH_OK_KEYS].sort());
  const readySchema = openapi.paths["/ready"].get.responses[200].content["application/json"].schema;
  const readyFailSchema = openapi.paths["/ready"].get.responses[503].content["application/json"].schema;
  assert.deepEqual([...readySchema.required].sort(), [...READY_OK_KEYS].sort());
  assert.deepEqual([...readyFailSchema.required].sort(), [...READY_FAILURE_KEYS].sort());
  assert.deepEqual([...manifest.operationalPolicies.endpoints.ready.successFields].sort(), [...READY_OK_KEYS].sort());
  assert.deepEqual([...manifest.operationalPolicies.endpoints.ready.failureFields].sort(), [...READY_FAILURE_KEYS].sort());

  // The same banned-claims list covers runtime /info, both machine contracts, and llms.txt.
  assert.deepEqual(bannedClaimHits(JSON.stringify({ info, manifest, openapi })), []);
  assert.deepEqual(bannedClaimHits(llms), []);
});

await check("discovery: all six paid routes appear in x402, OpenAPI prices, and bridge policy", async () => {
  const [x402Res, openapiRes] = await Promise.all([
    fetch(`${base}/.well-known/x402`),
    fetch(`${base}/openapi.json`),
  ]);
  assert.equal(x402Res.status, 200);
  assert.equal(openapiRes.status, 200);
  const x402 = await x402Res.json();
  const openapi = await openapiRes.json();
  const x402Routes = new Set(x402.resources.map((r) => r.url.slice(r.url.lastIndexOf("/") + 1)));
  const toolRoutes = new Set(Object.values(PAID_TOOL_ROUTES));

  for (const route of ["/verify", "/safety", "/route", "/quotecheck", "/depth", "/assure"]) {
    assert.ok(x402Routes.has(route.slice(1)), `${route} missing from /.well-known/x402`);
    assert.ok(openapi.paths[route], `${route} missing from OpenAPI`);
    assert.ok(openapi.paths[route].post["x-payment-info"]?.price?.amount, `${route} missing OpenAPI price`);
    assert.ok(DEFAULT_PAID_ROUTES.includes(route), `${route} missing from bridge paid routes`);
    assert.ok(toolRoutes.has(route), `${route} missing from bridge tool map`);
  }
});

await check("agent card rejects a forged Host and never reflects it", async () => {
  const port = server.address().port;
  const forged = await getWithHost(port, "/.well-known/agent-card.json", "attacker.example");
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error, "untrusted_host");
  assert.equal(forged.body.code, "untrusted_host");
  assert.equal(typeof forged.body.requestId, "string");
  assert.ok(!forged.raw.includes("attacker.example"), "the forged Host must not be reflected");

  const allowed = await getWithHost(port, "/.well-known/agent-card.json", `127.0.0.1:${port}`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.url, `http://127.0.0.1:${port}`);
  assert.ok(allowed.body.services.every((s) => !s.endpoint.includes("attacker.example")));
});

// ---------------------------------------------------------------------------
// A separate process with the paywall ARMED: an unpaid paid route must be 402,
// and the challenge must name the resource and both rails.
// ---------------------------------------------------------------------------
async function waitForHealth(port, child, logs) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) throw new Error(`server exited early:\n${logs.join("")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not become healthy:\n${logs.join("")}`);
}

await check("402: an unpaid paid route returns a payment challenge, never a verdict", async () => {
  const port = 48231;
  const logs = [];
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      X402_MODE: "testnet",
      BYPASS_PAYMENT: "",
      AGENT_URL: "https://fixed.example",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  try {
    await waitForHealth(port, child, logs);
    const r = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: 1, target: "WETH", size: 1000 }),
    });
    assert.equal(r.status, 402);
    assert.equal(r.headers.get("access-control-allow-origin"), null, "paid 402 must not carry a CORS wildcard");
    assert.equal(r.headers.get("x-powered-by"), null);
    const body = await r.json().catch(() => ({}));
    assert.ok(!body.verdict, "a 402 must not contain a verdict");
    const challenge = r.headers.get("payment-required") || r.headers.get("www-authenticate") || "";
    assert.ok(challenge.length > 0, "the 402 must carry a payment challenge header");
    const decoded = Buffer.from(challenge, "base64").toString("utf8");
    const text = decoded.includes("accepts") ? decoded : challenge;
    assert.ok(text.includes("eip155:84532"), "challenge names the EVM testnet rail");
    assert.ok(text.includes("solana:"), "challenge names the Solana testnet rail");

    // CDP's facilitator rejects verify/settle when a resource description is
    // longer than 500 characters, so a route one character over is a paid route
    // that can only ever answer 502. /safety sat at 501 and was unbuyable.
    for (const paidPath of PAID_ROUTES) {
      const rr = await fetch(`http://127.0.0.1:${port}${paidPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(rr.status, 402, `${paidPath} must answer 402 unpaid`);
      const ch = rr.headers.get("payment-required") || "";
      const decodedBody = JSON.parse(Buffer.from(ch, "base64").toString("utf8"));
      const len = (decodedBody.resource?.description || "").length;
      assert.ok(len > 0, `${paidPath} must declare a resource description`);
      assert.ok(len <= 500, `${paidPath} description is ${len} chars; CDP rejects anything over 500`);
    }

    const card = await getWithHost(port, "/.well-known/agent-card.json", "attacker.example");
    assert.equal(card.status, 200);
    assert.equal(card.body.url, "https://fixed.example", "AGENT_URL wins over a forged Host");
    assert.ok(!card.raw.includes("attacker.example"), "the forged Host must not appear in the card");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
  }
});

await check("mainnet refuses to start without AGENT_URL", async () => {
  const logs = [];
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      X402_MODE: "mainnet",
      FACILITATOR_URL: "https://facilitator.payai.network",
      AGENT_URL: "",
      BYPASS_PAYMENT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server did not exit:\n${logs.join("")}`));
    }, 5000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 1);
  assert.match(logs.join(""), /AGENT_URL/);
});

await check("mainnet refuses to start without PREFLIGHT_SECRET", async () => {
  const logs = [];
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      X402_MODE: "mainnet",
      FACILITATOR_URL: "https://facilitator.payai.network",
      AGENT_URL: "https://fixed.example",
      PREFLIGHT_SECRET: "",
      BYPASS_PAYMENT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server did not exit:\n${logs.join("")}`));
    }, 5000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 1);
  assert.match(logs.join(""), /PREFLIGHT_SECRET/);
});

await check("mainnet refuses to start without MAINNET_ALWAYS_ON_CONFIRMED", async () => {
  const logs = [];
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      X402_MODE: "mainnet",
      FACILITATOR_URL: "https://facilitator.payai.network",
      AGENT_URL: "https://fixed.example",
      PREFLIGHT_SECRET: "secret",
      MAINNET_ALWAYS_ON_CONFIRMED: "",
      REQUIRE_ALWAYS_ON: "",
      ALLOW_MAINNET_ON_FREE_TIER: "",
      BYPASS_PAYMENT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server did not exit:\n${logs.join("")}`));
    }, 5000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 1);
  assert.match(logs.join(""), /MAINNET_ALWAYS_ON_CONFIRMED/);
});

await check("mainnet refuses free-tier acknowledgement override", async () => {
  const logs = [];
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      X402_MODE: "mainnet",
      FACILITATOR_URL: "https://facilitator.payai.network",
      AGENT_URL: "https://fixed.example",
      PREFLIGHT_SECRET: "secret",
      MAINNET_ALWAYS_ON_CONFIRMED: "yes",
      ALLOW_MAINNET_ON_FREE_TIER: "1",
      BYPASS_PAYMENT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server did not exit:\n${logs.join("")}`));
    }, 5000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 1);
  assert.match(logs.join(""), /ALLOW_MAINNET_ON_FREE_TIER/);
});

await check("GET /inspect serves the inspector page", async () => {
  const res = await fetch(`${base}/inspect`, { headers: { accept: "text/html" } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /inspect-demo\.js/);
});

await check("POST /inspect refuses a private URL before any fetch", async () => {
  const res = await fetch(`${base}/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${base}/verify`, method: "POST" }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.code, "blocked_host");
});

await check("POST /inspect preflights a pasted challenge end to end", async () => {
  const challenge = {
    x402Version: 2,
    resource: "https://example.com/paid",
    accepts: [{
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "30000",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
    }],
  };
  const res = await fetch(`${base}/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge, target: "https://example.com/paid" }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.verdict, "PASS");
  assert.equal(json.options.length, 1);
  assert.ok(json.receipt?.signature);
});

await check("GET /directory serves the directory page", async () => {
  const res = await fetch(`${base}/directory`, { headers: { accept: "text/html" } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /directory\.js/);
});

// Raw request so the Host header can be set (fetch does not allow it).
const rawGet = (path, headers = {}) => new Promise((resolve, reject) => {
  const { port } = server.address();
  const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
    res.resume();
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
  });
  req.on("error", reject);
  req.end();
});

await check("search: www, http, .html and trailing slash 301 to one clean https address", async () => {
  const cases = [
    ["/checks", { host: "www.vex402.online" }, "https://vex402.online/checks"],
    ["/checks", { host: "vex402.online", "cf-visitor": '{"scheme":"http"}' }, "https://vex402.online/checks"],
    ["/checks.html", { host: "vex402.online" }, "https://vex402.online/checks"],
    ["/checks/", { host: "vex402.online" }, "https://vex402.online/checks"],
    ["/inspect/?url=x", { host: "vex402.online" }, "https://vex402.online/inspect?url=x"],
  ];
  for (const [path, headers, location] of cases) {
    const r = await rawGet(path, headers);
    assert.equal(r.status, 301, `${headers.host}${path}`);
    assert.equal(r.headers.location, location);
  }
  const clean = await rawGet("/checks", { host: "vex402.online", "cf-visitor": '{"scheme":"https"}' });
  assert.equal(clean.status, 200, "the clean address is served, not redirected");
  const local = await rawGet("/checks.html", { host: "127.0.0.1" });
  assert.notEqual(local.status, 301, "other hosts are left alone");
});

await check("watch: bad input is refused before payment, with a typed 400", async () => {
  const post = (body) => fetch(`${base}/watch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const cases = [
    [{ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", webhookUrl: "https://hooks.example/x" }, "missing_chain"],
    [{ chainId: 8453, address: "not-an-address", webhookUrl: "https://hooks.example/x" }, "invalid_address"],
    [{ chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", webhookUrl: "http://hooks.example/x" }, "invalid_webhookUrl"],
    [{ chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", webhookUrl: "https://127.0.0.1/x" }, "invalid_webhookUrl"],
  ];
  for (const [body, code] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, code);
    assert.equal((await r.json()).error, code);
  }
});

await check("watch: status of an unknown watch is a 404, never another watch", async () => {
  for (const id of ["w_00000000000000000000000000000000", "not-an-id"]) {
    const r = await fetch(`${base}/watch/${id}`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, "watch_not_found");
  }
});

await check("search: pages are indexable; API answers and query-string pages are noindex", async () => {
  const page = await fetch(`${base}/checks`, { headers: { accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), null);
  const withQuery = await fetch(`${base}/inspect?url=https%3A%2F%2Fexample.com`, { headers: { accept: "text/html" } });
  assert.equal(withQuery.headers.get("x-robots-tag"), "noindex");
  for (const p of ["/info", "/findings", "/openapi.json", "/llms.txt"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.headers.get("x-robots-tag"), "noindex", p);
  }
  for (const p of ["/robots.txt", "/sitemap.xml"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("x-robots-tag"), null, p);
  }
});

await check("GET /directory.json returns the watch shape", async () => {
  const res = await fetch(`${base}/directory.json`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.mode, "memory");
  assert.ok(Array.isArray(json.entries));
  assert.ok(json.intervalMinutes >= 1);
});

await check("POST /usage/ping rejects unknown tool names and non-boolean ok", async () => {
  const badTool = await fetch(`${base}/usage/ping`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-verify402-client": "verify402-mcp/1.1.0" },
    body: JSON.stringify({ tool: "not_a_tool", ok: true }),
  });
  assert.equal(badTool.status, 400);
  const badOk = await fetch(`${base}/usage/ping`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-verify402-client": "verify402-mcp/1.1.0" },
    body: JSON.stringify({ tool: "preflight_gate", ok: "yes" }),
  });
  assert.equal(badOk.status, 400);
});

await check("POST /usage/ping accepts a valid ping and counts it", async () => {
  const before = await fetch(`${base}/usage`).then((r) => r.json());
  const res = await fetch(`${base}/usage/ping`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-verify402-client": "verify402-mcp/1.1.0" },
    body: JSON.stringify({ tool: "inspect_402", ok: true }),
  });
  assert.equal(res.status, 202);
  const after = await fetch(`${base}/usage`).then((r) => r.json());
  assert.ok(after.total > before.total, "total must increase");
  assert.ok(after.byTool.inspect_402 >= 1, "byTool must record inspect_402");
  assert.ok(after.byKind["mcp:inspect_402"] >= 1, "byKind must record mcp:inspect_402");
  assert.ok(after.mcpPings >= 1, "mcpPings must be exposed");
  assert.ok(after.byClientSource["mcp-ping"] >= 1, "mcp-ping source must be recorded");
});

await check("POST /inspect counts the target host without leaking path or identity", async () => {
  const before = await fetch(`${base}/usage`).then((r) => r.json());
  await fetch(`${base}/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${base}/verify`, method: "POST" }),
  });
  const after = await fetch(`${base}/usage`).then((r) => r.json());
  assert.equal(typeof after.byInspectHost, "object", "usage must expose byInspectHost");
  const host = new URL(base).hostname;
  const n = (after.byInspectHost || {})[host] || 0;
  const n0 = (before.byInspectHost || {})[host] || 0;
  assert.ok(n > n0, "target host count must increase");
});

await check("settlement reference: the documented v2 PAYMENT-SIGNATURE header yields a ref", async () => {
  const nonce = "0x" + "11".repeat(32);
  const from = "0x" + "22".repeat(20);
  const env = { x402Version: 2, payload: { authorization: { from, nonce, validBefore: "9999999999" }, signature: "0xdead" } };
  const raw = Buffer.from(JSON.stringify(env)).toString("base64");

  const v2 = paymentRefFromRequest({ get: (h) => (String(h).toLowerCase() === "payment-signature" ? raw : undefined) }, { chainId: 8453 });
  assert.ok(v2, "PAYMENT-SIGNATURE must produce a reconciliation reference");
  assert.equal(v2.nonce, nonce);
  assert.match(v2.proofHash, /^[0-9a-f]{64}$/);

  const legacy = paymentRefFromRequest({ get: (h) => (String(h).toLowerCase() === "x-payment" ? raw : undefined) }, { chainId: 8453 });
  assert.equal(legacy?.nonce, nonce, "legacy x-payment stays accepted");

  const solEnv = { x402Version: 2, payload: { transaction: "c29sYW5hLXR4" } };
  const solRaw = Buffer.from(JSON.stringify(solEnv)).toString("base64");
  const sol = paymentRefFromRequest({ get: (h) => (String(h).toLowerCase() === "payment-signature" ? solRaw : undefined) }, { chainId: 8453 });
  assert.ok(sol && sol.txHash && sol.nonce === null, "the Solana rail gets a transaction identity");
});

await check("503: a stuck operation answers payment_unresolved with no Retry-After", async () => {
  const key = "6f1c2f7e-3b5a-4c9d-8e21-2a7b4c6d8e10";
  const staged = recordSettlement(key, { ok: true, verdict: "PASS", stuckProbe: true }, null, { settledNow: false });
  const realNow = Date.now();
  _setNow(() => realNow + IDEMPOTENCY_STAGE_TTL_MS + 1);
  let outcome;
  try {
    outcome = await reconcileStagedEntry(staged.operationId);
  } finally {
    _setNow(() => Date.now());
  }
  assert.equal(outcome, "stuck");
  const r = await post("/verify", { chainId: 8453 }, { "x-idempotency-key": key });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "payment_unresolved");
  assert.equal(r.body.retry, "same_payment");
  assert.equal(r.headers.get("retry-after"), null, "the block is not time-based");
  assert.equal(typeof r.body.requestId, "string");
});

await check("info: recovery observability surfaces the stuck counter", async () => {
  const r = await fetch(`${base}/info`);
  const body = await r.json();
  const obs = body.recovery?.observability;
  assert.ok(obs, "recovery.observability present");
  assert.equal(typeof obs.stuck, "number");
  assert.equal(typeof obs.settling, "number");
  assert.ok(obs.stuckTotal >= 1, "the stuck operation above is counted");
});

await check("400: a malformed JSON body answers JSON, never an HTML stack trace", async () => {
  const r = await postRaw("/preflight", "{bad");
  assert.equal(r.status, 400);
  assert.match(r.headers.get("content-type") || "", /application\/json/);
  assert.equal(r.body.error, "invalid_json");
  assert.equal(r.body.code, "invalid_json");
  assert.equal(typeof r.body.requestId, "string");
  assert.ok(r.body.requestId.length > 0);
  assert.equal(r.headers.get("x-request-id"), r.body.requestId);
  const text = JSON.stringify(r.body);
  assert.doesNotMatch(text, /node_modules|SyntaxError|body-parser|at JSON\.parse/);
});

await check("413: a body over the 64KB cap answers JSON with payload_too_large", async () => {
  const r = await postRaw("/preflight", JSON.stringify({ kind: "payment", pad: "a".repeat(70_000) }));
  assert.equal(r.status, 413);
  assert.match(r.headers.get("content-type") || "", /application\/json/);
  assert.equal(r.body.code, "payload_too_large");
  assert.equal(typeof r.body.requestId, "string");
  assert.equal(r.headers.get("x-request-id"), r.body.requestId);
});

// HTTP-level proof for path (a): the facilitator explicitly refuses settlement,
// the rail is unreadable in this process (no payment checker is wired), and a
// retry with the same key must reach the paywall again instead of receiving the
// staged verdict.
await check("HTTP: explicit facilitator failure (no reason) delivers no verdict on retry", async () => {
  const key = randomUUID();
  const verdict = { ok: true, verdict: "no_edge", MUST_NOT_LEAK: "FAILURE_PROBE_DO_NOT_DELIVER" };
  const NETWORK = "eip155:8453";
  const PAY_TO = "0x0000000000000000000000000000000000000001";
  const accepts = [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAY_TO }];
  const facilitator = {
    counts: { supported: 0, verify: 0, settle: 0 },
    async getSupported() {
      this.counts.supported++;
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [] };
    },
    async verify() {
      this.counts.verify++;
      return { isValid: true, payer: PAY_TO };
    },
    async settle() {
      this.counts.settle++;
      // A real facilitator rejection with no errorReason. The SDK maps this to
      // the synthetic reason "Settlement failed"; it is still a failure.
      return { success: false, transaction: "", network: NETWORK };
    },
  };
  const resourceServer = registerRecoveryHooks(
    new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme()),
    { logError: () => {} },
  );

  // Prove the precondition: with no checker wired, an unknown-outcome settling
  // record WOULD replay. This failure must not be left in that state.
  setRecoveryPaymentChecker(null);
  const controlKey = randomUUID();
  const controlNonce = "0x" + "5a".repeat(32);
  recordSettlement(controlKey, { ok: true, verdict: "control" }, null, {
    settledNow: false,
    paymentRef: { nonce: controlNonce, network: NETWORK },
  });
  const marker = markSettling({ paymentPayload: { payload: { authorization: { nonce: controlNonce } } } });
  assert.equal(marker.matched, 1, "control settlement must be journaled");
  assert.ok(lookupRecovery({ key: controlKey })?.hit, "unreadable-rail precondition must hold");

  let stagedRef = null;
  const failureApp = express();
  failureApp.use(express.json());
  failureApp.use((req, res, next) => {
    if (req.method !== "POST" || req.path !== "/paid-failure") return next();
    const rawKey = req.get("x-idempotency-key");
    if (!rawKey) return next();
    const found = lookupRecovery({ key: rawKey, requestHash: requestHash(req.path, req.body || {}) });
    if (found?.hit) return res.json(found.hit.payload);
    if (found?.pending) return res.status(409).json({ error: "recovery_pending", code: found.pending });
    return next();
  });
  failureApp.use(paymentMiddleware({
    "POST /paid-failure": { accepts, description: "explicit failure probe", mimeType: "application/json" },
  }, resourceServer));
  failureApp.post("/paid-failure", (_req, res) => {
    recordSettlement(key, verdict, null, { settledNow: false, paymentRef: stagedRef });
    res.json(verdict);
  });

  const srv = await new Promise((resolve) => {
    const s = failureApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  const failureBase = `http://127.0.0.1:${srv.address().port}`;
  const body = JSON.stringify({ test: true });
  try {
    const challenge = await fetch(`${failureBase}/paid-failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(challenge.status, 402);
    const challengeBody = JSON.parse(Buffer.from(challenge.headers.get("payment-required"), "base64").toString("utf8"));
    const accepted = challengeBody.accepts[0];
    const nonce = "0x" + "77".repeat(32);
    const envelope = {
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
          nonce,
        },
      },
    };
    const raw = Buffer.from(JSON.stringify(envelope)).toString("base64");
    stagedRef = paymentRefFromRequest(
      { get: (h) => (String(h).toLowerCase() === "payment-signature" ? raw : undefined) },
      { chainId: 8453 },
    );
    assert.ok(stagedRef?.nonce === nonce, "the test payment must match the staged operation");

    const paidHeaders = {
      "content-type": "application/json",
      "x-idempotency-key": key,
      "payment-signature": raw,
    };
    const first = await fetch(`${failureBase}/paid-failure`, { method: "POST", headers: paidHeaders, body });
    const firstText = await first.text();
    assert.equal(first.status, 402, `explicit failure must leave the key payable again: ${firstText}`);
    assert.doesNotMatch(firstText, /FAILURE_PROBE_DO_NOT_DELIVER/, "no verdict may be delivered");
    assert.equal(lookupRecovery({ key }), null, "a reported failure must not leave a replayable record");

    const second = await fetch(`${failureBase}/paid-failure`, { method: "POST", headers: paidHeaders, body });
    const secondText = await second.text();
    assert.equal(second.status, 402, `retry after failure must still reach the paywall: ${secondText}`);
    assert.doesNotMatch(secondText, /FAILURE_PROBE_DO_NOT_DELIVER/, "no verdict may be delivered on retry");
    assert.equal(facilitator.counts.settle, 2, "each new payment attempt settles once; no replay shortcut");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

await check("a wrapped SettleError rejection is still classified as definitive", () => {
  const inner = new Error("Settlement failed");
  inner.name = "SettleError";
  inner.statusCode = 400;
  inner.errorReason = "Settlement failed";
  inner.transaction = "";
  const outer = new Error("facilitator settle failed");
  outer.name = "FacilitatorResponseError";
  outer.cause = inner;
  assert.equal(isDefinitiveSettlementFailure(outer), true, "our client's cause chain must not hide a rejection");
});

server.close();
console.log(`\nhttp: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
