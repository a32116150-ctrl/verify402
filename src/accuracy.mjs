// Public price-accuracy page. The data comes from scripts/accuracy-scan.mjs,
// a daily job that quotes the same trades through verify402's route check and
// through an independent DEX aggregator, at the same moment, and records the
// gap. This module only summarizes and renders; it never measures.

import { readFileSync } from "node:fs";

export const ACCURACY_PATH = process.env.ACCURACY_PATH || "/var/lib/verify402/accuracy.json";
const CLOSE_BPS = 50; // "within 0.5%"

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export function summarizeAccuracy(rows = []) {
  const ok = rows.filter((r) => r.status === "ok" && Number.isFinite(r.gapBps));
  const abs = ok.map((r) => Math.abs(r.gapBps));
  return {
    total: rows.length,
    ok: ok.length,
    medianAbsGapBps: round2(median(abs)),
    withinHalfPercent: ok.filter((r) => Math.abs(r.gapBps) <= CLOSE_BPS).length,
    oursHigherOrEqual: ok.filter((r) => r.gapBps >= 0).length,
    smallTrades: summarizeSize(ok, 1000),
    largeTrades: summarizeSize(ok, 25000),
  };
}

function summarizeSize(ok, size) {
  const rows = ok.filter((r) => r.sizeUsd === size);
  return {
    sizeUsd: size,
    ok: rows.length,
    medianAbsGapBps: round2(median(rows.map((r) => Math.abs(r.gapBps)))),
    withinHalfPercent: rows.filter((r) => Math.abs(r.gapBps) <= CLOSE_BPS).length,
  };
}

export function loadAccuracy(path = ACCURACY_PATH) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(doc?.rows)) return null;
    return doc;
  } catch {
    return null;
  }
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CHAIN_LABEL = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "OP Mainnet", 56: "BNB Chain", 137: "Polygon", 43114: "Avalanche" };
const pct = (bps) => `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${Math.abs(bps / 100).toFixed(2)}%`;
const usd = (n) => `$${Number(n).toLocaleString("en-US")}`;
const amount = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const digits = x >= 1000 ? 2 : x >= 1 ? 4 : 6;
  return x.toLocaleString("en-US", { maximumFractionDigits: digits });
};
function gapTone(bps) {
  const a = Math.abs(bps);
  if (bps >= 0 || a <= CLOSE_BPS) return "acc-good";
  if (a <= 200) return "acc-warn";
  return "acc-bad";
}
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

function rowHtml(r) {
  const chain = CHAIN_LABEL[r.chainId] || r.chain;
  if (r.status !== "ok") {
    return `<tr><td>${esc(chain)}</td><td>${esc(r.pair)}</td><td class="mono">${esc(usd(r.sizeUsd))}</td><td colspan="4" class="muted">Not measured this run: ${esc(r.error || "no answer")}</td></tr>`;
  }
  return `<tr>
  <td>${esc(chain)}</td>
  <td>${esc(r.pair)}</td>
  <td class="mono">${esc(usd(r.sizeUsd))}</td>
  <td class="mono">${esc(r.venue)}</td>
  <td class="mono">${esc(amount(r.ours))}</td>
  <td class="mono">${esc(amount(r.reference))}</td>
  <td class="mono ${gapTone(r.gapBps)}">${esc(pct(r.gapBps))}</td>
</tr>`;
}

function stat(value, label, note) {
  return `<div class="acc-stat"><strong>${esc(value)}</strong><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
}

const STYLE = `<style>
.acc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); border: 1px solid var(--line); }
.acc-stat { padding: 18px 20px; border-right: 1px solid var(--line); display: grid; gap: 4px; }
.acc-stat:last-child { border-right: 0; }
.acc-stat strong { font: 800 30px/1 var(--display); letter-spacing: -.03em; }
.acc-stat span { font-weight: 600; font-size: 14px; }
.acc-stat small { color: var(--muted); font-size: 13px; }
.acc-good { color: #1e7a3c; font-weight: 600; }
.acc-warn { color: #9a6200; font-weight: 600; }
.acc-bad { color: #b3261e; font-weight: 600; }
.acc-hist td, .acc-hist th { padding: 10px 12px; }
</style>`;

export function renderAccuracyMain(doc) {
  const head = `<div class="wrap page-head">
    <p class="eyebrow">Updated daily · independent reference · nothing hidden</p>
    <h1>How close are our prices?</h1>
    <p class="lead">Every day we quote the same trades two ways at the same moment: verify402's route check, and an independent DEX aggregator (KyberSwap). Below is the gap for every trade, good or bad.</p>
  </div>`;
  if (!doc) {
    return `${STYLE}${head}
  <section class="tight"><div class="wrap"><p class="lead">The first daily scan has not run yet. Check back tomorrow.</p></div></section>`;
  }
  const s = doc.summary || summarizeAccuracy(doc.rows);
  const small = s.smallTrades || {};
  const large = s.largeTrades || {};
  const history = [...(doc.history || [])].reverse().slice(0, 14);
  return `${STYLE}${head}
  <section class="tight">
    <div class="wrap">
      <p class="small muted" style="margin-bottom:14px">Last run: ${esc(when(doc.generatedAt))} · ${esc(s.ok)} of ${esc(s.total)} trades measured · <a class="textlink" href="/accuracy.json">raw data (JSON)</a></p>
      <div class="acc-stats">
        ${stat(s.medianAbsGapBps == null ? "—" : pct(s.medianAbsGapBps).replace(/^\+/, ""), "Typical gap", "median, all trades")}
        ${stat(`${small.withinHalfPercent ?? 0} / ${small.ok ?? 0}`, "$1,000 trades within 0.5%", "of the aggregator's price")}
        ${stat(`${large.withinHalfPercent ?? 0} / ${large.ok ?? 0}`, "$25,000 trades within 0.5%", "large orders split more")}
        ${stat(`${s.oursHigherOrEqual} / ${s.ok}`, "Trades where we paid as much or more", "")}
      </div>
    </div>
  </section>

  <section class="tight">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Every trade, this run</p><h2>Our best quote vs the aggregator.</h2></div>
      <p class="small muted" style="margin:10px 0 16px">Gap = how much more (+) or less (−) our best single pool pays than the aggregator's route. Green: we match or beat it, or are within 0.5%. Amber: within 2%. Red: more than 2% behind.</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Network</th><th>Trade</th><th>Size</th><th>Our best venue</th><th>We quote</th><th>Aggregator</th><th>Gap</th></tr></thead>
          <tbody>
${doc.rows.map(rowHtml).join("\n")}
          </tbody>
        </table>
      </div>
    </div>
  </section>

  ${history.length > 1 ? `<section class="tight">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Day by day</p><h2>The last ${history.length} runs.</h2></div>
      <div class="table-wrap" style="margin-top:16px">
        <table class="table acc-hist">
          <thead><tr><th>Date</th><th>Trades measured</th><th>Typical gap</th><th>$1,000 within 0.5%</th><th>$25,000 within 0.5%</th></tr></thead>
          <tbody>
${history.map((h) => `<tr><td>${esc(h.date)}</td><td class="mono">${esc(h.ok)} / ${esc(h.total)}</td><td class="mono">${h.medianAbsGapBps == null ? "—" : esc(pct(h.medianAbsGapBps).replace(/^\+/, ""))}</td><td class="mono">${esc(h.smallTrades?.withinHalfPercent ?? "—")} / ${esc(h.smallTrades?.ok ?? "—")}</td><td class="mono">${esc(h.largeTrades?.withinHalfPercent ?? "—")} / ${esc(h.largeTrades?.ok ?? "—")}</td></tr>`).join("\n")}
          </tbody>
        </table>
      </div>
    </div>
  </section>` : ""}

  <section class="soft">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Read this before the numbers</p><h2>What this does and does not show.</h2></div>
      <ul class="lead" style="margin-top:16px;display:grid;gap:10px;padding-left:20px">
        <li>We quote one pool, read straight from the chain at a pinned block. An aggregator can split one order across many pools and sources we do not read, so on large trades it is expected to pay more. That gap is real, and we show it.</li>
        <li>The aggregator's number is its own route estimate, not a filled trade. Neither number includes gas or slippage settings.</li>
        <li>Each trade is quoted once a day. Prices move; a gap on one run says nothing certain about the next.</li>
        <li>This is a measurement, not advice and not a promise about any future quote.</li>
      </ul>
    </div>
  </section>`;
}

export function renderAccuracyPage(template, doc) {
  return template.replace("<!--ACCURACY_MAIN-->", renderAccuracyMain(doc));
}
