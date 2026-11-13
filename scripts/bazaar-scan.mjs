// One-off scan of public x402 endpoints from the CDP Bazaar catalog.
// Read-only, one request per endpoint, 500ms apart, identified UA.
// Not a security assessment of any seller; it measures what a payment demand
// looks like today. Results are written to /tmp/bazaar-scan.json (stdout summary).

import { inspectUrl } from "../src/inspect.mjs";
import { readFileSync, writeFileSync } from "node:fs";

function catalogItems() {
  const pages = [];
  for (const off of [0, 100, 200]) {
    const p = off === 0 ? "/tmp/bazaar.json" : `/tmp/bazaar_${off}.json`;
    pages.push(...JSON.parse(readFileSync(p, "utf8")).items);
  }
  const seen = new Set();
  return pages.filter((i) => {
    if (!i?.resource || seen.has(i.resource)) return false;
    seen.add(i.resource);
    return true;
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const entries = [];
for (const item of catalogItems()) {
  const ext = item?.extensions?.bazaar?.info?.input;
  const method = String(ext?.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
  const q = item?.quality || {};
  const row = {
    resource: item.resource,
    method,
    description: item.description,
    l30DaysTotalCalls: q.l30DaysTotalCalls ?? null,
    l30DaysUniquePayers: q.l30DaysUniquePayers ?? null,
    lastUpdated: item.lastUpdated,
  };
  const t0 = Date.now();
  try {
    const r = await inspectUrl(item.resource, { method });
    const accept = r.challenge?.accepts?.[0] ?? {};
    row.status = r.status;
    row.protocol = r.verdict;
    row.reasons = (r.reasons ?? []).map((x) => x.code).slice(0, 6);
    row.sign = r.sign_allowed === false ? "BLOCK" : (r.options?.[0]?.verdict ?? null);
    row.networks = (r.challenge?.accepts ?? []).map((a) => a.network);
    row.acceptCount = r.challenge?.acceptCount;
    row.accept = {
      network: accept.network,
      asset: accept.asset,
      token: accept.token,
      amount: accept.amount,
      priceUsd: accept.priceUsd,
      priceBasis: accept.priceBasis,
      payTo: accept.payTo,
      resource: accept.resource,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    };
    row.inspectMs = Date.now() - t0;
  } catch (e) {
    row.status = e.status ?? null;
    row.error = e.code ?? "unknown";
    row.message = e.message ?? String(e);
    row.inspectMs = Date.now() - t0;
  }
  entries.push(row);
  process.stdout.write(`${entries.length}\t${row.error ?? row.protocol}\t${row.resource.slice(0, 64)}\n`);
  await sleep(500);
}

writeFileSync("/tmp/bazaar-scan.json", JSON.stringify(entries, null, 2));

const counts = {};
for (const e of entries) {
  const k = e.error ? `err:${e.error}` : (e.protocol ?? "unknown");
  counts[k] = (counts[k] || 0) + 1;
}
console.log("\ncounts:", JSON.stringify(counts, null, 1));
console.log("total:", entries.length);
