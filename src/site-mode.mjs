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
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Eight paid calls have settled on Base: six operator tests and two outside payments of 0.03 USDC each (2026-11-19). No human customer yet.",
  ],
  [
    "Analysis reads mainnet chain data; public demo payments are Base Sepolia testnet USDC. Testnet settlements on this demo are the operator's own. Mainnet receipts: vex402.online/proof. No sponsor yet.",
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Six operator tests and two outside payments of 0.03 USDC each (2026-11-19) have settled on Base mainnet. No human customer or sponsor yet.",
  ],
  [
    "Analysis reads mainnet chain data; demo payments are testnet. Testnet settlements on this demo are the operator's own. Mainnet receipts: vex402.online/proof. Donations are voluntary",
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Six operator tests and two outside payments of 0.03 USDC each (2026-11-19) have settled on Base mainnet. No human customer yet. Donations are voluntary",
  ],
  [
    "Analysis reads mainnet chain data; demo payments are testnet. Testnet settlements on this demo are the operator's own. Mainnet receipts: vex402.online/proof. Prices are per call, paid in testnet USDC over x402",
    "Analysis reads mainnet chain data. This instance settles real USDC on Base mainnet / Solana mainnet over x402. Six operator tests and two outside payments of 0.03 USDC each (2026-11-19) have settled on Base mainnet. No human customer yet. Prices are per call, paid in USDC over x402",
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
    "Yes — this instance settles real USDC on Base mainnet and Solana mainnet through the Coinbase CDP facilitator. It is operator-tested end to end, and two outside x402 agents have paid 0.03 USDC each; no human customer yet. No result is a profit forecast.",
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
    "Paid calls in this testnet demo are Base Sepolia testnet USDC over x402. The npm package defaults to the live mainnet service at https://vex402.online (Base + Solana mainnet, real USDC, Coinbase CDP facilitator) — point it here instead with VERIFY402_URL=https://verify402.onrender.com and VERIFY402_NETWORKS=eip155:84532.",
    "Paid calls on this instance settle in USDC over x402 on Base mainnet and Solana mainnet through the Coinbase CDP facilitator. The npm package defaults here: VERIFY402_URL=https://vex402.online and VERIFY402_NETWORKS=eip155:8453. The Base Sepolia testnet demo is explicit opt-in at https://verify402.onrender.com.",
  ],
  [
    "This testnet demo's paid calls use Base Sepolia testnet USDC. The package itself now defaults to the live mainnet service at https://vex402.online (operator-tested end to end; two outside x402 agents have paid 0.03 USDC each) — real USDC, with the same spend caps. Point the package here with VERIFY402_URL=https://verify402.onrender.com and VERIFY402_NETWORKS=eip155:84532 to use testnet instead.",
    "Paid calls on this instance settle in USDC on Base mainnet (operator-tested end to end; two outside x402 agents have paid 0.03 USDC each, no human customer yet). The npm package defaults to this mainnet rail; the Base Sepolia testnet demo at https://verify402.onrender.com is explicit opt-in.",
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
