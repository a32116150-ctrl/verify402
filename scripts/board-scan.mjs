// Daily board scan: one read-only request per endpoint, no wallet, no payment.
//
// Source: the public x402 Bazaar catalog (the first N entries, in the API's own
// order — never sorted by outcome). Output: data/board.json, which the service
// serves at /board and /board.json. The scan is deliberately boring: 3 requests
// in flight, 400 ms between starts, a 6 s timeout, an identifying user agent.
//
// Usage: node scripts/board-scan.mjs [outPath] [endpointLimit]
//
// This is one structural read of a payment demand. It is not an audit, a
// reputation score, or an endorsement, and the JSON says so in `caveats`.

import { inspectUrl } from "../src/inspect.mjs";
import { writeFileSync } from "node:fs";
import { BOARD_SPEC, BOARD_CAVEATS } from "../src/board.mjs";

const CATALOG = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE = 20;
const CONCURRENCY = 3;
const SPACING_MS = 400;

const outPath = process.argv[2] || "data/board.json";
const limit = Number(process.argv[3] || 300);
const startedAt = new Date();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "verify402-board/1 (+https://vex402.online/board)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return getJson(url, attempt + 1);
    }
    throw e;
  }
}

async function catalog(limitCount) {
  const items = [];
  const seen = new Set();
  let total = null;
  for (let offset = 0; items.length < limitCount; offset += PAGE) {
    const page = await getJson(`${CATALOG}?limit=${PAGE}&offset=${offset}`);
    total = page?.pagination?.total ?? total;
    const batch = Array.isArray(page?.items) ? page.items : [];
    if (!batch.length) break;
    for (const item of batch) {
      if (!item?.resource || seen.has(item.resource)) continue;
      seen.add(item.resource);
      items.push(item);
      if (items.length >= limitCount) break;
    }
  }
  return { items, total };
}

function methodOf(item) {
  const m = String(item?.extensions?.bazaar?.info?.input?.method || "POST").toUpperCase();
  return m === "GET" ? "GET" : "POST";
}

async function inspectOne(item, checkedAt) {
  const resource = item.resource;
  const method = methodOf(item);
  const q = item?.quality || {};
  const row = {
    resource,
    method,
    calls30d: Number.isFinite(Number(q.l30DaysTotalCalls)) ? Number(q.l30DaysTotalCalls) : null,
    checkedAt,
  };
  try {
    const r = await inspectUrl(resource, { method });
    const accept = r.challenge?.accepts?.[0] || {};
    row.verdict = r.verdict;
    row.reasons = (r.reasons || []).map((x) => x.code).filter(Boolean).slice(0, 6);
    row.chain = accept.network || null;
    row.priceUsd = accept.priceUsd ?? null;
    row.maxTimeoutSeconds = accept.maxTimeoutSeconds ?? null;
  } catch (e) {
    row.verdict = null;
    row.error = e?.code || "inspect_failed";
    row.reasons = [];
  }
  return row;
}

const { items, total } = await catalog(limit);
const checkedAt = new Date().toISOString();
const rows = [];
let cursor = 0;

async function worker(id) {
  while (true) {
    const i = cursor++;
    if (i >= items.length) return;
    const row = await inspectOne(items[i], checkedAt);
    rows[i] = row;
    process.stdout.write(
      `${String(i + 1).padStart(3)}/${items.length} ${(row.error || row.verdict || "?").padEnd(18)} ${row.resource.slice(0, 70)}\n`,
    );
    await sleep(SPACING_MS);
  }
}


await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

const counts = { pass: 0, caution: 0, refused: 0, block: 0, unreachable: 0 };
for (const row of rows) {
  const v = String(row.verdict || "").toUpperCase();
  const err = String(row.error || "");
  if (v === "PASS") counts.pass += 1;
  else if (v === "CAUTION") counts.caution += 1;
  else if (v === "BLOCK") counts.block += 1;
  else if (err === "challenge_mismatch" || err === "terms_unrepresentable") counts.refused += 1;
  else counts.unreachable += 1;
}

const data = {
  spec: BOARD_SPEC,
  generatedAt: checkedAt,
  scanStartedAt: startedAt.toISOString(),
  scanSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
  source: CATALOG,
  catalogTotal: total,
  scanned: rows.length,
  method:
    `first ${rows.length} catalog entries in the API's own order, one read-only request each ` +
    `(${CONCURRENCY} in flight, ${SPACING_MS} ms apart, 6 s timeout, no wallet, no payment, no credentials forwarded)`,
  counts,
  caveats: BOARD_CAVEATS,
  rows,
};

writeFileSync(outPath, JSON.stringify(data, null, 1) + "\n");
console.log("\ncounts:", JSON.stringify(counts));
console.log("scanned:", rows.length, "of catalog", total, "in", data.scanSeconds, "s");
console.log("wrote:", outPath);
