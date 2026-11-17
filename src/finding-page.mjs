// A shareable page for one free finding.
//
// /findings is a JSON snapshot: useful to a machine, useless to a human who
// wants to post "look at this" in a Discord or a GitHub issue. This module
// renders the same row as a page with a stable URL, the pinned block, the
// reproducible inputs and the method — so a link carries the evidence, not a
// screenshot of it.
//
// Rules kept from the rest of the site:
//   * no claim that the measurement does not make (the caveat is on the page);
//   * every number is re-derivable from the block named on the page;
//   * nothing here accepts arbitrary tokens — the set is the free showcase
//     pairs, so this page can never become a free /verify.

export const FINDING_ORIGIN = "https://vex402.online";

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function findingPermalink(target, { origin = FINDING_ORIGIN } = {}) {
  return `${origin}/finding/${encodeURIComponent(String(target).toUpperCase())}`;
}

const VERDICT_TITLE = {
  edge: "an edge survived measured costs",
  no_edge: "no edge at this size",
  no_edge_costs_ate_it: "costs ate the gross spread",
  unavailable: "could not be measured",
};

const signed = (n) => (typeof n === "number" ? `${n > 0 ? "+" : ""}${n}` : "—");

function head({ title, description, permalink }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(permalink)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(permalink)}">
<meta property="og:image" content="${esc(`${FINDING_ORIGIN}/logo-400.png`)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header class="site-head">
  <a class="brand" href="/" aria-label="verify402 home">verify<span>[</span>402<span>]</span></a>
  <nav class="site-nav" aria-label="Primary">
    <a href="/checks">Checks</a>
    <a href="/preflight">Preflight</a>
    <a href="/inspect">Inspect</a>
    <a href="/directory">Directory</a>
    <a href="/board">Board</a>
    <a href="/live">Live findings</a>
    <a href="/docs">Docs</a>
  </nav>
  <div class="site-actions">
    <a class="btn sm" href="/live#findings">All findings</a>
  </div>
</header>`;
}

const FOOT = `</body>
</html>`;

export function renderFindingPage(row, { origin = FINDING_ORIGIN, measuredAt = null } = {}) {
  const target = String(row?.target ?? "").toUpperCase() || "—";
  const verdict = String(row?.verdict ?? "unavailable");
  const permalink = findingPermalink(target, { origin });
  const titleText = `${target} round trip at $100k: ${verdict} · verify402`;
  const description = `Free measurement: buying and selling ${target} against USDC at one pinned block, with gas and the flash-loan premium subtracted. Numbers below are re-derivable from the block named on this page.`;

  if (verdict === "unavailable") {
    const reason = row?.reason ? String(row.reason) : "the chain or provider could not be read";
    return `${head({ title: titleText, description, permalink })}
<main>
  <div class="wrap page-head">
    <p class="eyebrow">Free finding · Ethereum mainnet</p>
    <h1>${esc(target)} round trip: could not be measured</h1>
    <p class="lead">This page reports the measurement as it happened. It did not produce a number, so it prints no number: ${esc(reason)}.</p>
    <div class="btn-row" style="margin-top:24px">
      <a class="btn" href="/live#findings">See the current findings</a>
      <a class="btn ghost" href="/finding/${encodeURIComponent(target)}">Retry this page</a>
    </div>
    <p class="small muted" style="margin-top:18px">A failure to read the chain is a failure of this service, not evidence about ${esc(target)}.</p>
  </div>
</main>
${FOOT}`;
  }

  const inputs = row.inputs || {};
  const buy = inputs.buy || {};
  const sell = inputs.sell || {};
  const gas = inputs.gas || {};
  const size = inputs.size || {};
  const block = row.blockNumber ?? null;
  const blockHash = row.blockHash ? String(row.blockHash) : null;
  const when = measuredAt ? String(measuredAt).replace("T", " ").slice(0, 19) + " UTC" : null;

  const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;

  return `${head({ title: titleText, description, permalink })}
<main>
  <div class="wrap page-head">
    <p class="eyebrow">Free finding · Ethereum mainnet${when ? ` · measured ${esc(when)}` : ""}</p>
    <h1>${esc(target)} round trip at $100k: ${esc(verdict)}</h1>
    <p class="lead">${esc(VERDICT_TITLE[verdict] || verdict)}. Buy on ${esc(buy.venue || "—")}, sell on ${esc(sell.venue || "—")}, at block ${esc(block ?? "—")}. Gas and the flash-loan premium are subtracted before the verdict is printed.</p>
    <div class="btn-row" style="margin-top:24px">
      <a class="btn" href="/live#findings">All free findings</a>
      <a class="btn ghost" href="/checks#verify">Measure any token at your size — $0.05</a>
    </div>
  </div>

  <section>
    <div class="wrap">
      <h2>The numbers</h2>
      <div class="table-wrap" style="margin-top:18px">
        <table class="table">
          <thead><tr><th>Field</th><th>Value</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>Gross</td><td class="mono">${esc(signed(row.grossBps))} bps</td><td>Spread between the two legs before costs.</td></tr>
            <tr><td>Net</td><td class="mono">${esc(signed(row.netBps))} bps</td><td>After gas and the flash-loan premium. This decides the verdict.</td></tr>
            <tr><td>Verdict</td><td class="mono">${esc(verdict)}</td><td>${esc(VERDICT_TITLE[verdict] || verdict)}.</td></tr>
            <tr><td>Block</td><td class="mono">${esc(block ?? "—")}</td><td>Every quote on this page used this block.</td></tr>
          </tbody>
        </table>
      </div>

      <h2 style="margin-top:48px">The inputs</h2>
      <p class="small muted" style="margin-top:10px">Anything you need to re-derive both bps numbers with a public RPC.</p>
      <dl class="kv" style="margin-top:18px">
        ${kv("Size", size.human != null ? `${size.human} ${size.symbol || "USDC"}` : "—")}
        ${kv("Buy venue", `${buy.venue || "—"}${buy.feeBps != null ? ` · ${buy.feeBps} bps fee` : ""}`)}
        ${kv("Sell venue", `${sell.venue || "—"}${sell.feeBps != null ? ` · ${sell.feeBps} bps fee` : ""}`)}
        ${kv("Gas at measurement", gas.usd != null ? `$${gas.usd} (${gas.units ?? "—"} units at ${gas.priceGwei ?? "—"} gwei)` : "—")}
        ${kv("Flash-loan premium", inputs.flashLoanPremiumBps != null ? `${inputs.flashLoanPremiumBps} bps` : "—")}
        ${kv("Minimum net asked", inputs.minNetBps != null ? `${inputs.minNetBps} bps` : "—")}
        ${blockHash ? kv("Block hash", blockHash) : ""}
      </dl>

      <h2 style="margin-top:48px">The method, and what it does not cover</h2>
      <p style="margin-top:14px">${esc(row.method || "Exact-input quotes at the pinned block through the named venue routers.")}</p>
      <p class="small muted" style="margin-top:14px">One pair, one size, one block. This is a measurement, not a forecast and not financial advice. It does not price MEV, private orderflow, or venues outside the configured set. The honest answer is normally <b>no_edge</b> — that is the market's fee boundary, not a failure.</p>

      <h2 style="margin-top:48px">Reproduce it</h2>
      <pre style="margin-top:14px"><span class="c">curl</span> ${esc(origin)}/findings</pre>
      <p class="small muted" style="margin-top:12px">The same row is in that JSON. To measure a different token, a different size or a different chain, the paid route does it with the same method: <span class="mono">POST /verify</span>.</p>
    </div>
  </section>
</main>
${FOOT}`;
}
