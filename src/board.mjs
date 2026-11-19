// Public board: what the first page of the public x402 catalog returns when a
// caller reads their payment demand.
//
// The data is produced by scripts/board-scan.mjs (one read-only request per
// endpoint) and published on the `board-data` branch so a data refresh never
// redeploys the service. This module loads it, renders the human page, and
// renders the embeddable badge.
//
// What a verdict is: one structural read of one 402 at a stated time. It is not
// an audit, a reputation score, an endorsement, or a promise about settlement.
// Everything rendered here has to say that in the same breath as the numbers.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const BOARD_SPEC = "verify402/board@1";

export const BOARD_SOURCE =
  process.env.VERIFY402_BOARD_URL ||
  "https://raw.githubusercontent.com/a32116150-ctrl/verify402/board-data/data/board.json";

const CACHE_MS = 15 * 60 * 1000;
// A failed refresh must not lock the board out for a full cache window: the
// first request on a cold instance is exactly when the fetch is most likely to
// time out, and a 15-minute penalty would serve stale data for that long.
const RETRY_MS = 60 * 1000;
const LOCAL_FILE = new URL("../data/board.json", import.meta.url);

export const BOARD_CAVEATS = [
  "One read-only request per endpoint at the time shown. A 402 may differ by method, path, payload, or day.",
  "Well-formed means the payment demand parsed and held together; it is not a security audit, a reputation score, or an endorsement.",
  "Refused and unreadable are properties of the read, not verdicts on the seller.",
  "Prices, chains, and payees are the values the endpoint advertised, not values verify402 vouched for.",
  "Nothing here was paid, signed, or settled.",
];

const VERDICT_META = {
  pass: {
    label: "well-formed",
    short: "PASS",
    color: "#1a7f4b",
    hint: "Parsed, bound to its resource, priced in a token we know, timeout within the default posture.",
  },
  caution: {
    label: "flagged",
    short: "CAUTION",
    color: "#9a6700",
    hint: "Well-formed, with one thing a buyer should see — usually an authorization window longer than 15 minutes.",
  },
  refused: {
    label: "refused",
    short: "REFUSED",
    color: "#8250df",
    hint: "Two documents disagreed (header and body) or the terms were not representable. The inspector will not guess.",
  },
  block: {
    label: "blocked",
    short: "BLOCK",
    color: "#a40e26",
    hint: "Carried terms this gate will not sign: more than one payee, or an amount it cannot represent.",
  },
  unreachable: {
    label: "unreachable",
    short: "NO READ",
    color: "#57606a",
    hint: "The endpoint did not answer, or what it answered was not an x402 challenge.",
  },
};

export function verdictOf(row) {
  const p = String(row?.verdict || row?.protocol || "").toUpperCase();
  if (p === "PASS") return "pass";
  if (p === "CAUTION") return "caution";
  if (p === "BLOCK") return "block";
  const err = String(row?.error || "");
  if (err === "challenge_mismatch" || err === "terms_unrepresentable") return "refused";
  return "unreachable";
}

const CHAINS = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
  "eip155:1": "Ethereum",
  "eip155:10": "Optimism",
  "eip155:42161": "Arbitrum",
  "eip155:137": "Polygon",
  "eip155:56": "BSC",
  "eip155:196": "X Layer",
  "eip155:143": "Monad",
  "eip155:480": "Worldchain",
  "eip155:59144": "Linea",
  "eip155:8453 ": "Base",
};

export function chainLabel(network) {
  const n = String(network || "");
  if (!n) return "—";
  if (CHAINS[n]) return CHAINS[n];
  if (n.startsWith("eip155:")) return `chain ${n.slice(7)}`;
  if (n.startsWith("solana:")) return "Solana";
  if (n.startsWith("algorand:")) return "Algorand";
  if (n.startsWith("hyperliquid:")) return "Hyperliquid";
  return n.length > 18 ? `${n.slice(0, 16)}…` : n;
}

export function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

export function formatPrice(usd) {
  if (usd === null || usd === undefined || usd === "") return "—";
  const n = Number(usd);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  const fixed = n.toFixed(6).replace(/0+$/, "");
  return `$${fixed}`;
}

export function formatWindow(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 3600 && n % 3600 === 0) return `${n / 3600} h`;
  if (n >= 60 && n % 60 === 0) return `${n / 60} min`;
  return `${n} s`;
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function str(v, max = 300) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// A board row is small on purpose: nothing here needs a full inspect payload,
// and the page must stay renderable from a 300-row JSON file.
export function normalizeRow(raw) {
  const resource = str(raw?.resource, 500);
  if (!resource) return null;
  const verdict = verdictOf(raw);
  const reasons = Array.isArray(raw?.reasons) ? raw.reasons.filter(Boolean).map((r) => str(r, 40)).slice(0, 5) : [];
  return {
    resource,
    method: String(raw?.method || "GET").toUpperCase() === "POST" ? "POST" : "GET",
    verdict,
    reasons,
    chain: str(raw?.chain || raw?.networkType || "", 60) || null,
    chainLabel: chainLabel(raw?.chain || raw?.network),
    priceUsd: raw?.priceUsd ?? null,
    maxTimeoutSeconds: count(raw?.maxTimeoutSeconds),
    calls30d: count(raw?.calls30d ?? raw?.l30DaysTotalCalls),
    checkedAt: str(raw?.checkedAt || raw?.lastUpdated, 40) || null,
  };
}

export function normalizeBoard(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rows)) return null;
  const rows = raw.rows.map(normalizeRow).filter(Boolean).slice(0, 2000);
  if (!rows.length) return null;
  const counts = { pass: 0, caution: 0, refused: 0, block: 0, unreachable: 0 };
  for (const r of rows) counts[r.verdict] += 1;
  return {
    spec: BOARD_SPEC,
    generatedAt: str(raw.generatedAt, 40) || null,
    source: str(raw.source, 300) || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
    catalogTotal: count(raw.catalogTotal),
    rows,
    counts,
    caveats: Array.isArray(raw.caveats) && raw.caveats.length
      ? raw.caveats.map((c) => str(c, 300)).filter(Boolean)
      : BOARD_CAVEATS,
  };
}

export function emptyBoard() {
  return {
    spec: BOARD_SPEC,
    generatedAt: null,
    source: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
    catalogTotal: null,
    rows: [],
    counts: { pass: 0, caution: 0, refused: 0, block: 0, unreachable: 0 },
    caveats: BOARD_CAVEATS,
  };
}

export function readLocalBoard() {
  try {
    return normalizeBoard(JSON.parse(readFileSync(LOCAL_FILE, "utf8")));
  } catch {
    return null;
  }
}

let cache = { at: 0, retryAt: 0, data: null, refreshing: null, lastError: null };

export function boardCacheState() {
  return {
    at: cache.at,
    retryAt: cache.retryAt,
    hasData: Boolean(cache.data && cache.data.rows && cache.data.rows.length),
    refreshing: Boolean(cache.refreshing),
    lastError: cache.lastError,
  };
}

export function resetBoardCacheForTests() {
  cache = { at: 0, retryAt: 0, data: null, refreshing: null, lastError: null };
}

// Never block a request on the network: serve what we have, refresh behind it.
// A refresh that fails is retried after RETRY_MS, not after the full cache window.
export async function loadBoard({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!cache.data) cache.data = readLocalBoard() || emptyBoard();
  const now = Date.now();
  const stale = now - cache.at > CACHE_MS;
  if (stale && !cache.refreshing && now >= cache.retryAt && typeof fetchImpl === "function") {
    const snapshot = cache.data;
    cache.refreshing = (async () => {
      try {
        const res = await fetchImpl(BOARD_SOURCE, {
          headers: { "user-agent": "verify402-board/1 (+https://vex402.online/board)" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`board source ${res.status}`);
        const data = normalizeBoard(await res.json());
        if (!data) throw new Error("board source returned no usable rows");
        cache = { at: Date.now(), retryAt: 0, data, refreshing: null, lastError: null };
      } catch (e) {
        cache.lastError = e?.message ?? String(e);
        cache.retryAt = Date.now() + RETRY_MS;
      } finally {
        cache.refreshing = null;
      }
      return snapshot;
    })();
  }
  return cache.data;
}

export function findRow(board, url) {
  const target = String(url || "").trim();
  if (!target) return null;
  const exact = board.rows.find((r) => r.resource === target);
  if (exact) return exact;
  const want = target.replace(/\/+$/, "");
  return board.rows.find((r) => r.resource.replace(/\/+$/, "") === want) || null;
}

export function badgeFor(board, url) {
  const row = findRow(board, url);
  if (!row) {
    return {
      verdict: "unknown",
      right: "not scanned",
      color: "#57606a",
      title:
        "verify402 has not read this endpoint. A badge only appears after a board scan; it is not a claim either way.",
    };
  }
  const meta = VERDICT_META[row.verdict] || VERDICT_META.unreachable;
  const extra = row.reasons.includes("long_timeout") ? " · long window" : "";
  let host = row.resource;
  try { host = new URL(row.resource).host; } catch { /* keep the raw string */ }
  return {
    verdict: row.verdict,
    right: `${meta.label}${extra}`,
    color: meta.color,
    title: `${host}: x402 402 ${meta.label}${extra}. Structural check on ${formatDate(row.checkedAt)} by verify402 — not an audit or endorsement.`,
  };
}

// ---------------------------------------------------------------------------
// Badge SVG (shields-style, no external assets, no font loading)

const DEFAULT_BADGE = {
  left: "x402 · verify402",
  right: "not scanned",
  color: "#57606a",
  title: "verify402 has not read this endpoint.",
};

function estimateWidth(text) {
  return Math.max(46, Math.round(text.length * 6.4 + 14));
}

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderBadgeSvg(badge = DEFAULT_BADGE) {
  const b = { ...DEFAULT_BADGE, ...badge };
  const leftW = estimateWidth(b.left);
  const rightW = estimateWidth(b.right);
  const total = leftW + rightW;
  const aria = `${b.left}: ${b.right}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${xml(aria)}">
<title>${xml(b.title || aria)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${leftW}" height="20" fill="#24292f"/>
<rect x="${leftW}" width="${rightW}" height="20" fill="${b.color}"/>
<rect width="${total}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${leftW / 2}" y="14">${xml(b.left)}</text>
<text x="${leftW + rightW / 2}" y="14">${xml(b.right)}</text>
</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// Page

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rowIds(row) {
  return `e-${shortHash(row.resource)}`;
}

const REASON_LABELS = {
  long_timeout: "long window",
  non_exact_scheme: "non-exact scheme",
  multiple_payees: "two payees",
  resource_host_mismatch: "host mismatch",
  invalid_amount: "bad amount",
};

function verdictChip(row) {
  const meta = VERDICT_META[row.verdict] || VERDICT_META.unreachable;
  const why = row.reasons.length
    ? ` · ${row.reasons.map((r) => REASON_LABELS[r] || r.replace(/_/g, " ")).join(" · ")}`
    : "";
  return `<span class="board-chip" style="--c:${meta.color}" title="${esc(meta.hint)}">${esc(meta.short)}${esc(why)}</span>`;
}

function rowHtml(row) {
  const chain = row.chain ? chainLabel(row.chain) : row.chainLabel;
  const link = `/inspect?url=${encodeURIComponent(row.resource)}`;
  const short = row.resource.replace(/^https?:\/\//, "");
  return `<tr id="${rowIds(row)}" data-verdict="${esc(row.verdict)}" data-chain="${esc(chain)}" data-text="${esc(short.toLowerCase())}">
  <td class="board-ep"><span class="board-method">${esc(row.method)}</span><a href="${esc(link)}">${esc(short)}</a></td>
  <td>${verdictChip(row)}</td>
  <td>${esc(chain || "—")}</td>
  <td class="board-num">${esc(formatPrice(row.priceUsd))}</td>
  <td class="board-num">${esc(formatWindow(row.maxTimeoutSeconds))}</td>
  <td class="board-num">${row.calls30d === null ? "—" : esc(row.calls30d.toLocaleString("en-US"))}</td>
  <td class="board-num board-muted">${esc(formatDate(row.checkedAt))}</td>
  <td><button class="board-copy" type="button" data-url="${esc(row.resource)}" aria-label="Copy the badge snippet for this endpoint">badge</button></td>
</tr>`;
}

export function renderBoardPage(board, { origin = "https://vex402.online" } = {}) {
  const b = board || emptyBoard();
  const c = b.counts || {};
  const rows = b.rows || [];
  const wellFormed = (c.pass || 0) + (c.caution || 0);
  const chains = [...new Set(rows.map((r) => (r.chain ? chainLabel(r.chain) : r.chainLabel)).filter((x) => x && x !== "—"))].sort();
  const generated = b.generatedAt ? new Date(b.generatedAt) : null;
  const generatedLabel = generated && !Number.isNaN(generated.getTime())
    ? generated.toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "not yet run";

  const stat = (label, value, hint) =>
    `<div class="board-stat"><span class="board-stat-v">${esc(value)}</span><span class="board-stat-l">${esc(label)}</span><span class="board-stat-h">${esc(hint)}</span></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Public x402 endpoint board · verify402</title>
<meta name="description" content="A daily structural read of 300 public x402 endpoints (the first 300 entries the public catalog returns): which return a well-formed payment demand, which need a look, and which refused to be read. One read-only request each, raw JSON included.">
<link rel="canonical" href="${esc(origin)}/board">
<meta property="og:type" content="website">
<meta property="og:title" content="Public x402 endpoint board">
<meta property="og:description" content="A daily structural read of public x402 payment demands. Timestamped, read-only, no endorsements.">
<meta property="og:url" content="${esc(origin)}/board">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/rss+xml" title="verify402 blog" href="/blog/rss.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<style>
  .board-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 26px 0 10px; }
  .board-stat { background: var(--paper, #fff); padding: 16px 18px; display: flex; flex-direction: column; gap: 4px; }
  .board-stat-v { font: 700 26px/1 var(--sans); font-variant-numeric: tabular-nums; }
  .board-stat-l { font: 600 12px/1.2 var(--mono); text-transform: lowercase; letter-spacing: .02em; color: var(--ink-2, #333); }
  .board-stat-h { font: 400 12px/1.4 var(--sans); color: var(--muted); }
  .board-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 26px 0 10px; }
  .board-controls input, .board-controls select { font: 500 14px/1 var(--sans); padding: 9px 11px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: inherit; }
  .board-controls input { min-width: 260px; flex: 1 1 260px; }
  .board-count { font: 500 13px/1 var(--mono); color: var(--muted); margin-left: auto; }
  .board-table tr[hidden] { display: none; }
  .board-ep a { font-family: var(--mono); font-size: 13.5px; overflow-wrap: anywhere; }
  .board-method { display: inline-block; margin-right: 7px; font: 600 10px/1.6 var(--mono); letter-spacing: .04em; color: var(--muted); border: 1px solid var(--line); padding: 0 5px; border-radius: 3px; vertical-align: 1px; }
  .board-chip { display: inline-block; font: 700 10.5px/1.9 var(--mono); letter-spacing: .03em; color: #fff; background: var(--c); padding: 0 7px; border-radius: 3px; white-space: nowrap; }
  .board-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .board-muted { color: var(--muted); }
  .board-copy { font: 600 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px; border: 1px solid var(--line); background: transparent; border-radius: 4px; cursor: pointer; color: var(--ink-2, #333); }
  .board-copy:hover { background: var(--soft, #f4f4f2); }
  .board-caveats { margin: 14px 0 0; padding-left: 20px; color: var(--ink-2, #333); font-size: 14.5px; line-height: 1.55; }
  .board-caveats li { margin-bottom: 6px; }
  .board-legend { display: grid; gap: 8px; margin: 16px 0 0; }
  .board-legend div { display: grid; grid-template-columns: 92px 1fr; gap: 12px; font-size: 14.5px; }
  .board-legend span { font: 700 10.5px/2 var(--mono); letter-spacing: .03em; color: #fff; background: var(--c); padding: 0 7px; border-radius: 3px; align-self: start; text-align: center; }
  .board-legend p { margin: 0; color: var(--ink-2, #333); }
  .board-snippet { background: var(--soft, #f4f4f2); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; font: 500 12.5px/1.6 var(--mono); overflow-x: auto; }
  @media (max-width: 720px) { .board-ep a { font-size: 12.5px; } .board-controls input { min-width: 0; } }
</style>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dataset","name":"verify402 public x402 endpoint board","description":"A daily structural read of public x402 payment demands. Timestamped, read-only, not an endorsement.","url":"${esc(origin)}/board","isAccessibleForFree":true,"creator":{"@type":"Organization","name":"verify402","url":"${esc(origin)}"},"license":"https://github.com/a32116150-ctrl/verify402/blob/master/LICENSE","distribution":[{"@type":"DataDownload","contentUrl":"${esc(origin)}/board.json","encodingFormat":"application/json"}]}</script>
</head>
<body>

<header class="site-head">
  <a class="brand" href="/" aria-label="verify402 home">verify<span>[</span>402<span>]</span></a>
  <nav class="site-nav" aria-label="Primary">
    <a href="/checks">Checks</a>
    <a href="/preflight">Preflight</a>
    <a href="/inspect">Inspect</a>
    <a href="/board" aria-current="page">Board</a>
    <a href="/mcp">MCP</a>
    <a href="/proof">Proof</a>
    <a href="/blog">Blog</a>
    <a href="/docs">Docs</a>
  </nav>
  <div class="site-actions">
    <a class="btn sm" href="/inspect">Inspect a 402</a>
    <details class="site-menu">
      <summary>Menu</summary>
      <nav aria-label="Menu">
        <a href="/checks">Checks</a>
        <a href="/preflight">Preflight</a>
        <a href="/inspect">Inspect a 402</a>
        <a href="/board">Public board</a>
        <a href="/mcp">MCP server</a>
        <a href="/live">Live findings</a>
        <a href="/activity">Activity</a>
        <a href="/proof">Proof &amp; receipts</a>
        <a href="/blog">Blog</a>
        <a href="/testers">Test the gate</a>
        <a href="/docs">Docs</a>
        <a href="/start">Quickstart</a>
        <a href="https://github.com/a32116150-ctrl/verify402" rel="noopener">GitHub</a>
      </nav>
    </details>
  </div>
</header>

<main>
  <div class="wrap page-head">
    <p class="eyebrow">Public board · refreshed daily · last scan ${esc(generatedLabel)}</p>
    <h1>Which x402 endpoints return a payment demand an agent can actually read.</h1>
    <p class="lead">Every row is one read-only request against the endpoint, run by the same code an agent uses before signing. Timestamped. No wallet, no payment, no endorsement.</p>
  </div>

  <section class="wrap">
    <div class="board-stats">
      ${stat("endpoints", rows.length || "0", "in this scan")}
      ${stat("well-formed", wellFormed, "PASS + flagged")}
      ${stat("flagged", c.caution || 0, "worth a look")}
      ${stat("refused", c.refused || 0, "inspector would not guess")}
      ${stat("blocked", c.block || 0, "terms the gate will not sign")}
      ${stat("no read", c.unreachable || 0, "no answer, or not x402")}
    </div>
    <div class="callout warn">
      <h3>Read the verdict, then read this</h3>
      <p>A verdict here is <b>one structural read of one payment demand at one time</b>. It is not an audit, not a reputation score, and not an endorsement. Well-formed is not safe: the demand can parse perfectly and the seller can still be dishonest. This board does not check reputation, settlement, delivery, or intent — it checks whether an agent can read the terms and refuse with confidence before it signs.</p>
    </div>
    <ul class="board-caveats">
      ${(b.caveats || []).map((c) => `<li>${esc(c)}</li>`).join("\n      ")}
    </ul>
    <div class="board-legend">
      ${Object.entries(VERDICT_META).map(([key, m]) => `<div><span style="--c:${m.color}">${esc(m.short)}</span><p>${esc(m.hint)}</p></div>`).join("\n      ")}
    </div>
  </section>

  <section class="wrap" id="list">
    <div class="board-controls">
      <input id="board-q" type="search" placeholder="Filter by host or path…" aria-label="Filter endpoints">
      <select id="board-verdict" aria-label="Filter by verdict">
        <option value="">Every verdict</option>
        <option value="pass">Well-formed</option>
        <option value="caution">Flagged</option>
        <option value="refused">Refused</option>
        <option value="block">Blocked</option>
        <option value="unreachable">No read</option>
      </select>
      <select id="board-chain" aria-label="Filter by chain">
        <option value="">Every chain</option>
        ${chains.map((ch) => `<option value="${esc(ch)}">${esc(ch)}</option>`).join("\n        ")}
      </select>
      <span class="board-count" id="board-count">${rows.length} shown</span>
    </div>

    <div class="table-wrap">
      <table class="table board-table">
        <thead>
          <tr><th>Endpoint</th><th>Verdict</th><th>Chain</th><th>Price</th><th>Window</th><th>30d calls</th><th>Read</th><th></th></tr>
        </thead>
        <tbody>
${rows.map(rowHtml).join("\n")}
        </tbody>
      </table>
    </div>
    ${rows.length === 0 ? '<p class="board-muted">The scan has not run yet. The board fills on the first scheduled scan; until then, read any endpoint yourself with <a href="/inspect">/inspect</a>.</p>' : ""}
  </section>

  <section class="wrap prose" style="margin-top:48px">
    <h2>Put your own result on your page</h2>
    <p>Every row above has a badge. It is generated from the last scan, links back to your row, and says <i>structural check</i> on it, because that is all it is. If your endpoint is not here, read it yourself first — <a class="textlink" href="/inspect">/inspect</a> takes any public URL and returns the same verdict shape.</p>
    <p class="board-snippet" id="board-snippet">&lt;a href="${esc(origin)}/board"&gt;&lt;img src="${esc(origin)}/badge?url=https%3A%2F%2Fexample.com%2Fpaid-route" alt="x402 402 status from verify402" height="20"&gt;&lt;/a&gt;</p>
    <p class="board-muted">No tracking pixels, no per-seller ranking, no paid placements. A badge disappears if the endpoint stops appearing in a scan; it is not a subscription and cannot be bought.</p>

    <h2>How this stays honest</h2>
    <ul>
      <li><b>One request per endpoint per scan</b>, identified as verify402, 400 ms apart, no credentials forwarded, no payment attempted.</li>
      <li><b>Machine-readable:</b> the same data is at <a class="textlink" href="/board.json">/board.json</a>, including the caveats, so an agent can read the board without trusting the page.</li>
      <li><b>Refusals are ours, not accusations.</b> "Refused" means two documents disagreed and the inspector would not pick one. The seller may be entirely honest and simply dual-published two dialects.</li>
      <li><b>Stale is labelled.</b> If the daily scan has not run, the date at the top says so.</li>
    </ul>

    <h2>Run an endpoint that is not listed</h2>
    <p>The board covers the first page of the public catalog, not all of it. To read yours, use <a class="textlink" href="/inspect">/inspect</a> — free, no wallet. To have it included in the next scan, send the URL to <a class="textlink" href="mailto:a32116150@gmail.com?subject=verify402%20board%3A%20scan%20this%20endpoint">a32116150@gmail.com</a> with the subject left as it is.</p>
  </section>
</main>

<footer class="site-foot">
  <div class="foot-mark" aria-hidden="true">verify<span>[402]</span></div>
  <div class="foot-links">
    <div>
      <h2>Product</h2>
      <a href="/preflight">Preflight gate</a>
      <a href="/checks">The six checks</a>
      <a href="/inspect">Inspect a 402</a>
      <a href="/board">Public board</a>
      <a href="/mcp">MCP server</a>
      <a href="/live">Live findings</a>
      <a href="/activity">Activity</a>
      <a href="/testers">Tester kit</a>
      <a href="/blog">Blog</a>
      <a href="/start">Quickstart</a>
    </div>
    <div>
      <h2>Project</h2>
      <a href="/proof">Proof &amp; receipts</a>
      <a href="/docs">Documentation</a>
      <a href="/donate">Donate</a>
      <a href="/sponsor">Sponsor hosting</a>
      <a href="https://github.com/a32116150-ctrl/verify402" rel="noopener">Source code</a>
      <a href="https://github.com/x402-foundation/x402/issues/3847" rel="noopener">x402 proposal</a>
    </div>
    <div>
      <h2>For machines</h2>
      <a href="/.well-known/verify402.json">Service manifest</a>
      <a href="/board.json">/board.json</a>
      <a href="/openapi.json">OpenAPI 3.1</a>
      <a href="/llms.txt">llms.txt</a>
      <a href="/findings">/findings</a>
      <a href="/blog/rss.xml">RSS</a>
    </div>
    <div>
      <h2>For teams</h2>
      <p class="foot-note">Embedding a pre-signing check in a wallet, agent, or treasury workflow?</p>
      <a href="mailto:a32116150@gmail.com?subject=verify402%20walkthrough">Talk to the builder</a>
      <a href="https://www.npmjs.com/package/verify402-mcp" target="_blank" rel="noopener">npm package</a>
    </div>
  </div>
  <p class="foot-legal">verify402 is a measurement service, not financial advice. Board rows are structural reads of public payment demands, timestamped; they are not audits, endorsements, or promises about any seller. Two outside x402 payers have settled on Base mainnet. Analysis reads mainnet chain data; demo payments are testnet.</p>
</footer>

<script>
(function () {
  "use strict";
  var q = document.getElementById("board-q");
  var verdict = document.getElementById("board-verdict");
  var chain = document.getElementById("board-chain");
  var count = document.getElementById("board-count");
  var rows = Array.prototype.slice.call(document.querySelectorAll(".board-table tbody tr"));

  function apply() {
    var text = (q && q.value || "").trim().toLowerCase();
    var v = verdict && verdict.value;
    var ch = chain && chain.value;
    var shown = 0;
    rows.forEach(function (row) {
      var ok = true;
      if (text && row.getAttribute("data-text").indexOf(text) === -1) ok = false;
      if (ok && v && row.getAttribute("data-verdict") !== v) ok = false;
      if (ok && ch && row.getAttribute("data-chain") !== ch) ok = false;
      if (ok) { row.removeAttribute("hidden"); shown++; } else { row.setAttribute("hidden", ""); }
    });
    if (count) count.textContent = shown + " shown";
  }
  [q, verdict, chain].forEach(function (el) { if (el) el.addEventListener("input", apply); });

  document.querySelectorAll(".board-copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var url = btn.getAttribute("data-url") || "";
      var snippet = '<a href="' + location.origin + '/board"><img src="' + location.origin + '/badge?url=' + encodeURIComponent(url) + '" alt="x402 402 status from verify402" height="20"></a>';
      var done = function () { btn.textContent = "copied"; setTimeout(function () { btn.textContent = "badge"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(snippet).then(done, done);
      } else {
        done();
      }
      var box = document.getElementById("board-snippet");
      if (box) box.textContent = snippet;
    });
  });
})();
</script>
</body>
</html>`;
}
