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
  PREFLIGHT_MAX_IN_FLIGHT,
  HEALTH_OK_KEYS,
  READY_OK_KEYS,
  READY_FAILURE_KEYS,
  bannedClaimHits,
} = await import("../src/contract.mjs");
const {
  recordSettlement, requestHash, lookupRecovery,
  IDEMPOTENCY_TTL_MS, IDEMPOTENCY_MAX_REPLAYS,
} = await import("../src/recovery.mjs");
const { app } = await import("../src/server.mjs");

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
  assert.equal(body.ok, false);
  assert.equal(body.ready, false);
  assert.equal(typeof body.requestId, "string");
  assert.deepEqual(Object.keys(body).sort(), [...READY_FAILURE_KEYS].sort());
  assert.ok(!JSON.stringify(body).includes("FAKE_RPC_SECRET_DO_NOT_LEAK"));
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
  assert.equal(info.state_persistence.scope, "process-local");
  assert.equal(info.state_persistence.lostOnRestart, true);
  assert.match(info.state_persistence.warning, /process-local/i);
  assert.match(info.state_persistence.warning, /restart or deploy/i);
  assert.match(info.state_persistence.warning, /not shared across instances/i);

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
    const body = await r.json().catch(() => ({}));
    assert.ok(!body.verdict, "a 402 must not contain a verdict");
    const challenge = r.headers.get("payment-required") || r.headers.get("www-authenticate") || "";
    assert.ok(challenge.length > 0, "the 402 must carry a payment challenge header");
    const decoded = Buffer.from(challenge, "base64").toString("utf8");
    const text = decoded.includes("accepts") ? decoded : challenge;
    assert.ok(text.includes("eip155:84532"), "challenge names the EVM testnet rail");
    assert.ok(text.includes("solana:"), "challenge names the Solana testnet rail");

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

server.close();
console.log(`\nhttp: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
