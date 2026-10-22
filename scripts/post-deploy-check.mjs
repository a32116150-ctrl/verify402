// Post-deploy checker for the public testnet demo.
//
//   SMOKE_BASE_URL=https://verify402.onrender.com \
//   EXPECTED_VERSION=1.0.4 \
//   EXPECTED_MODE=testnet \
//   node scripts/post-deploy-check.mjs
//
// This checker supports EXPECTED_MODE=testnet only. Any other mode (including
// mainnet) fails immediately, before any network request, because mainnet
// deployment checks are not implemented here yet.
//
// The smoke run is always free-only: SMOKE_PAID is forced to "0", payment
// credentials are stripped from the child environment, and paid mode is
// disabled at the runSmoke() call site regardless of inherited variables.

import { runSmoke, normalizeBaseUrl, wakeService, parsePaymentChallenge } from "./smoke.mjs";
import {
  assertSupportedExpectedMode,
  buildFreeSmokeEnv,
  resolveExpectedMode,
  resolveExpectedVersion,
} from "./post-deploy-policy.mjs";
import {
  createPaymentPolicyFromEnv,
  validatePaymentChallenge,
  DEFAULT_PAY_TO,
  DEMO_NETWORK,
  MAINNET_NETWORK,
} from "../mcp-bridge/payment-policy.mjs";

const BASE = normalizeBaseUrl(process.env.SMOKE_BASE_URL || process.env.VERIFY402_URL);
const EXPECTED_VERSION = resolveExpectedVersion(process.env.EXPECTED_VERSION);
const EXPECTED_MODE = resolveExpectedMode(process.env.EXPECTED_MODE);

try {
  assertSupportedExpectedMode(EXPECTED_MODE);
} catch (error) {
  console.error(`post-deploy: ${error.message}`);
  process.exit(1);
}

const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ${name} ... PASS${detail ? ` (${detail})` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
    console.log(`  ${name} ... FAIL (${error?.message ?? error})`);
  }
}

async function fetchText(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text only */ }
  return { res, text, json };
}

// The 402 challenge is parsed with the same header-first parser the paid
// smoke uses. The response body is never a fallback.
function tryParseChallengeFromHeader(header) {
  return parsePaymentChallenge(header, null, null);
}

console.log(`verify402 post-deploy check: ${BASE}`);
console.log(`expecting version ${EXPECTED_VERSION}, mode ${EXPECTED_MODE}`);

const wake = await wakeService({ baseUrl: BASE, log: () => {} });
console.log(`wake: ${wake.ok ? "ready" : "FAILED"}, ${wake.elapsedMs}ms, ${wake.attempts} attempt(s)`);
await check("wake service", () => {
  if (!wake.ok) throw new Error(wake.error?.message ?? "service did not wake");
});

const smoke = await runSmoke({
  baseUrl: BASE,
  env: buildFreeSmokeEnv(process.env),
  allowPaid: false,
  log: () => {},
});
await check("smoke checks", () => {
  if (!smoke.ok) throw new Error(smoke.failures.map((f) => f.name).join(", "));
  return `${smoke.results.length} checks`;
});

const docs = {};
for (const path of ["/info", "/openapi.json", "/.well-known/verify402.json", "/.well-known/x402", "/llms.txt"]) {
  await check(`fetch ${path}`, async () => {
    const doc = await fetchText(path);
    docs[path] = doc;
    if (!doc.res.ok) throw new Error(`HTTP ${doc.res.status}`);
  });
}

await check(`release version is ${EXPECTED_VERSION}`, () => {
  const info = docs["/info"]?.json;
  const openapi = docs["/openapi.json"]?.json;
  const manifest = docs["/.well-known/verify402.json"]?.json;
  const surfaces = {
    "/info.version": info?.version,
    "/info.mcp.version": info?.mcp?.version,
    "/openapi.json.info.version": openapi?.info?.version,
    "manifest.version": manifest?.version,
  };
  const mismatches = Object.entries(surfaces).filter(([, value]) => value !== EXPECTED_VERSION);
  if (mismatches.length) {
    throw new Error(mismatches.map(([name, value]) => `${name} ${value ?? "(missing)"} !== ${EXPECTED_VERSION}`).join("; "));
  }
  return EXPECTED_VERSION;
});

await check(`/health reports mode ${EXPECTED_MODE}`, async () => {
  // /health is also checked by runSmoke; fetch it directly here so the
  // release-identity assertion does not depend on smoke's internal loop.
  const healthDoc = await fetchText("/health");
  docs["/health"] = healthDoc;
  if (!healthDoc.res.ok) throw new Error(`HTTP ${healthDoc.res.status}`);
  if (healthDoc.json?.mode !== EXPECTED_MODE) {
    throw new Error(`/health mode ${healthDoc.json?.mode ?? "(missing)"} !== ${EXPECTED_MODE}`);
  }
  if (EXPECTED_MODE === "testnet" && !/Base Sepolia/i.test(String(healthDoc.json?.networks || ""))) {
    throw new Error(`/health networks ${healthDoc.json?.networks ?? "(missing)"} does not name Base Sepolia`);
  }
  return `${healthDoc.json.mode} / ${healthDoc.json.networks ?? "networks missing"}`;
});

await check("/llms.txt describes the testnet payment rail", () => {
  const llms = docs["/llms.txt"]?.text ?? "";
  if (!/testnet/i.test(llms)) throw new Error("llms.txt does not say testnet");
  if (!/eip155:84532|Base Sepolia/i.test(llms)) throw new Error("llms.txt does not name Base Sepolia");
  if (/USDC on Base mainnet or Solana|Base mainnet or Solana/i.test(llms)) {
    throw new Error("llms.txt still advertises mainnet as the demo rail");
  }
});

await check("fetch /", async () => {
  const doc = await fetchText("/", { headers: { accept: "text/html" } });
  docs["/"] = doc;
  if (!doc.res.ok) throw new Error(`HTTP ${doc.res.status}`);
});

await check("landing page no longer claims Mainnet-armed", () => {
  const landing = docs["/"]?.text ?? "";
  if (/Mainnet-armed/i.test(landing)) throw new Error("obsolete Mainnet-armed claim found");
  if (!/testnet/i.test(landing)) throw new Error("landing page does not describe the testnet demo");
});

await check("fetch /verify 402 challenge", async () => {
  const doc = await fetchText("/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: 1, target: "WETH", size: 100 }),
  });
  docs["/verify"] = doc;
  if (doc.res.status !== 402) throw new Error(`expected 402, got ${doc.res.status}`);
  return `HTTP ${doc.res.status}`;
});

await check("402 challenge offers Base Sepolia testnet USDC", () => {
  const res = docs["/verify"]?.res;
  const header = res?.headers?.get?.("payment-required");
  const challenge = tryParseChallengeFromHeader(header);
  if (!challenge) throw new Error("could not parse a 402 challenge from the PAYMENT-REQUIRED header");
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
  const evm = accepts.find((entry) => String(entry?.network ?? "").startsWith("eip155:"));
  if (!evm) throw new Error("402 offers no EVM payment requirement");
  if (evm.network !== DEMO_NETWORK) {
    throw new Error(`402 EVM network ${evm.network} !== ${DEMO_NETWORK}`);
  }
  if (String(evm.asset ?? "").toLowerCase() !== TESTNET_USDC.toLowerCase()) {
    throw new Error(`402 EVM asset ${evm.asset ?? "(missing)"} is not Base Sepolia testnet USDC`);
  }

  // The deployed 402 must satisfy the same shared policy the payers enforce.
  const sharedValidation = validatePaymentChallenge(challenge, {
    allowedNetworks: [DEMO_NETWORK],
    allowedPayTo: DEFAULT_PAY_TO,
    expectedResource: `${BASE}/verify`,
    maxAmountUsd: 0.25,
  });
  if (!sharedValidation.ok) {
    throw new Error(`deployed 402 challenge would be refused by a payer: ${sharedValidation.reason}`);
  }

  const demoPolicy = createPaymentPolicyFromEnv({ resourcePrefix: BASE, env: {} });
  const selected = demoPolicy.filter(2, accepts);
  if (!selected.some((entry) => entry.network === DEMO_NETWORK)) {
    throw new Error("bridge demo policy did not select the Base Sepolia requirement");
  }

  const signingCheck = demoPolicy.checkBeforeSign({
    paymentRequired: { resource: { url: `${BASE}/verify` } },
    selectedRequirements: evm,
  });
  if (signingCheck) throw new Error(`bridge demo policy would abort: ${signingCheck.reason}`);
  const freeRouteCheck = demoPolicy.checkBeforeSign({
    paymentRequired: { resource: { url: `${BASE}/preflight` } },
    selectedRequirements: evm,
  });
  if (freeRouteCheck?.abort !== true) {
    throw new Error("bridge demo policy would allow a free route as paid");
  }

  let rejected = false;
  try {
    demoPolicy.filter(2, [{ ...evm, network: MAINNET_NETWORK, asset: MAINNET_USDC }]);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("bridge demo policy accepted a mainnet-only requirement");
  return DEMO_NETWORK;
});

const banned = new RegExp([
  "honeypot" + " " + "test",
  "honeypot" + " " + "probe",
  "every" + " " + "venue" + "\\b",
  "sell probe across " + "every" + " " + "venue",
  "double" + "-" + "keying",
  "content-hash" + " " + "companion key",
  "scope" + "_" + "mismatch",
  "shared between the caller" + " " + "key",
  "different" + " " + "payer",
].join("|"), "i");
for (const path of ["/info", "/openapi.json", "/.well-known/verify402.json", "/.well-known/x402", "/llms.txt"]) {
  await check(`banned phrases absent from ${path}`, () => {
    if (banned.test(docs[path].text)) throw new Error("banned phrase found");
  });
}

for (const path of ["/info", "/openapi.json", "/.well-known/verify402.json", "/.well-known/x402", "/llms.txt"]) {
  await check(`security headers on ${path}`, () => {
    const h = docs[path].res.headers;
    if (h.get("x-content-type-options") !== "nosniff") throw new Error("missing nosniff");
    if (!h.get("referrer-policy")) throw new Error("missing referrer-policy");
    if (!h.get("x-frame-options")) throw new Error("missing x-frame-options");
    if (h.get("x-powered-by") !== null) throw new Error("x-powered-by present");
  });
}

await check("prices agree: /info vs manifest", () => {
  const info = docs["/info"].json;
  const manifest = docs["/.well-known/verify402.json"].json;
  const infoPrices = info.prices;
  const manifestPrices = manifest.paymentRequirements?.pricing;
  for (const key of ["verify", "safety", "route", "quotecheck", "depth"]) {
    const expected = Number(String(infoPrices[key]).replace(/^\$/, ""));
    if (manifestPrices?.[key]?.priceUsd !== expected) throw new Error(`${key}: ${manifestPrices?.[key]?.priceUsd} !== ${expected}`);
  }
});

await check("prices agree: manifest vs openapi", () => {
  const manifest = docs["/.well-known/verify402.json"].json;
  const openapi = docs["/openapi.json"].json;
  const paths = ["/verify", "/safety", "/route", "/quotecheck", "/depth"];
  const keys = ["verify", "safety", "route", "quotecheck", "depth"];
  paths.forEach((path, i) => {
    const amount = Number(openapi.paths?.[path]?.post?.["x-payment-info"]?.price?.amount);
    const expected = manifest.paymentRequirements?.pricing?.[keys[i]]?.priceUsd;
    if (amount !== expected) throw new Error(`${keys[i]}: ${amount} !== ${expected}`);
  });
});

await check("x402 resource list covers paid routes", () => {
  const x402 = docs["/.well-known/x402"].json;
  const resources = Array.isArray(x402.resources) ? x402.resources : [];
  for (const route of ["/verify", "/safety", "/route", "/quotecheck", "/depth"]) {
    if (!resources.some((r) => String(r.url || "").endsWith(route))) throw new Error(`missing ${route}`);
  }
});

await check("idempotency TTL agrees: info vs manifest", () => {
  const info = docs["/info"].json;
  const manifest = docs["/.well-known/verify402.json"].json;
  const infoTtl = Number(info.recovery?.ttlMinutes) * 60;
  const match = String(manifest.operationalPolicies?.idempotency?.description || "").match(/within a (\d+)s window/);
  const manifestTtl = match ? Number(match[1]) : null;
  if (infoTtl !== 600) throw new Error(`info TTL ${infoTtl}`);
  if (manifestTtl !== infoTtl) throw new Error(`manifest TTL ${manifestTtl} !== ${infoTtl}`);
});

await check("preflight limits agree: info vs manifest", () => {
  const info = docs["/info"].json;
  const manifest = docs["/.well-known/verify402.json"].json;
  const perMinute = info.preflight?.limits?.perMinutePerIp;
  const maxInFlight = info.preflight?.limits?.maxInFlight;
  const text = String(manifest.operationalPolicies?.rateLimits?.preflight || "");
  if (perMinute !== 60) throw new Error(`perMinute ${perMinute}`);
  if (maxInFlight !== 8) throw new Error(`maxInFlight ${maxInFlight}`);
  if (!text.includes("60 requests/minute")) throw new Error("manifest missing 60 requests/minute");
  if (!text.includes("max concurrency 8")) throw new Error("manifest missing concurrency 8");
});

const ok = results.every((r) => r.ok);
console.log("");
console.log(ok ? "post-deploy: PASS" : "post-deploy: FAIL");
console.log(`checks: ${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(ok ? 0 : 1);
