// The human site is one set of static files served by two different
// deployments: the testnet demo and the mainnet box. Copy that describes the
// payment rail ("testnet USDC", "Base Sepolia", "demo payments are testnet")
// is only true on the demo. This module rewrites those claims at serve time
// so the mainnet instance never tells a visitor it is paying fake money when
// the 402 challenge asks for real USDC.
//
// The blog posts are historical records: their bodies keep the rail that was
// true when they were written. Only the site-wide legal footer is rewritten
// there, because the footer describes the running service, not the post.

import { readFileSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const FOOTER_PAIRS = [
  [
    "Analysis reads mainnet chain data; public demo payments are Base Sepolia testnet USDC. Testnet settlements on this demo are the operator’s own. Mainnet receipts: vex402.online/proof.",
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Live settlement counts and USDC volume: vex402.online/stats.",
  ],
  [
    "Analysis reads mainnet chain data; public demo payments are Base Sepolia testnet USDC. Testnet settlements on this demo are the operator's own. Mainnet receipts: vex402.online/proof. No sponsor yet.",
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Live settlement counts and USDC volume: vex402.online/stats.",
  ],
  [
    "Analysis reads mainnet chain data; demo payments are testnet. Testnet settlements on this demo are the operator's own. Mainnet receipts: vex402.online/proof. Donations are voluntary",
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Six operator calls and two outside payments of 0.03 USDC each (2026-11-19) have settled on Base mainnet. Donations are voluntary",
  ],
  [
    "Analysis reads mainnet chain data; demo payments are testnet. Testnet settlements on this demo are the operator's own. Mainnet receipts: vex402.online/proof. Prices are per call, paid in testnet USDC over x402",
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Six operator calls and two outside payments of 0.03 USDC each (2026-11-19) have settled on Base mainnet. Prices are per call, paid in USDC over x402",
  ],
];

const PAGE_PAIRS = [
  // ---- landing ----
  [
    "Public demo payments are Base Sepolia testnet USDC; analysis reads mainnet chain data.",
    "Payments settle in USDC on Base mainnet and Solana mainnet; analysis reads mainnet chain data.",
  ],
  [
    "full settlement on Base Sepolia, from the operator’s own funds",
    "full settlements on Base mainnet, from the operator’s own funds",
  ],
  [
    "pays the public demo in Base Sepolia testnet USDC.",
    "pays this instance in USDC on Base mainnet.",
  ],
  [
    "paid in testnet USDC on the public demo",
    "paid in USDC on Base mainnet",
  ],
  [
    "Paid calls use testnet USDC in the public demo; mainnet settlement is not the demo default.",
    "Paid calls settle in USDC on Base mainnet.",
  ],
  [
    "Public demo payments are Base Sepolia testnet USDC. No mainnet payment service is being offered here, and no result is a profit forecast.",
    "Yes — this instance settles real USDC on Base mainnet and Solana mainnet through the Coinbase CDP facilitator. The settlement path is proven end to end, and two outside x402 agents have paid 0.03 USDC each. No result is a profit forecast.",
  ],

  // ---- checks ----
  [
    "Public demo payments use testnet USDC over x402 on Base Sepolia; analysis reads mainnet chain data.",
    "Payments settle in USDC over x402 on Base mainnet; analysis reads mainnet chain data.",
  ],
  [
    "Pay per call in testnet USDC for the public demo; no account",
    "Pay per call in USDC on Base mainnet; no account",
  ],

  // ---- activity ----
  [
    "<title>Activity — testnet explorer for verify402</title>",
    "<title>Activity — mainnet explorer for verify402</title>",
  ],
  [
    "A testnet explorer for verify402: every payment the service received on Base Sepolia, every verdict it published",
    "A mainnet explorer for verify402: every payment the service received on Base, every verdict it published",
  ],
  [
    '<div class="net-ribbon" role="note">',
    '<div class="net-ribbon mainnet" role="note">',
  ],
  [
    '<strong>TESTNET</strong> · Base Sepolia · every payment on this page is testnet USDC. The live mainnet instance is <a class="textlink" href="https://vex402.online/info">vex402.online</a>.',
    "<strong>MAINNET</strong> · Base · every payment on this page is real USDC.",
  ],
  [
    'On-chain · testnet <span class="tag-testnet">TESTNET</span>',
    'On-chain · mainnet <span class="tag-mainnet">MAINNET</span>',
  ],
  [
    'A testnet explorer for this service: every payment it received',
    'A mainnet explorer for this service: every payment it received',
  ],
  [
    "<th>Amount (testnet USDC)</th>",
    "<th>Amount (USDC)</th>",
  ],
  [
    "· Base Sepolia testnet</div>",
    "· Base mainnet</div>",
  ],
  [
    '<strong>Payments</strong> are Base Sepolia testnet USDC. The live mainnet instance is <a class="textlink" href="https://vex402.online/info">vex402.online</a>. <strong>Verdicts</strong>',
    "<strong>Payments</strong> are real USDC on Base mainnet. <strong>Verdicts</strong>",
  ],

  // ---- testers ----
  [
    "The public demo settles testnet payments only; analysis reads mainnet chain data.",
    "This instance settles real USDC on Base mainnet; analysis reads mainnet chain data.",
  ],
  [
    "A normal x402 payment on the testnet demo.",
    "A normal x402 payment on this instance.",
  ],
  [
    "No wallet connection, no payment, no mainnet settlement, no token, no funding ask. The public demo uses Base Sepolia testnet USDC; analysis reads mainnet chain data. Do not send mainnet funds for this test.",
    "No wallet connection, no payment, no token, no funding ask. This instance settles in USDC on Base mainnet; analysis reads mainnet chain data. This test is free — the gate checks an intent and never moves funds.",
  ],

  // ---- start ----
  [
    "This is a canonical x402 payment request: 0.01 testnet USDC on Base Sepolia, a known payee, a known resource. Paste it as-is. The analysis reads mainnet chain data; this demo's payment rail is testnet-only.",
    "This is a canonical x402 payment request: 0.01 USDC on Base mainnet, a known payee, a known resource. Paste it as-is. The analysis reads mainnet chain data; this instance's payment rail is Base mainnet / Solana mainnet.",
  ],
  [
    "0.01 testnet USDC (6 decimals). Free hosting sleeps: the first call after a pause can take ~30 seconds. This is the free gate: no payment is sent.",
    "0.01 USDC (6 decimals). This is the free gate: no payment is sent.",
  ],

  // ---- docs ----
  [
    "#   accepts: eip155:84532 (Base Sepolia testnet USDC) or solana:EtWTR… (devnet USDC)",
    "#   accepts: eip155:8453 (USDC on Base mainnet) or solana:5eyk… (USDC on Solana mainnet)",
  ],

  // ---- preflight ----
  [
    "<span>Payments: Base Sepolia demo</span>",
    "<span>Payments: Base mainnet</span>",
  ],

  // ---- mcp ----
  [
    '<span>Demo · Base Sepolia</span><span>Mainnet live · <a href="https://vex402.online/info" class="textlink">vex402.online</a></span>',
    "<span>Live · Base mainnet</span><span>Solana mainnet</span>",
  ],
  [
    "The public Base Sepolia testnet demo was retired on 2026-11-19; this instance serves the retirement redirect. The live service is the mainnet product at https://vex402.online.",
    "Paid calls on this instance settle in USDC over x402 on Base mainnet and Solana mainnet through the Coinbase CDP facilitator. The npm package defaults here: VERIFY402_URL=https://vex402.online and VERIFY402_NETWORKS=eip155:8453. The public testnet demo was retired on 2026-11-19.",
  ],
  [
    "The public testnet demo was retired on 2026-11-19; this instance serves the retirement redirect. The package defaults to the live mainnet service at https://vex402.online (settled end to end; two outside x402 agents have paid 0.03 USDC each) — real USDC, with the same spend caps.",
    "Paid calls on this instance settle in USDC on Base mainnet (settled end to end; two outside x402 agents have paid 0.03 USDC each). The npm package defaults to this mainnet rail; the public testnet demo was retired on 2026-11-19.",
  ],
  [
    'By default the bridge pays the live mainnet service: add a dedicated wallet holding a small amount of <strong>USDC on Base mainnet</strong> and leave <code class="inline">VERIFY402_NETWORKS=eip155:8453</code>.',
    'For this instance, add a wallet with <strong>USDC on Base mainnet</strong> and leave <code class="inline">VERIFY402_NETWORKS=eip155:8453</code> (the default). The Base Sepolia testnet demo is explicit opt-in.',
  ],
  [
    "The analysis reads mainnet chain data, and this testnet demo's payment rail is Base Sepolia testnet-only. The package default is the live mainnet service at https://vex402.online, with a mainnet-funded wallet.",
    "The analysis reads mainnet chain data, and payment on this instance is real USDC on Base mainnet; use a small, dedicated wallet.",
  ],
];

// Sample intents on the docs/quickstart pages: network ids and the canonical
// USDC address must match the instance, or a copied example is checked against
// the wrong chain.
const SAMPLE_PAIRS = [
  ["eip155:84532", "eip155:8453"],
  ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
];

function applyPairs(html, pairs) {
  let out = html;
  for (const [from, to] of pairs) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

// Fingerprint the shipped assets once per process. The HTML is no-store, so
// every deploy immediately serves a new fingerprint next to each /assets/
// URL — any edge or browser cache of the same URL is bypassed after a deploy.
const ASSET_BUILD = (() => {
  try {
    const dir = fileURLToPath(new URL("./site/assets", import.meta.url));
    const rows = [];
    const walk = (d, rel) => {
      for (const name of readdirSync(d)) {
        const full = `${d}/${name}`;
        const s = statSync(full);
        if (s.isDirectory()) walk(full, `${rel}${name}/`);
        else rows.push([`${rel}${name}`, readFileSync(full)]);
      }
    };
    walk(dir, "");
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const hash = createHash("sha256");
    for (const [rel, body] of rows) hash.update(rel).update(body);
    return hash.digest("hex").slice(0, 10);
  } catch {
    return "dev";
  }
})();

export function withAssetFingerprint(html) {
  return html.replace(/((?:href|src)="\/assets\/[^"?]+)(")/g, `$1?v=${ASSET_BUILD}$2`);
}

// Google Search Console gets one sitemap at the mainnet origin. Pin every
// served HTML page to that origin so the old Render host cannot split ranking
// signals; pages that already declare a canonical keep their own value.
const CANONICAL_ORIGIN = "https://vex402.online";
// One masthead for every HTML page. Each page file still carries its own
// <header class="site-head"> (so it renders on its own), but the server swaps
// it for this one when it sends the page, so the menu can never drift again.
const PRIMARY_LINKS = [
  ["/", "Home"],
  ["/preflight", "Free check"],
  ["/checks", "Paid checks"],
  ["/mcp", "MCP"],
  ["/docs", "Docs"],
  ["/blog", "Blog"],
];
const MENU_GROUPS = [
  ["Start", [["/", "Home"], ["/preflight", "Free check"], ["/checks", "Paid checks &amp; prices"], ["/start", "Quickstart"], ["/mcp", "MCP server"]]],
  ["Tools", [["/inspect", "402 inspector"], ["/directory", "402 directory"], ["/board", "Public board"], ["/live", "Live findings"], ["/activity", "Activity"]]],
  ["Trust", [["/proof", "Proof &amp; receipts"], ["/audit", "Payment review"], ["/testers", "Tester kit"]]],
  ["Project", [["/blog", "Blog"], ["/docs", "Documentation"], ["/donate", "Donate"], ["/sponsor", "Sponsor hosting"], ["https://github.com/a32116150-ctrl/verify402", "GitHub"]]],
];

function isCurrent(href, path) {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

export function siteHeader(path = "/") {
  const cur = (href) => (isCurrent(href, path) ? ' aria-current="page"' : "");
  const primary = PRIMARY_LINKS.map(([h, t]) => `    <a href="${h}"${cur(h)}>${t}</a>`).join("\n");
  const menu = MENU_GROUPS.map(([label, links]) => [
    `        <p class="menu-label">${label}</p>`,
    ...links.map(([h, t]) => `        <a href="${h}"${h.startsWith("http") ? ' rel="noopener"' : cur(h)}>${t}</a>`),
  ].join("\n")).join("\n");
  const status = path === "/"
    ? '\n    <a class="site-status" href="/live"><span class="status-dot"></span><span data-block>snapshot · block —</span></a>'
    : "";
  return `<header class="site-head">
  <a class="brand" href="/" aria-label="verify402 home">verify<span>[</span>402<span>]</span></a>
  <nav class="site-nav" aria-label="Primary">
${primary}
  </nav>
  <div class="site-actions">${status}
    <a class="btn sm" href="/preflight#try">Run free check</a>
    <details class="site-menu">
      <summary><span class="menu-more">More</span><span class="menu-all">Menu</span></summary>
      <nav aria-label="Menu">
${menu}
      </nav>
    </details>
  </div>
</header>`;
}

export function withSiteHeader(html, path = "/") {
  return html.replace(/<header class="site-head">[\s\S]*?<\/header>/, () => siteHeader(path));
}

export function withCanonical(html, path = "/") {
  html = withSiteHeader(html, cleanPath(path));
  if (/<link\s+[^>]*rel=["']canonical["'][^>]*>/i.test(html)) return html;
  const headClose = html.indexOf("</head>");
  if (headClose < 0) return html;
  const clean = cleanPath(path);
  return `${html.slice(0, headClose)}  <link rel="canonical" href="${CANONICAL_ORIGIN}${clean}">\n${html.slice(headClose)}`;
}

function cleanPath(path) {
  let clean = String(path || "/").split(/[?#]/, 1)[0];
  if (!clean.startsWith("/")) clean = `/${clean}`;
  if (clean.length > 1) clean = clean.replace(/\/+$/, "");
  if (clean.endsWith(".html")) clean = clean.slice(0, -5) || "/";
  return clean;
}

export function renderSiteHtml(html, { mode = "testnet", path = "" } = {}) {
  if (mode !== "mainnet") return html;
  const isBlogPost = path.startsWith("/blog/");
  let out = applyPairs(html, FOOTER_PAIRS);
  if (!isBlogPost) {
    out = applyPairs(out, PAGE_PAIRS);
    out = applyPairs(out, SAMPLE_PAIRS);
  }
  return out;
}

export const SITE_RENDER_PAIRS = { FOOTER_PAIRS, PAGE_PAIRS, SAMPLE_PAIRS };
