// Mode-aware payment metadata for runtime discovery surfaces.
//
// The server's settlement path supports both a testnet demo and an explicit
// mainnet deployment. These builders keep /info, /llms.txt, the agent card,
// OpenAPI examples, and the x402 discovery manifest from hardcoding the demo
// rail while the process is actually configured for another mode.

import { PUBLISHED_VERSION } from "./version.mjs";

export const DEMO_BASE_URL = "https://vex402.online";
export const DEMO_NETWORK = "eip155:84532";
export const MAINNET_NETWORK = "eip155:8453";
export const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TESTNET_SVM = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const MAINNET_SVM = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export function normalizeMode(mode) {
  return mode === "mainnet" ? "mainnet" : "testnet";
}

export function paymentRail(mode) {
  const normalized = normalizeMode(mode);
  const testnet = normalized === "testnet";

  return {
    mode: normalized,
    testnet,
    evmNetwork: testnet ? DEMO_NETWORK : MAINNET_NETWORK,
    svmNetwork: testnet ? TESTNET_SVM : MAINNET_SVM,
    evmAsset: testnet ? TESTNET_USDC : MAINNET_USDC,
    label: testnet ? "Base Sepolia / Solana devnet" : "Base mainnet / Solana mainnet",
    shortLabel: testnet ? "Base Sepolia testnet" : "Base mainnet",
    usdcLabel: testnet ? "testnet USDC" : "USDC",
    heading: testnet
      ? "## Paid, x402 exact, testnet USDC (Base Sepolia / Solana devnet)"
      : "## Paid, x402 exact, USDC (Base mainnet / Solana mainnet)",
    paragraph: testnet
      ? "The public demo's payment rail is testnet: Base Sepolia (`eip155:84532`) or Solana devnet. The analysis reads mainnet chain data. Mainnet settlement is an explicit deployment, never a demo default."
      : "This instance is configured for mainnet settlement: Base mainnet (`eip155:8453`) or Solana mainnet. Mainnet operation must be separately funded, facilitated, and verified; this metadata does not claim the public demo validated it.",
    serverDescription: testnet
      ? "Public demo server (Base Sepolia / Solana devnet payments; analysis reads mainnet chain data)"
      : "Mainnet-configured server (Base mainnet / Solana mainnet payments); mainnet readiness must be verified separately",
    openapiDescription: testnet
      ? "Token safety check for AI agents before they swap: quote-based sellability, round-trip cost, TRUST / CAUTION / AVOID. $0.02 per call, free pre-signing gate included. Supporting paid checks cover arbitrage reality, execution book, quote fairness and trade capacity at pinned blocks. The public demo settles on Base Sepolia testnet; analysis reads Ethereum, Arbitrum, and Base chain data. Mainnet settlement is an explicit deployment choice, not a demo default."
      : "Token safety check for AI agents before they swap: quote-based sellability, round-trip cost, TRUST / CAUTION / AVOID. $0.02 per call, free pre-signing gate included. Supporting paid checks cover arbitrage reality, execution book, quote fairness and trade capacity at pinned blocks. This instance is configured for Base mainnet / Solana mainnet settlement; mainnet operation requires separate readiness verification and is not implied to be production-validated by the public demo.",
    paidFlowNote: testnet
      ? "The public demo uses Base Sepolia (`eip155:84532`); mainnet is not a demo default."
      : "This instance is configured for Base mainnet (`eip155:8453`); verify mainnet readiness separately before paying.",
    agentDescription: testnet
      ? "Token safety check for AI agents before they swap: quote-based sellability, round-trip cost, TRUST / CAUTION / AVOID. $0.02 per call, free pre-signing gate included. Supporting checks cover arbitrage reality, execution book, quote fairness and trade capacity. POST /preflight is the free pre-signing " +
        "gate: validate an x402 payment request, a chain transaction, or a sign-in message and get PASS / CAUTION / " +
        "BLOCK with a short-lived receipt bound to the exact intent. POST /verify measures whether a claimed " +
        "cross-venue arbitrage is real (pinned-block quotes from Uniswap QuoterV2 and each " +
        "router's own math; the honest answer is usually no_edge). POST /safety is a pre-trade " +
        "gate: contract facts, market liquidity and scam signals, a quote-based sellability " +
        "check through the configured venues' own routers, round-trip cost at the intended size, " +
        "and phantom-price detection. It does not execute a transfer; transfer restrictions and " +
        "unconfigured venues are named in notChecked. " +
        "TRUST / CAUTION / AVOID with evidence. Per-call x402 payment in testnet USDC on Base Sepolia or Solana devnet for the public demo; analysis reads mainnet chain data. " +
        "An MCP server (verify402-mcp, stdio) exposes the free gate and all six checks to any " +
        "MCP client; install at /mcp. No profitability is ever promised; the service reports what it measured."
      : "Token safety check for AI agents before they swap: quote-based sellability, round-trip cost, TRUST / CAUTION / AVOID. $0.02 per call, free pre-signing gate included. Supporting checks cover arbitrage reality, execution book, quote fairness and trade capacity. POST /preflight is the free pre-signing " +
        "gate: validate an x402 payment request, a chain transaction, or a sign-in message and get PASS / CAUTION / " +
        "BLOCK with a short-lived receipt bound to the exact intent. POST /verify measures whether a claimed " +
        "cross-venue arbitrage is real (pinned-block quotes from Uniswap QuoterV2 and each " +
        "router's own math; the honest answer is usually no_edge). POST /safety is a pre-trade " +
        "gate: contract facts, market liquidity and scam signals, a quote-based sellability " +
        "check through the configured venues' own routers, round-trip cost at the intended size, " +
        "and phantom-price detection. It does not execute a transfer; transfer restrictions and " +
        "unconfigured venues are named in notChecked. " +
        "TRUST / CAUTION / AVOID with evidence. This instance is configured for x402 payment in USDC on Base mainnet or Solana mainnet; analysis reads mainnet chain data. " +
        "Mainnet readiness must be verified separately; the public demo does not validate it. " +
        "An MCP server (verify402-mcp, stdio) exposes the free gate and all six checks to any " +
        "MCP client; install at /mcp. No profitability is ever promised; the service reports what it measured.",
  };
}

export function buildAgentDescription(mode = "testnet") {
  return paymentRail(mode).agentDescription;
}

export function buildPreflightPaymentExample({ mode = "testnet", baseUrl = DEMO_BASE_URL, payTo }) {
  const rail = paymentRail(mode);
  return {
    scheme: "exact",
    network: rail.evmNetwork,
    asset: rail.evmAsset,
    amount: "10000",
    payTo,
    resource: `${baseUrl}/verify`,
    maxTimeoutSeconds: 60,
  };
}

// Smallest copy-paste body that works as-is. OpenAPI, the invalid_kind hint,
// and /llms.txt all use this shape so the docs and the running gate agree.
export function buildPreflightRequestExample({
  mode = "testnet",
  baseUrl = DEMO_BASE_URL,
  payTo = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
} = {}) {
  const rail = paymentRail(mode);
  return {
    kind: "payment",
    payment: {
      scheme: "exact",
      network: rail.evmNetwork,
      asset: rail.evmAsset,
      amount: "10000",
      payTo,
      resource: `${baseUrl}/verify`,
    },
    policy: { maxAmountUsd: 0.25, allowedResourceHosts: [new URL(baseUrl).hostname] },
  };
}

export function buildInfoHosting(mode = "testnet") {
  const rail = paymentRail(mode);
  if (rail.testnet) {
    return {
      status: "Demo instance runs on a free host: first request after idle can take about a minute; testnet only.",
      freeTier: true,
      coldStartSeconds: 60,
    };
  }
  return {
    status: "Mainnet-configured instance. Mainnet settlement requires an always-on paid host and separate readiness verification; this metadata does not claim production validation.",
    freeTier: false,
    coldStartSeconds: 0,
  };
}

export function buildPreflightPaymentNetworks(mode = "testnet") {
  const rail = paymentRail(mode);
  return rail.testnet
    ? "Free preflight validates EVM (1, 42161, 8453, 84532, 11155111) + Solana mainnet/devnet intents; paid public-demo settlement offers Base Sepolia / Solana devnet only."
    : "Free preflight validates EVM (1, 42161, 8453, 84532, 11155111) + Solana mainnet/devnet intents; paid settlement in this configured mode offers Base mainnet / Solana mainnet only.";
}

/**
 * Plain-text service contract for /llms.txt. The configured mode decides the
 * paid-rail language, so a mainnet process never publishes testnet copy and a
 * testnet process never advertises an unvalidated mainnet default.
 */
export function buildLlmsText({
  mode = "testnet",
  baseUrl = DEMO_BASE_URL,
  publishedVersion = PUBLISHED_VERSION,
} = {}) {
  const rail = paymentRail(mode);
  const envLine = rail.testnet
    ? `  Public demo: set VERIFY402_NETWORKS=${rail.evmNetwork}; omit EVM_PRIVATE_KEY`
    : `  Mainnet: set VERIFY402_NETWORKS=${rail.evmNetwork} explicitly; omit EVM_PRIVATE_KEY`;
  // Public install text references the published artifact.
  const installVersion = `@${publishedVersion}`;
  const preflightJson = JSON.stringify(buildPreflightRequestExample({ mode, baseUrl }), null, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  return [
    "# verify402",
    "",
    "> Token safety check for AI agents before they swap: quote-based sellability,",
    "> round-trip cost, TRUST / CAUTION / AVOID. $0.02 per call, free pre-signing",
    "> gate included. Supporting checks cover arbitrage reality, execution book,",
    "> quote fairness and trade capacity at pinned blocks.",
    "",
    `Live: ${baseUrl}`,
    `Quickstart: ${baseUrl}/start`,
    `Tester kit: ${baseUrl}/testers`,
    `Blog: ${baseUrl}/blog`,
    `Activity: ${baseUrl}/activity`,
    `Inspector: ${baseUrl}/inspect`,
    `Guide: AI agent payment security — ${baseUrl}/ai-agent-payment-security`,
    `Guide: x402 endpoint checker — ${baseUrl}/x402-endpoint-checker`,
    `Guide: verify USDC payment request — ${baseUrl}/verify-usdc-payment-request`,
    `Guide: token approval checker — ${baseUrl}/token-approval-checker`,
    `Guide: agent payment receipt — ${baseUrl}/agent-payment-receipt`,
    `Guide: crypto arbitrage verification — ${baseUrl}/crypto-arbitrage-verification`,
    `Guide: Solana x402 payments — ${baseUrl}/solana-x402-payments`,
    `Board: ${baseUrl}/board — daily structural read of public x402 endpoints`,
    `Directory: ${baseUrl}/directory`,
    `Interactive Docs: ${baseUrl}/docs`,
    `MCP Information: ${baseUrl}/mcp`,
    "Code: https://github.com/a32116150-ctrl/verify402",
    "",
    "## Free, no key, no wallet",
    "",
    "- POST /preflight — PASS / CAUTION / BLOCK for a payment, a chain",
    "  transaction, or a sign-in message, with typed reasons, the checks that",
    "  ran, the checks that did not, and a short-lived HMAC receipt (90s default).",
    "- kind=transaction also returns `advice`: a plain-language explanation, a",
    "  preview of what leaves and enters the wallet, fixes with suggested values",
    "  for each flagged problem, and the paid check that fits. policy.maxRiskUsd",
    "  is the owner's dollar limit: more at risk is BLOCK, unpriceable risk is",
    "  CAUTION. An optional `quote` binds a swap to the quote it came with.",
    "- kind=sign-in — checks an EIP-4361 / CAIP-122 message (or structured",
    "  fields) against expected.host / chainId / address. It flags domain, URI",
    "  origin, nonce, freshness, chain and address mismatches. It does not check",
    "  whether the site is legitimate, whether the nonce came from the server,",
    "  replay state, or what the login grants.",
    "- POST /preflight/verify — recompute a receipt. Tampered or expired",
    "  receipts return valid: false.",
    "- POST /inspect — fetch an x402 402 challenge (or accept one pasted) and",
    "  run the structural payment preflight on every option. Free, no wallet.",
    "- GET /board and GET /board.json — a daily structural read of the",
    "  first 300 entries of the public x402 catalog, one read each (verdict, chain, price, timestamp).",
    "  Measurement, not endorsement; the JSON carries the caveats.",
    "- GET /findings — free published verdicts.",
    "- GET /explorer — on-chain payments and published verdicts, with explorer links.",
    "- GET /npm-stats — npm download counters for the MCP package.",
    "- GET /health — liveness and network configuration.",
    "- GET /info — JSON capabilities and pricing.",
    "",
    "## Copy-paste free preflight",
    "",
    "```sh",
    `curl -sS -X POST ${baseUrl}/preflight \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${preflightJson}'`,
    "```",
    "",
    rail.heading,
    "",
    rail.paragraph,
    "",
    "Each paid call returns a verdict with reproducible evidence and an",
    "evidence_bundle (requestHash, responseHash, pinnedBlock). The 402",
    "challenge is authoritative for price and payee.",
    "",
    `- POST /verify — 0.05 ${rail.usdcLabel}. Is this cross-venue arbitrage real at`,
    "  one pinned block? Most common honest answer: no_edge.",
    `- POST /safety — 0.02 ${rail.usdcLabel}. Lead check: quote-based sellability, round-trip`,
    "  cost, TRUST / CAUTION / AVOID. It does not execute a transfer; transfer",
    "  restrictions and unconfigured venues stay in notChecked.",
    `- POST /route — 0.03 ${rail.usdcLabel}. Every configured venue quoting tokenIn to`,
    "  tokenOut at one pinned block, best first.",
    `- POST /quotecheck — 0.05 ${rail.usdcLabel}. Audit someone else's quote: fair /`,
    "  overpaying / too_good_to_be_true / unknown.",
    `- POST /depth — 0.05 ${rail.usdcLabel}. Supporting sizing check: largest size that`,
    "  still clears your cost tolerance; capacityUsd.",
    `- POST /assure — 0.10 ${rail.usdcLabel}. Bundle of supplied paid checks at one pinned`,
    "  block, one evidence record; accepted only when those checks cost at least $0.10",
    "  separately.",
    "",
    "## Machine-readable Manifests & Discovery",
    "",
    "- /.well-known/verify402.json — Canonical machine-readable service manifest.",
    "- /openapi.json — OpenAPI 3.1 contract with x-payment-info on every paid route.",
    "- /.well-known/x402 — x402 capability manifest (draft-hawkins-x402-dns-discovery-02).",
    "- /.well-known/agent-card.json — A2A agent card (ERC-8004).",
    "- /sitemap.xml — XML sitemap for public documentation indexers.",
    "- MCP bridge package: verify402-mcp (stdio transport)",
    `  Install the published package: npx -y verify402-mcp${installVersion}`,
    envLine,
    "  for the free gate only.",
    "  npm: https://www.npmjs.com/package/verify402-mcp",
    "  Official MCP Registry: io.github.a32116150-ctrl/verify402-mcp",
    "",
    "## Honest boundary & Security",
    "",
    "No profit promises. The most common verdict is no_edge, and that",
    "negative result is the product. Verdicts ship with the pinned",
    "block and cryptographic hashes needed to reproduce or refute them.",
    "A PASS on preflight does not mean a transaction is universally safe;",
    "always inspect the 'notChecked' array for unverified assumptions.",
    "",
  ].join("\n");
}
