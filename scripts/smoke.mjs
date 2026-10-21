// Post-deploy smoke test.
//
//   node scripts/smoke.mjs
//   SMOKE_PAID=1 node scripts/smoke.mjs
//
// Always checks /ready and the free preflight gate (including receipt
// verification). SMOKE_PAID=1 also buys exactly one paid call on the configured
// testnet instance, using the MCP bridge's first-payment script. It refuses to
// spend against mainnet and refuses without an explicit buyer key.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SMOKE_BASE_URL || process.env.VERIFY402_URL || "https://verify402.onrender.com").replace(/\/$/, "");
const SMOKE_PAID = process.env.SMOKE_PAID === "1";

const PREFLIGHT_INTENT = {
  kind: "payment",
  payment: {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "10000",
    payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
    resource: `${BASE_URL}/verify`,
  },
  policy: { maxAmountUsd: 0.25 },
};

function fail(message, detail = null) {
  const suffix = detail == null ? "" : `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

async function request(method, route, body = null) {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text for diagnostics */ }
  if (!res.ok) fail(`${method} ${route} returned HTTP ${res.status}`, json ?? text.slice(0, 500));
  return { res, json, text };
}

console.log(`verify402 smoke test: ${BASE_URL}`);

const health = (await request("GET", "/health")).json;
if (health?.ok !== true) fail("/health did not report ok:true", health);
console.log(`  /health ... ok (${health.mode})`);

const ready = (await request("GET", "/ready")).json;
if (ready?.ok !== true || ready?.ready !== true || !Number.isInteger(ready?.blockNumber)) {
  fail("/ready did not report a readable chain", ready);
}
console.log(`  /ready ... ok (chain ${ready.chainId}, block ${ready.blockNumber}, ${ready.latencyMs}ms)`);

const pre = (await request("POST", "/preflight", PREFLIGHT_INTENT)).json;
if (!["PASS", "CAUTION", "BLOCK"].includes(pre?.verdict)) fail("/preflight returned no three-state verdict", pre);
if (!pre?.receipt || typeof pre.receipt !== "object") fail("/preflight returned no receipt", pre);
if (!Array.isArray(pre?.checked) || !Array.isArray(pre?.notChecked)) fail("/preflight omitted checked/notChecked", pre);
console.log(`  /preflight ... ok (${pre.verdict}, ${pre.checked.length} checked, ${pre.notChecked.length} notChecked)`);

const verified = (await request("POST", "/preflight/verify", { receipt: pre.receipt })).json;
if (verified?.valid !== true) fail("/preflight/verify rejected the receipt it just issued", verified);
console.log("  /preflight/verify ... ok (HMAC + expiry valid)");

if (SMOKE_PAID) {
  if (health.mode !== "testnet") fail("SMOKE_PAID=1 refused: the target is not a testnet instance");
  if (!process.env.EVM_PRIVATE_KEY) fail("SMOKE_PAID=1 requires EVM_PRIVATE_KEY for the buyer wallet");
  console.log("  paid testnet call ... buying one /route answer");
  const child = spawn(process.execPath, ["first-payment.mjs"], {
    cwd: path.join(ROOT, "mcp-bridge"),
    env: {
      ...process.env,
      VERIFY402_URL: BASE_URL,
      MAX_PAYMENT_USD: process.env.MAX_PAYMENT_USD || "0.03",
    },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (code !== 0) fail(`paid testnet call failed with exit code ${code}`);
  console.log("  paid testnet call ... ok");
}

console.log("smoke: PASS");
