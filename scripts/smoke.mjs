// Post-deploy smoke test.
//
//   node scripts/smoke.mjs
//   SMOKE_BASE_URL=http://127.0.0.1:4021 node scripts/smoke.mjs
//   SMOKE_PAID=1 EVM_PRIVATE_KEY=0x... node scripts/smoke.mjs   (testnet only)
//
// Checks every public boundary that can be verified without a payment, then
// optionally buys one real answer on a testnet instance. Prints PASS/FAIL for
// each check and exits non-zero if any check fails.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "https://verify402.onrender.com";

export function normalizeBaseUrl(raw) {
  return String(raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

const PREFLIGHT_INTENT = {
  kind: "payment",
  payment: {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "10000",
    payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
    resource: null,
  },
  policy: { maxAmountUsd: 0.25 },
};

const BLOCK_INTENT = {
  kind: "payment",
  payment: {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "1000000000",
    payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
    resource: null,
  },
  policy: { maxAmountUsd: 0.25 },
};

const MISSING_CHAIN_INTENT = {
  kind: "transaction",
  transaction: { to: "0x0000000000000000000000000000000000000001", value: "0", data: "0x" },
  policy: { maxValueUsd: 1 },
};

async function rawRequest(fetchImpl, baseUrl, method, route, body = null, headers = {}) {
  const res = await fetchImpl(`${baseUrl}${route}`, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { res, json, text };
}

export async function runSmoke({ baseUrl, env = process.env, fetchImpl = fetch, log = console.log, spawnImpl = spawn } = {}) {
  const base = normalizeBaseUrl(baseUrl || env.SMOKE_BASE_URL || env.VERIFY402_URL);
  const paid = env.SMOKE_PAID === "1";
  const agentUrl = env.AGENT_URL || base;
  const expectedHost = new URL(agentUrl).host;
  const results = [];

  async function check(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      log(`  ${name} ... PASS`);
    } catch (error) {
      results.push({ name, ok: false, error: error?.message ?? String(error) });
      log(`  ${name} ... FAIL (${error?.message ?? error})`);
    }
  }

  log(`verify402 smoke test: ${base}`);

  let health = null;
  await check("/health", async () => {
    const { res, json } = await rawRequest(fetchImpl, base, "GET", "/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json?.ok !== true) throw new Error("ok !== true");
    health = json;
  });

  await check("/ready", async () => {
    const { res, json } = await rawRequest(fetchImpl, base, "GET", "/ready");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json?.ok !== true || json?.ready !== true || !Number.isInteger(json?.blockNumber)) {
      throw new Error("chain not readable");
    }
  });

  await check("/preflight PASS/CAUTION/BLOCK verdict", async () => {
    const intent = { ...PREFLIGHT_INTENT, payment: { ...PREFLIGHT_INTENT.payment, resource: `${base}/verify` } };
    const { res, json } = await rawRequest(fetchImpl, base, "POST", "/preflight", intent);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!["PASS", "CAUTION", "BLOCK"].includes(json?.verdict)) throw new Error("no three-state verdict");
    if (!json?.receipt || typeof json.receipt !== "object") throw new Error("no receipt");
    if (!Array.isArray(json?.checked) || !Array.isArray(json?.notChecked)) throw new Error("missing checked/notChecked");
  });

  await check("/preflight known-bad payload returns BLOCK", async () => {
    const intent = { ...BLOCK_INTENT, payment: { ...BLOCK_INTENT.payment, resource: `${base}/verify` } };
    const { res, json } = await rawRequest(fetchImpl, base, "POST", "/preflight", intent);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json?.verdict !== "BLOCK") throw new Error(`expected BLOCK, got ${json?.verdict}`);
  });

  await check("/preflight missing chainId returns 400 missing_chain", async () => {
    const { res, json } = await rawRequest(fetchImpl, base, "POST", "/preflight", MISSING_CHAIN_INTENT);
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    if (json?.code !== "missing_chain") throw new Error(`expected missing_chain, got ${json?.code}`);
  });

  await check("/preflight/verify receipt round-trip", async () => {
    const intent = { ...PREFLIGHT_INTENT, payment: { ...PREFLIGHT_INTENT.payment, resource: `${base}/verify` } };
    const { json: pre } = await rawRequest(fetchImpl, base, "POST", "/preflight", intent);
    const { res, json } = await rawRequest(fetchImpl, base, "POST", "/preflight/verify", { receipt: pre.receipt });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json?.valid !== true) throw new Error("receipt not valid");
  });

  await check("weak idempotency key on paid route returns 400", async () => {
    const { res, json } = await rawRequest(fetchImpl, base, "POST", "/verify", {}, { "x-idempotency-key": "test-1" });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    if (json?.code !== "weak_idempotency_key") throw new Error(`expected weak_idempotency_key, got ${json?.code}`);
  });

  await check("paid route returns 402 challenge without CORS wildcard", async () => {
    const { res, json } = await rawRequest(fetchImpl, base, "POST", "/verify", { chainId: 1, target: "WETH", size: 100 });
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
    const paymentRequired = res.headers.get("payment-required");
    if (!paymentRequired && (!json || Object.keys(json).length === 0 && !json?.accepts)) {
      throw new Error("missing payment requirements");
    }
    if (res.headers.get("access-control-allow-origin") !== null) {
      throw new Error("paid route sent a CORS wildcard");
    }
  });

  await check("agent card contains canonical host", async () => {
    const { res, text } = await rawRequest(fetchImpl, base, "GET", "/.well-known/agent-card.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!text.includes(expectedHost)) throw new Error(`agent card does not contain ${expectedHost}`);
  });

  if (paid) {
    await check("paid mode guard", async () => {
      if (!health || health.mode !== "testnet") throw new Error("target is not a testnet instance");
      if (!env.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY is required");
    });

    await check("paid testnet /route call", async () => {
      const child = spawnImpl(process.execPath, ["first-payment.mjs"], {
        cwd: path.join(ROOT, "mcp-bridge"),
        env: {
          ...env,
          VERIFY402_URL: base,
          MAX_PAYMENT_USD: env.MAX_PAYMENT_USD || "0.03",
        },
        stdio: "inherit",
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
      });
      if (code !== 0) throw new Error(`exit code ${code}`);
    });
  }

  const ok = results.every((result) => result.ok);
  log(ok ? "smoke: PASS" : "smoke: FAIL");
  return { ok, results, failures: results.filter((result) => !result.ok) };
}

export async function main() {
  const result = await runSmoke();
  process.exit(result.ok ? 0 : 1);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
