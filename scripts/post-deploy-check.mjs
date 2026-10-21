import { runSmoke, normalizeBaseUrl, wakeService } from "./smoke.mjs";

const BASE = normalizeBaseUrl(process.env.SMOKE_BASE_URL || process.env.VERIFY402_URL);
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

async function fetchText(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text only */ }
  return { res, text, json };
}

console.log(`verify402 post-deploy check: ${BASE}`);

const wake = await wakeService({ baseUrl: BASE, log: () => {} });
console.log(`wake: ${wake.ok ? "ready" : "FAILED"}, ${wake.elapsedMs}ms, ${wake.attempts} attempt(s)`);
check("wake service", () => {
  if (!wake.ok) throw new Error(wake.error?.message ?? "service did not wake");
});

const smoke = await runSmoke({ baseUrl: BASE, env: process.env, log: () => {} });
await check("smoke checks", () => {
  if (!smoke.ok) throw new Error(smoke.failures.map((f) => f.name).join(", "));
  return `${smoke.results.length} checks`;
});

const docs = {};
for (const path of ["/info", "/openapi.json", "/.well-known/verify402.json", "/.well-known/x402", "/llms.txt"]) {
  await await check(`fetch ${path}`, async () => {
    const { res } = await fetchText(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
  docs[path] = await fetchText(path);
}

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
