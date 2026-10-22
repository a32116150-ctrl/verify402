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
import { realpathSync } from "node:fs";
import { decodePaymentRequiredHeader } from "@x402/core/http";

import {
  DEFAULT_PAY_TO,
  DEMO_NETWORK,
  DEMO_USDC,
  validatePaymentChallenge,
} from "../mcp-bridge/payment-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "https://verify402.onrender.com";
const PAID_SMOKE_PATH = "/route";
const DEFAULT_PAID_MAX_USD = 0.03;

export function normalizeBaseUrl(raw) {
  return String(raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

// The public service's payment rail is Base Sepolia testnet. Preflight is
// free, but using the offered network keeps the smoke fixture aligned with the
// live challenge and prevents a mainnet-looking example from becoming the
// documented default.
const PREFLIGHT_INTENT = {
  kind: "payment",
  payment: {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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

function headerValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

// The x402 v2 challenge arrives as base64 of compact JSON in the
// PAYMENT-REQUIRED header. Accept only canonical standard base64: a fixed
// alphabet, exact padding, a length divisible by four, and a decoded value that
// re-encodes to the identical string. The re-encode check rejects base64url,
// trailing garbage, and non-canonical trailing bits that Node's lenient
// decoder would silently ignore.
function isCanonicalBase64(value) {
  if (typeof value !== "string" || value === "") return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  if (value.length % 4 !== 0) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function parseChallengeJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.accepts)) return null;
  return parsed;
}

function decodeCanonicalChallenge(value) {
  if (!isCanonicalBase64(value)) return null;
  try {
    return parseChallengeJson(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Parse a 402 challenge strictly from the authoritative x402 v2 header.
 * Body is never used to authorise payment or to override a header. Encoding is
 * validated before decoding, so an invalid header aborts before any payer is
 * spawned.
 */
export function parsePaymentChallenge(paymentRequiredHeader, json, text) {
  void json;
  void text;
  const header = headerValue(paymentRequiredHeader);
  if (header == null) return null;
  const encoded = String(header).trim();
  if (!isCanonicalBase64(encoded)) return null;
  // Prefer the installed SDK decoder once the encoding is known to be
  // canonical, so protocol changes in the SDK are picked up.
  try {
    const parsed = decodePaymentRequiredHeader(encoded);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.accepts)) {
      return parsed;
    }
  } catch {
    /* fall through to the local canonical decoder */
  }
  return decodeCanonicalChallenge(encoded);
}

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

export async function wakeService({ baseUrl, fetchImpl = fetch, timeoutMs = 90000, retries = 3, retryDelayMs = 1000, log = console.log } = {}) {
  const started = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* keep text */ }
      if (res.ok && json?.ok === true) {
        const elapsedMs = Date.now() - started;
        log(`wake: ready after ${elapsedMs}ms (attempt ${attempt})`);
        return { ok: true, attempts: attempt, elapsedMs, response: { res, json, text } };
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  const elapsedMs = Date.now() - started;
  log(`wake: FAILED after ${elapsedMs}ms`);
  return { ok: false, attempts: retries, elapsedMs, error: lastError };
}

export async function runSmoke({
  baseUrl,
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  spawnImpl = spawn,
  // Callers that must stay free (for example the post-deploy checker) pass
  // allowPaid:false. It is a hard gate: an inherited SMOKE_PAID=1 cannot
  // enable the paid branch or spawn the paying child process.
  allowPaid = env.SMOKE_PAID === "1",
} = {}) {
  const base = normalizeBaseUrl(baseUrl || env.SMOKE_BASE_URL || env.VERIFY402_URL);
  const paid = allowPaid === true && env.SMOKE_PAID === "1";
  const agentUrl = env.AGENT_URL || base;
  const expectedHost = new URL(agentUrl).host;
  const results = [];
  let spawnCount = 0;

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

  const wake = await wakeService({ baseUrl: base, fetchImpl, log });
  await check("wake service", async () => {
    if (!wake.ok) throw new Error(wake.error?.message ?? "service did not wake");
  });

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
    const { res, json, text } = await rawRequest(fetchImpl, base, "POST", "/verify", { chainId: 1, target: "WETH", size: 100 });
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
    const paymentRequired = res.headers.get("payment-required");
    const challenge = parsePaymentChallenge(paymentRequired, json, text);
    if (!challenge) throw new Error("missing payment requirements");
    const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
    const evmEntries = accepts.filter((entry) => String(entry?.network ?? "").startsWith("eip155:"));
    if (evmEntries.length === 0) throw new Error("402 challenge has no EVM payment requirement");
    for (const evm of evmEntries) {
      if (evm.network !== DEMO_NETWORK) {
        throw new Error(`demo EVM payment rail is ${evm.network}, expected ${DEMO_NETWORK} (Base Sepolia)`);
      }
      if (String(evm.asset ?? "").toLowerCase() !== DEMO_USDC.toLowerCase()) {
        throw new Error(`demo EVM asset is ${evm.asset ?? "(missing)"}, expected Base Sepolia USDC`);
      }
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
    let paidConfig = null;

    // This is a control-flow gate, not a recorded assertion. A failed
    // prerequisite returns BEFORE the payer can be spawned; a `check()` entry
    // that merely records FAIL is not a security boundary.
    const abortPaid = (reason) => {
      results.push({ name: "paid mode preflight", ok: false, error: reason });
      log(`  paid mode preflight ... ABORT (${reason})`);
    };

    try {
      if (!wake.ok) throw new Error("service did not wake");
      if (!health) throw new Error("/health was not read");
      if (health.mode !== "testnet") {
        throw new Error(`target /health mode is ${health.mode ?? "(missing)"}, expected testnet`);
      }

      const failed = results.filter((result) => !result.ok).map((result) => result.name);
      if (failed.length > 0) {
        throw new Error(`required free checks failed: ${failed.join(", ")}`);
      }

      if (!env.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY is required");

      const paidMaxUsd = Number(env.MAX_PAYMENT_USD || DEFAULT_PAID_MAX_USD);
      if (!Number.isFinite(paidMaxUsd) || paidMaxUsd <= 0) {
        throw new Error("MAX_PAYMENT_USD must be a positive number");
      }
      const expectedPayTo =
        env.SMOKE_EXPECTED_PAY_TO !== undefined
          ? env.SMOKE_EXPECTED_PAY_TO
          : env.VERIFY402_PAY_TO !== undefined
            ? env.VERIFY402_PAY_TO
            : DEFAULT_PAY_TO;
      const expectedPayToTrimmed = String(expectedPayTo).trim();
      if (env.SMOKE_EXPECTED_PAY_TO !== undefined && expectedPayToTrimmed === "") {
        throw new Error("no valid expected payee is configured");
      }
      if (expectedPayToTrimmed === "") {
        throw new Error("no valid expected payee is configured");
      }
      const expectedResource = `${base}${PAID_SMOKE_PATH}`;

      const { res, json, text } = await rawRequest(fetchImpl, base, "POST", PAID_SMOKE_PATH, {
        chainId: 1,
        tokenIn: "USDC",
        tokenOut: "WETH",
        amountIn: "1000000",
      });
      if (res.status !== 402) {
        throw new Error(`paid ${PAID_SMOKE_PATH} expected 402, got ${res.status}`);
      }
      const challenge = parsePaymentChallenge(res.headers.get("payment-required"), json, text);
      if (!challenge) {
        throw new Error(`paid ${PAID_SMOKE_PATH} returned no parseable 402 challenge in the PAYMENT-REQUIRED header`);
      }

      const validation = validatePaymentChallenge(challenge, {
        allowedNetworks: [DEMO_NETWORK],
        allowedPayTo: expectedPayToTrimmed,
        expectedResource,
        maxAmountUsd: paidMaxUsd,
      });
      if (!validation.ok) throw new Error(validation.reason);

      paidConfig = { paidMaxUsd, expectedPayTo: expectedPayToTrimmed };
      results.push({ name: "paid mode preflight", ok: true });
      log("  paid mode preflight ... PASS");
    } catch (error) {
      abortPaid(error?.message ?? String(error));
      log("smoke: FAIL");
      return { ok: false, results, failures: results.filter((result) => !result.ok), spawnCount };
    }

    await check("paid testnet /route call", async () => {
      const child = spawnImpl(process.execPath, ["first-payment.mjs"], {
        cwd: path.join(ROOT, "mcp-bridge"),
        env: {
          ...env,
          VERIFY402_URL: base,
          // The payer independently enforces this too. Setting it here means
          // an inherited VERIFY402_NETWORKS cannot widen the paid smoke.
          VERIFY402_NETWORKS: DEMO_NETWORK,
          VERIFY402_PAY_TO: paidConfig.expectedPayTo,
          VERIFY402_RESOURCE_PREFIX: base,
          MAX_PAYMENT_USD: String(paidConfig.paidMaxUsd),
        },
        stdio: "inherit",
      });
      spawnCount += 1;
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
      });
      if (code !== 0) throw new Error(`exit code ${code}`);
    });
  }

  const ok = results.every((result) => result.ok);
  log(ok ? "smoke: PASS" : "smoke: FAIL");
  return { ok, results, failures: results.filter((result) => !result.ok), spawnCount };
}

export async function main() {
  const result = await runSmoke();
  process.exit(result.ok ? 0 : 1);
}

// True only when this file is the process entry point, compared by real path so
// a symlinked invocation still counts as "run as a script".
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
