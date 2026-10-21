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

process.env.X402_MODE = "testnet";
process.env.BYPASS_PAYMENT = "1";
process.env.ETH_RPC_URL = "http://127.0.0.1:1/FAKE_RPC_SECRET_DO_NOT_LEAK";
// `npm run test:offline` sets TEST_OFFLINE=1, which makes clientFor ignore the
// public fallbacks. Keep the same closed endpoint so the leak assertions still
// exercise the real error path.
process.env.TEST_OFFLINE_RPC_URL = "http://127.0.0.1:1/FAKE_RPC_SECRET_DO_NOT_LEAK";

const { app } = await import("../src/server.mjs");
const { recordSettlement, requestHash, lookupRecovery } = await import("../src/recovery.mjs");

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
  assert.equal(body.ready, false);
  assert.equal(typeof body.requestId, "string");
  assert.ok(!JSON.stringify(body).includes("FAKE_RPC_SECRET_DO_NOT_LEAK"));
});

await check("/health stays liveness-only and advertises /ready", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.ready, "/ready");
});

await check("/info and /llms.txt describe quote-based sellability and no banned overclaims", async () => {
  const infoRes = await fetch(`${base}/info`);
  assert.equal(infoRes.status, 200);
  const info = await infoRes.json();
  const text = JSON.stringify(info);
  assert.match(text, /quote-based sellability/i);
  assert.ok(!/honeypot test|honeypot probe|every venue\b/i.test(text), "no removed claims in /info");
  assert.match(info.chainIdRequired, /missing_chain/);
  assert.match(info.recovery.noCompanionAlias, /no content-hash companion/i);
  assert.equal(info.readiness.path, "/ready");

  const llmsRes = await fetch(`${base}/llms.txt`);
  assert.equal(llmsRes.status, 200);
  const llms = await llmsRes.text();
  assert.match(llms, /quote-based sellability/i);
  assert.ok(!/honeypot test|honeypot probe|every venue\b/i.test(llms), "no removed claims in llms.txt");
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
    const body = await r.json().catch(() => ({}));
    assert.ok(!body.verdict, "a 402 must not contain a verdict");
    const challenge = r.headers.get("payment-required") || r.headers.get("www-authenticate") || "";
    assert.ok(challenge.length > 0, "the 402 must carry a payment challenge header");
    const decoded = Buffer.from(challenge, "base64").toString("utf8");
    const text = decoded.includes("accepts") ? decoded : challenge;
    assert.ok(text.includes("eip155:84532"), "challenge names the EVM testnet rail");
    assert.ok(text.includes("solana:"), "challenge names the Solana testnet rail");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
  }
});

server.close();
console.log(`\nhttp: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
