// verify402 - a machine-payable truth service.
//
//   POST /verify   paid, $0.05   -> a rigorous verdict on whether an
//                                   arbitrage opportunity is real right now
//   GET  /info     free          -> machine-readable service description
//   GET  /health   free
//
// Payment is x402: the caller gets HTTP 402 with payment instructions, pays in
// stablecoin on Base or Solana, retries with proof, and gets the answer. No
// account, no API key, no signup - which is the entire point, because the
// intended caller is a program.

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { measureRoundTrip, clientFor } from "./measure.mjs";
import { preTradeCheck } from "./safety.mjs";
import { CHAINS, DEFAULT_SIZE } from "./config.mjs";

// ---------------------------------------------------------------- config ----
const MODE = process.env.X402_MODE === "mainnet" ? "mainnet" : "testnet";

const NETWORKS =
  MODE === "mainnet"
    ? { evm: "eip155:8453", svm: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", label: "Base mainnet / Solana mainnet" }
    : { evm: "eip155:84532", svm: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", label: "Base Sepolia / Solana devnet" };

const PAY_TO_EVM = process.env.PAY_TO_EVM || "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
const PAY_TO_SVM = process.env.PAY_TO_SVM || "BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ";
const PRICE = process.env.PRICE || "$0.05";
// The pre-trade gate is the product most agents will call before every swap;
// it is priced above /verify because it does strictly more work:
// contract facts, market data, a USD-sized sell probe and a full round trip.
const SAFETY_PRICE = process.env.SAFETY_PRICE || "$0.10";

// The public x402.org facilitator is testnet-only. Mainnet needs a real one.
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || (MODE === "mainnet" ? "" : "https://x402.org/facilitator");

if (MODE === "mainnet" && !FACILITATOR_URL) {
  console.error("REFUSING TO START: mainnet mode needs FACILITATOR_URL (e.g. https://api.cdp.coinbase.com/platform/v2/x402).");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 4021);

// ----------------------------------------------------------------- app -----
const app = express();
app.use(express.json({ limit: "64kb" }));

// Same price on both rails, so an agent can pay on whichever chain it already
// holds funds - and a Solana agent never has to bridge.
const accepts = (price) => [
  { scheme: "exact", price, network: NETWORKS.evm, payTo: PAY_TO_EVM },
  { scheme: "exact", price, network: NETWORKS.svm, payTo: PAY_TO_SVM },
];

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// Local development escape hatch. Loud on purpose: a service that believes it
// is charging when it is not is worse than one that is plainly down.
const BYPASS_PAYMENT = process.env.BYPASS_PAYMENT === "1";
if (BYPASS_PAYMENT) {
  console.warn("\n  *** BYPASS_PAYMENT=1 : paid routes are UNPROTECTED. Local testing only. ***\n");
}

// Middleware stays compiled but UNMOUNTED in bypass mode: one loud warning,
// no protection, and no possibility of the two configs disagreeing.
if (!BYPASS_PAYMENT) app.use(
  paymentMiddleware(
    {
      "POST /verify": {
        accepts: accepts(PRICE),
        description:
          "Measure whether a cross-venue arbitrage round trip is profitable right now, using Uniswap's canonical QuoterV2 and the venues' own V2 routers, at one pinned block. Returns a verdict with full evidence.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { chainId: 1, target: "WETH", base: "USDC", size: 100000 },
            inputSchema: {
              properties: {
                chainId: { type: "integer", description: "1 Ethereum, 42161 Arbitrum, 8453 Base" },
                target: { type: "string", description: "Token symbol to buy and sell back, e.g. WETH" },
                base: { type: "string", description: "Token to trade from, default USDC" },
                size: { type: "number", description: "Amount of base to trade, in whole units" },
                minNet: { type: "number", description: "Required net profit in base units to call it an edge" },
              },
              required: ["target"],
            },
          }),
        },
      },
      "POST /safety": {
        accepts: accepts(SAFETY_PRICE),
        description:
          "Pre-trade gate for an agent about to buy a token. Verdict TRUST / CAUTION / AVOID with evidence: contract facts from the live chain, market liquidity and scam signals, a USD-sized sell probe (the honeypot question, answered against every venue's own router, direct and WETH-routed), a full round-trip cost at your intended size, and an offered-price sanity check against chain consensus.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { chainId: 1, tokenAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", intendedUsd: 500 },
            output: { verdict: "TRUST", reasons: [], notes: [], checked: ["contract", "market", "sellability", "liquidity"] },
            inputSchema: {
              properties: {
                chainId: { type: "integer", description: "1 Ethereum, 42161 Arbitrum, 8453 Base" },
                tokenAddress: { type: "string", description: "ERC-20 contract address (or a known symbol like WETH)" },
                intendedUsd: { type: "number", description: "Size you plan to buy, in USD, default 500" },
                offeredPriceUsd: { type: "number", description: "Price per token someone offered you, for the phantom-price check" },
                baseSymbol: { type: "string", description: "Settlement token, default USDC" },
              },
              required: ["tokenAddress"],
            },
          }),
        },
      },
    },
    new x402ResourceServer(facilitatorClient)
      .register(NETWORKS.evm, new ExactEvmScheme())
      .register(NETWORKS.svm, new ExactSvmScheme()),
  ),
);

// ------------------------------------------------------------- free routes --
// Well-known agent discovery files. These are the two surfaces agents and
// indexers actually look for when they meet an unfamiliar service: the A2A
// agent card and the ERC-8004 domain-verification file. Both derive from one
// registration file so they can never disagree.
function registrationFile(req) {
  const base = process.env.AGENT_URL || `${req.protocol}://${req.get("host")}`;
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "verify402",
    description:
      "Machine-payable truth service for AI agents. POST /verify measures whether a claimed " +
      "cross-venue arbitrage is real (pinned-block quotes from Uniswap QuoterV2 and each " +
      "router's own math; the honest answer is usually no_edge). POST /safety is a pre-trade " +
      "gate: contract facts, market liquidity and scam signals, a USD-sized sell probe across " +
      "every venue, round-trip cost at the intended size, and phantom-price detection. " +
      "TRUST / CAUTION / AVOID with evidence. Per-call x402 payment, USDC on Base or Solana. " +
      "No profitability is ever promised; the service reports what it measured.",
    image: `${base}/agent-icon.svg`,
    services: [
      { name: "web", endpoint: base },
      { name: "x402", endpoint: `${base}/verify`, version: "x402" },
      { name: "x402", endpoint: `${base}/safety`, version: "x402" },
    ],
    x402Support: true,
    active: true,
    supportedTrust: ["reputation"],
  };
  // Once the owner mints the identity (npm run register), set AGENT_ID and
  // IDENTITY_REGISTRY and the file binds back to the on-chain agent.
  if (process.env.AGENT_ID && process.env.IDENTITY_REGISTRY) {
    file.registrations = [{
      agentId: Number(process.env.AGENT_ID),
      agentRegistry: `eip155:${String(process.env.CHAIN_ID || 84532)}:${process.env.IDENTITY_REGISTRY}`,
    }];
  }
  return file;
}

app.get(["/.well-known/agent-registration.json", "/.well-known/agent-card.json"], (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(registrationFile(req));
});

// Hero verdicts, FREE. Ethereum majors at one size - the boring part of the
// market, and almost always no_edge. That is the point: an agent (or a
// human) can validate that this service tells reproducible truth before
// paying for a long-tail token. First call after a new block costs a few
// RPC round trips; cached per block after that.
app.get("/findings", async (_req, res) => {
  try {
    const client = clientFor(1);
    const blockNumber = await client.getBlockNumber();
    const size = 100000;
    const baseTok = CHAINS[1].tokens.USDC;
    const targets = Object.keys(CHAINS[1].tokens).filter((t) => t !== "USDC");

    const results = await Promise.all(
      targets.map((target) => {
        const key = `1:USDC:${target}:${size}:0:${blockNumber}`;
        const cached = cache.get(key);
        if (cached) return Promise.resolve(cached);
        return measureRoundTrip(1, {
          baseSymbol: "USDC",
          targetSymbol: target,
          size: BigInt(Math.round(size * 10 ** baseTok.decimals)),
          minNet: 0n,
        }).then((result) => {
          cachePut(key, result);
          return result;
        });
      }),
    );

    res.json({
      explanation:
        "Free showcase: Ethereum majors, $100k round trips, this block. The honest answer is normally no_edge - that is the market's fee boundary, not a failure. Arbitrary tokens and live sizes are the paid routes POST /verify and POST /safety.",
      blockNumber: Number(blockNumber),
      results: results.map((r) => ({
        target: r.target.symbol,
        verdict: r.verdict,
        grossBps: r.gross.bps,
        netBps: r.net.bps,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "verify402 - a machine-payable truth service",
      "",
      `  POST /verify   ${PRICE} per call        is this arbitrage opportunity real?`,
      `  POST /safety   ${SAFETY_PRICE} per call        is this token safe to buy? (pre-trade gate)`,
      "  GET  /findings free                 live verdicts on Ethereum majors, free",
      "  GET  /info     free                 machine-readable service description",
      "  GET  /health   free",
      "  GET  /.well-known/agent-registration.json   free   agent identity file",
      "",
      "Call a paid route with no payment to receive HTTP 402 and payment instructions.",
      "",
    ].join("\n"),
  );
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: MODE, price: PRICE, networks: NETWORKS.label });
});

app.get("/info", (_req, res) => {
  res.json({
    name: "verify402",
    description:
      "Machine-payable truth service. /verify measures whether a cross-venue arbitrage round trip is profitable; /safety is a pre-trade gate that tells an agent whether a token is safe to buy before it risks capital. All quotes come from Uniswap's canonical QuoterV2 and each venue's own router, never from our own reimplementation of venue mathematics.",
    prices: { verify: PRICE, safety: SAFETY_PRICE },
    payment: { protocol: "x402", scheme: "exact", acceptsExample: accepts(PRICE)[0] },
    chains: Object.entries(CHAINS).map(([id, c]) => ({
      chainId: Number(id),
      name: c.name,
      tokens: Object.keys(c.tokens),
      venues: [...c.v3Fees.map((f) => `uni-v3-${f / 10000}%`), ...c.v2Routers.map((r) => r.label)],
    })),
    endpoints: [
      {
        method: "POST",
        path: "/verify",
        price: PRICE,
        body: { chainId: 1, target: "WETH", base: "USDC", size: 100000 },
        response: {
          verdict: "edge | no_edge | no_edge_costs_ate_it",
          gross: "{ human, bps }",
          net: "{ human, bps }",
          costs: "{ flashLoanPremiumBps, gasUsd, ... }",
          evidence: "per-venue quotes for both legs, at the reported block",
        },
        use_when: "an agent is about to execute a specific arbitrage that someone (or something) claims is profitable",
      },
      {
        method: "POST",
        path: "/safety",
        price: SAFETY_PRICE,
        body: { chainId: 1, tokenAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", intendedUsd: 500, offeredPriceUsd: 0.00002 },
        response: {
          verdict: "TRUST | CAUTION | AVOID",
          reasons: ["why it is not TRUST"],
          notes: ["what checked out"],
          checked: ["contract", "market", "sellability", "liquidity", "price-sanity"],
          evidence: "contract facts, market data, sell-probe venues, round-trip cost, price comparison",
        },
        use_when: "an agent is about to BUY a token and needs to know it can exit and the price is real",
      },
    ],
    unpayable: "A request without payment returns HTTP 402 with instructions in the payment-required header.",
    honesty: [
      "No profit is promised. The measured answer for mainstream pairs is usually no_edge.",
      "If a response says edge, verify before acting; the service reports what it measured, not what it guarantees.",
      "Safety verdicts are measured evidence (live contract calls, actual venue quotes, market data), not a paid audit or a score from folklore.",
      "Not financial advice.",
    ],
  });
});

// ------------------------------------------------------------ paid routes ---
// Cache by (route, params, block): a measurement is deterministic given a
// block, so a second agent asking the same question in the same block gets
// the same answer for one RPC call instead of fifteen.
const cache = new Map();
const cachePut = (key, value) => {
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, value);
};

app.post("/verify", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = Number(body.chainId ?? 1);
    const base = String(body.base ?? "USDC").toUpperCase();
    const target = String(body.target ?? "").toUpperCase();
    const size = Number(body.size ?? DEFAULT_SIZE);
    const minNet = Number(body.minNet ?? 0);

    if (!target) return res.status(400).json({ error: "target is required, e.g. {\"target\":\"WETH\"}" });
    if (!CHAINS[chainId]) {
      return res.status(400).json({ error: `unsupported chainId ${chainId}`, supported: Object.keys(CHAINS).map(Number) });
    }
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: "size must be a positive number" });
    }

    const c = CHAINS[chainId];
    const baseTok = c.tokens[base];
    const targetTok = c.tokens[target];
    if (!baseTok) return res.status(400).json({ error: `unknown base ${base}`, known: Object.keys(c.tokens) });
    if (!targetTok) return res.status(400).json({ error: `unknown target ${target}`, known: Object.keys(c.tokens) });

    const blockNumber = await clientFor(chainId).getBlockNumber();
    const key = `${chainId}:${base}:${target}:${size}:${minNet}:${blockNumber}`;

    if (cache.has(key)) {
      return res.json({ ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const raw = BigInt(Math.round(size * 10 ** baseTok.decimals));
    const result = await measureRoundTrip(chainId, {
      baseSymbol: base,
      targetSymbol: target,
      size: raw,
      minNet: BigInt(Math.round(minNet * 10 ** baseTok.decimals)),
    });

    cachePut(key, result);
    res.json({
      ...result,
      cache: { hit: false, pinnedBlock: Number(blockNumber) },
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The pre-trade gate: the call an agent makes before every swap. Accepts any
// ERC-20 address, not just registry symbols, because the long tail is exactly
// where the danger lives.
app.post("/safety", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = Number(body.chainId ?? 1);
    const tokenAddress = String(body.tokenAddress ?? "").trim();
    const intendedUsd = Number(body.intendedUsd ?? 500);
    const offeredPriceUsd = body.offeredPriceUsd != null ? Number(body.offeredPriceUsd) : null;
    const baseSymbol = String(body.baseSymbol ?? "USDC").toUpperCase();

    if (!tokenAddress) {
      return res.status(400).json({ error: 'tokenAddress is required, e.g. {"tokenAddress":"0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE"}' });
    }
    if (!CHAINS[chainId]) {
      return res.status(400).json({ error: `unsupported chainId ${chainId}`, supported: Object.keys(CHAINS).map(Number) });
    }
    if (!Number.isFinite(intendedUsd) || intendedUsd <= 0) {
      return res.status(400).json({ error: "intendedUsd must be a positive number" });
    }

    // Same (route, params, block) cache key: two agents asking about the same
    // token in the same block share one set of probes.
    const blockNumber = await clientFor(chainId).getBlockNumber();
    const key = `safety:${chainId}:${tokenAddress.toLowerCase()}:${intendedUsd}:${offeredPriceUsd ?? ""}:${blockNumber}`;

    if (cache.has(key)) {
      return res.json({
        ...cache.get(key),
        cache: { hit: true, pinnedBlock: Number(blockNumber) },
        elapsedMs: Date.now() - started,
      });
    }

    const result = await preTradeCheck(chainId, {
      tokenAddress,
      intendedUsd,
      offeredPriceUsd,
      baseSymbol,
    });

    cachePut(key, result);
    res.json({
      ...result,
      cache: { hit: false, pinnedBlock: Number(blockNumber) },
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nverify402 listening on http://localhost:${PORT}`);
  console.log(`  mode        : ${MODE}  (${NETWORKS.label})`);
  console.log(`  /verify     : ${PRICE}   (is this arbitrage real?)`);
  console.log(`  /safety     : ${SAFETY_PRICE}   (is this token safe to buy?)`);
  console.log(`  pay to EVM  : ${PAY_TO_EVM}`);
  console.log(`  pay to SVM  : ${PAY_TO_SVM}`);
  console.log(`  facilitator : ${FACILITATOR_URL}`);
  console.log(`  free        : GET / , /info , /health , /.well-known/*.json\n`);
});
