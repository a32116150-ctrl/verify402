#!/usr/bin/env node
// Daily price-accuracy scan for the public /accuracy page.
//
// For each paid network it asks verify402's own route check for the best
// on-chain quote (stablecoin -> wrapped native, and back, at $1,000 and
// $25,000) and, at the same moment, asks an independent DEX aggregator
// (KyberSwap's public route API) for its quote on the same trade. The page
// shows the gap. An aggregator can split one order across many pools and
// sources we do not read, so on large trades it is expected to beat a
// single-pool quote; the point is to publish the difference, not hide it.
//
// Runs where the private engine is reachable (VERIFY402_ENGINE_URL/TOKEN).
// Writes ACCURACY_PATH (default /var/lib/verify402/accuracy.json) atomically
// and keeps a 90-day summary history in the same file.
//
// usage: node scripts/accuracy-scan.mjs [--out path] [--dry]

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CHAINS } from "../src/config.mjs";
import { remoteEngine, remoteEngineConfigured } from "../src/engine-client.mjs";
import { summarizeAccuracy } from "../src/accuracy.mjs";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : (process.env.ACCURACY_PATH || "/var/lib/verify402/accuracy.json");
const DRY = args.includes("--dry");

// KyberSwap chain slugs for our paid networks.
const NETWORKS = [
  [1, "ethereum"], [8453, "base"], [42161, "arbitrum"], [10, "optimism"],
  [56, "bsc"], [137, "polygon"], [43114, "avalanche"],
];
const SIZES_USD = [1000, 25000];
const HISTORY_DAYS = 90;

const tokenOf = (chainId, sym) => {
  const t = CHAINS[chainId].tokens[sym];
  return { symbol: sym, address: t.address, decimals: t.decimals };
};

async function aggregatorQuote(slug, tokenIn, tokenOut, amountIn) {
  const url = `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: { "x-client-id": "verify402" }, signal: ctrl.signal });
    const j = await r.json();
    const out = j?.data?.routeSummary?.amountOut;
    if (!r.ok || !out) throw new Error(`aggregator ${r.status} ${j?.message ?? ""}`.trim());
    return BigInt(out);
  } finally {
    clearTimeout(timer);
  }
}

async function ourQuote(chainId, tokenIn, tokenOut, amountIn) {
  const book = await remoteEngine("route", chainId, { tokenIn, tokenOut, amountIn });
  const best = (book?.quoted ?? []).find((q) => q.status === "ok" && q.amountOut != null);
  if (!best) throw new Error(book?.reason || book?.kind || "no venue quoted");
  return { venue: best.venue, amountOut: BigInt(best.amountOut), blockNumber: book.blockNumber ?? null };
}

function gapBps(ours, ref) {
  // Positive: our quote pays more than the aggregator. Negative: it pays less.
  return Number(((ours - ref) * 1_000_000n) / ref) / 100;
}

const human = (raw, decimals) => Number(raw) / 10 ** decimals;

async function measure(chainId, slug, from, to, amountIn, sizeUsd) {
  const base = { chainId, chain: CHAINS[chainId].name, pair: `${from.symbol}→${to.symbol}`, sizeUsd };
  try {
    const [ours, ref] = await Promise.all([
      ourQuote(chainId, from.address, to.address, amountIn),
      aggregatorQuote(slug, from.address, to.address, amountIn),
    ]);
    return {
      ...base,
      status: "ok",
      venue: ours.venue,
      blockNumber: ours.blockNumber != null ? String(ours.blockNumber) : null,
      amountIn: human(amountIn, from.decimals),
      ours: human(ours.amountOut, to.decimals),
      reference: human(ref, to.decimals),
      gapBps: gapBps(ours.amountOut, ref),
    };
  } catch (e) {
    return { ...base, status: "error", error: String(e?.message || e).slice(0, 160) };
  }
}

async function scanNetwork(chainId, slug) {
  const c = CHAINS[chainId];
  const usdc = tokenOf(chainId, "USDC");
  const wnative = tokenOf(chainId, c.gasToken);
  const rows = [];
  // Forward legs first; the $1,000 forward quote sets how much wrapped native
  // the reverse legs sell, so both directions trade the same dollar size.
  let nativePerUsd = null;
  for (const size of SIZES_USD) {
    const amountIn = BigInt(size) * 10n ** BigInt(usdc.decimals);
    const row = await measure(chainId, slug, usdc, wnative, amountIn, size);
    if (size === SIZES_USD[0] && row.status === "ok") nativePerUsd = row.ours / size;
    rows.push(row);
  }
  for (const size of SIZES_USD) {
    if (!nativePerUsd) {
      rows.push({ chainId, chain: c.name, pair: `${wnative.symbol}→${usdc.symbol}`, sizeUsd: size, status: "error", error: "no forward price to size this leg" });
      continue;
    }
    const units = nativePerUsd * size;
    const amountIn = BigInt(Math.round(units * 1e6)) * 10n ** BigInt(wnative.decimals - 6);
    rows.push(await measure(chainId, slug, wnative, usdc, amountIn, size));
  }
  return rows;
}

if (!remoteEngineConfigured()) {
  console.error("accuracy-scan: VERIFY402_ENGINE_URL / VERIFY402_ENGINE_TOKEN are not set");
  process.exit(2);
}

const generatedAt = new Date().toISOString();
const rows = [];
for (const [chainId, slug] of NETWORKS) rows.push(...await scanNetwork(chainId, slug));
const summary = summarizeAccuracy(rows);

let history = [];
try { history = JSON.parse(readFileSync(OUT, "utf8")).history ?? []; } catch {}
const day = generatedAt.slice(0, 10);
history = [...history.filter((h) => h.date !== day), { date: day, ...summary }].slice(-HISTORY_DAYS);

const doc = {
  generatedAt,
  reference: "KyberSwap aggregator public route API",
  method: "Same trade, same moment: verify402's best single-venue on-chain quote vs the aggregator's best route. gapBps = (ours / aggregator − 1) × 10,000. Positive means our quote pays more; negative means the aggregator found more.",
  rows,
  summary,
  history,
};

if (DRY) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, OUT);
  console.log(`accuracy-scan: ${summary.ok}/${summary.total} rows, median gap ${summary.medianAbsGapBps} bps -> ${OUT}`);
}
