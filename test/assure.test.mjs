// /assure: the bundle of paid checks. No real payment, no real chain.
//
//   * A fake JSON-RPC answers eth_blockNumber so the bundle pins a block.
//   * A fake private engine answers the paid engines with canned results and
//     counts every call, so a test can prove a refused bundle did no paid work.
//   * BYPASS_PAYMENT=1 reaches the handler; a separate child process with the
//     paywall armed proves the price guard answers BEFORE any 402 challenge.
//
//   node test/assure.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
  });
}

// ---- fake chain -----------------------------------------------------------
const BLOCK = 4242;
const rpc = await listen(async (req, res) => {
  const body = await readJson(req);
  const calls = Array.isArray(body) ? body : [body];
  const answer = calls.map((c) => ({
    jsonrpc: "2.0",
    id: c?.id ?? 1,
    result: c?.method === "eth_chainId" ? "0x2105" : `0x${BLOCK.toString(16)}`,
  }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(body) ? answer : answer[0]));
});

// ---- fake private engine --------------------------------------------------
const engineCalls = [];
let engineMode = "ok";
let safetyVerdict = "TRUST";
const ENGINE_TOKEN = "test-engine-token";
const engine = await listen(async (req, res) => {
  const name = decodeURIComponent(req.url.split("/").pop());
  await readJson(req);
  engineCalls.push(name);
  if (req.headers.authorization !== `Bearer ${ENGINE_TOKEN}`) {
    res.writeHead(401).end("{}");
    return;
  }
  if (engineMode === "fail") {
    res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
    return;
  }
  const results = {
    safety: { ok: true, verdict: safetyVerdict, checked: ["contract_code"], notChecked: ["transfer restrictions"] },
    quotecheck: { ok: true, verdict: "fair", checked: ["venue_book"], notChecked: [] },
    depth: { ok: true, capacityUsd: 1000, checked: ["ladder"], notChecked: [] },
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(results[name] ?? { ok: true }));
});

process.env.X402_MODE = "testnet";
process.env.BYPASS_PAYMENT = "1";
process.env.TEST_OFFLINE = "1";
process.env.TEST_OFFLINE_RPC_URL = `http://127.0.0.1:${rpc.address().port}/`;
process.env.VERIFY402_ENGINE_URL = `http://127.0.0.1:${engine.address().port}`;
process.env.VERIFY402_ENGINE_TOKEN = ENGINE_TOKEN;

const { canonicalStable, sha256Hex } = await import("../src/recovery.mjs");
const { app } = await import("../src/server.mjs");

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  engineCalls.length = 0;
  engineMode = "ok";
  safetyVerdict = "TRUST";
  try {
    await fn();
    passed++;
    console.log(`  ${name} ... PASS`);
  } catch (e) {
    failed++;
    console.log(`  ${name} ... FAIL\n      ${e.message}`);
  }
}

async function post(path, body, url = base) {
  const r = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await r.json(); } catch { /* checked by the caller */ }
  return { status: r.status, headers: r.headers, body: json };
}

const TOKEN = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SAFETY = { tokenAddress: TOKEN };
const QUOTE = { tokenIn: USDC, tokenOut: TOKEN, amountIn: "1000000", quotedOut: "300000000000000" };
const DEPTH = { tokenAddress: TOKEN };
const FULL = { chainId: 8453, safety: SAFETY, quotecheck: QUOTE, depth: DEPTH };

console.log("\n/assure bundle");

await check("400 insufficient_checks: a bundle worth less than its price is refused, no paid work", async () => {
  const r = await post("/assure", { chainId: 8453, safety: SAFETY });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "insufficient_checks");
  assert.deepEqual(r.body.supplied, ["safety"]);
  assert.ok(r.body.suppliedSeparateUsd < r.body.assurePriceUsd);
  assert.equal(engineCalls.length, 0, "no engine call for a refused bundle");
});

await check("400 insufficient_checks: the trailing-slash path is guarded too", async () => {
  const r = await post("/assure/", { chainId: 8453, depth: DEPTH });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "insufficient_checks");
  assert.equal(engineCalls.length, 0);
});

await check("400 no_paid_checks: an empty bundle reaches the handler and is refused", async () => {
  const r = await post("/assure", { chainId: 8453 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "no_paid_checks");
  assert.equal(engineCalls.length, 0);
});

await check("400: an empty safety section is refused, never silently skipped while priced", async () => {
  // safety {} is counted at $0.02 by the price guard; it must not let the
  // caller pay the bundle price for fewer checks than were priced.
  const r = await post("/assure", { chainId: 8453, safety: {}, quotecheck: QUOTE, depth: DEPTH });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "missing_tokenAddress");
  assert.ok(!r.body.assurance, "no assurance on a refused bundle");
});

await check("400: incomplete route/quotecheck/depth sections are refused", async () => {
  for (const [field, code] of [["route", "missing_route_fields"], ["quotecheck", "missing_quotecheck_fields"], ["depth", "missing_tokenAddress"]]) {
    const body = { ...FULL, [field]: {} };
    const r = await post("/assure", body);
    assert.equal(r.status, 400, `${field} {} must be 400`);
    assert.equal(r.body.error, code, `${field} {} code`);
  }
});

await check("200: a full bundle runs every section at one pinned block", async () => {
  const r = await post("/assure", FULL);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.blockNumber, BLOCK);
  assert.deepEqual(Object.keys(r.body.sections).sort(), ["depth", "quotecheck", "safety"]);
  assert.deepEqual([...engineCalls].sort(), ["depth", "quotecheck", "safety"]);
  assert.equal(r.body.verdict, "PASS");
  assert.ok(r.body.notChecked.includes("route: not requested"));
});

await check("200: assurance.evidenceHash is recomputable from the response body", async () => {
  const r = await post("/assure", FULL);
  assert.equal(r.status, 200);
  const { spec, chainId, chainName, blockNumber, checked, notChecked, sections, verdict } = r.body;
  const hash = `sha256:${sha256Hex(canonicalStable({ spec, chainId, chainName, blockNumber, checked, notChecked, sections, verdict }))}`;
  assert.equal(r.body.assurance.evidenceHash, hash);
  // Any edit to the evidence must change the hash.
  const tampered = `sha256:${sha256Hex(canonicalStable({ spec, chainId, chainName, blockNumber, checked, notChecked, sections, verdict: "PASS!" }))}`;
  assert.notEqual(tampered, hash);
});

await check("200: one AVOID section makes the whole bundle AVOID", async () => {
  safetyVerdict = "AVOID";
  const r = await post("/assure", { ...FULL, depth: { ...DEPTH, sizesUsd: [10] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.verdict, "AVOID");
});

await check("503: an engine failure returns no verdict and no assurance (settlement cancelled)", async () => {
  engineMode = "fail";
  const r = await post("/assure", { ...FULL, depth: { ...DEPTH, sizesUsd: [20] } });
  assert.ok(r.status >= 500, `expected 5xx, got ${r.status}`);
  assert.ok(!r.body.verdict, "no verdict on failure");
  assert.ok(!r.body.assurance, "no evidence hash on failure");
});

// ---- paywall armed: the guard must answer before any 402 -------------------
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

await check("paywall armed: an under-valued bundle gets 400 with no payment challenge; an empty probe still gets 402", async () => {
  const port = 48247;
  const logs = [];
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), X402_MODE: "testnet", BYPASS_PAYMENT: "", AGENT_URL: "https://fixed.example" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  try {
    await waitForHealth(port, child, logs);
    const url = `http://127.0.0.1:${port}`;
    const under = await post("/assure", { chainId: 8453, safety: SAFETY }, url);
    assert.equal(under.status, 400);
    assert.equal(under.body.error, "insufficient_checks");
    assert.equal(under.headers.get("payment-required"), null, "no challenge means nothing to sign");
    const probe = await post("/assure", {}, url);
    assert.equal(probe.status, 402, "discovery probes must still see the challenge");
    assert.ok(probe.headers.get("payment-required"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
  }
});

console.log(`\nassure: ${passed} passed, ${failed} failed\n`);
server.close();
rpc.close();
engine.close();
process.exit(failed ? 1 : 0);
