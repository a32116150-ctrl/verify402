// Price-accuracy page: summary arithmetic and rendering, no network.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarizeAccuracy, renderAccuracyPage, loadAccuracy } from "../src/accuracy.mjs";

const rows = [
  { chainId: 1, chain: "ethereum", pair: "USDC→WETH", sizeUsd: 1000, status: "ok", venue: "uni-v3-0.05%", ours: 0.5, reference: 0.5001, gapBps: -2 },
  { chainId: 1, chain: "ethereum", pair: "USDC→WETH", sizeUsd: 25000, status: "ok", venue: "uni-v3-0.05%", ours: 12, reference: 12.1, gapBps: -82 },
  { chainId: 137, chain: "polygon", pair: "USDC→WPOL", sizeUsd: 1000, status: "ok", venue: "uni-v3-0.05%", ours: 4000, reference: 3990, gapBps: 25 },
  { chainId: 56, chain: "bnb", pair: "USDC→WBNB", sizeUsd: 1000, status: "error", error: "aggregator 500" },
];

test("summary counts only measured rows and splits by size", () => {
  const s = summarizeAccuracy(rows);
  assert.equal(s.total, 4);
  assert.equal(s.ok, 3);
  assert.equal(s.medianAbsGapBps, 25);
  assert.equal(s.withinHalfPercent, 2);
  assert.equal(s.oursHigherOrEqual, 1);
  assert.deepEqual([s.smallTrades.ok, s.smallTrades.withinHalfPercent], [2, 2]);
  assert.deepEqual([s.largeTrades.ok, s.largeTrades.withinHalfPercent], [1, 0]);
});

test("page shows every row, including failures and losses, and escapes text", () => {
  const tpl = readFileSync(new URL("../src/site/accuracy.html", import.meta.url), "utf8");
  const doc = { generatedAt: "2026-11-27T12:00:00Z", rows: [...rows, { chainId: 10, chain: "optimism", pair: "<x>", sizeUsd: 1000, status: "error", error: "<script>" }] };
  const html = renderAccuracyPage(tpl, doc);
  assert.ok(!html.includes("<!--ACCURACY_MAIN-->"));
  assert.match(html, /−0\.82%/);
  assert.match(html, /\+0\.25%/);
  assert.match(html, /Not measured this run: aggregator 500/);
  assert.ok(!html.includes("<script>\""), "error text is escaped");
  assert.match(html, /&lt;script&gt;/);
});

test("no data yet renders a plain notice, and a broken file reads as no data", () => {
  const tpl = readFileSync(new URL("../src/site/accuracy.html", import.meta.url), "utf8");
  assert.match(renderAccuracyPage(tpl, null), /first daily scan has not run yet/);
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(loadAccuracy(join(dir, "bad.json")), null);
  assert.equal(loadAccuracy(join(dir, "missing.json")), null);
});
