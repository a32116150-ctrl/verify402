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
const accepts = [
  { scheme: "exact", price: PRICE, network: NETWORKS.evm, payTo: PAY_TO_EVM },
  { scheme: "exact", price: PRICE, network: NETWORKS.svm, payTo: PAY_TO_SVM },
];

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// Local development escape hatch. Loud on purpose: a service that believes it
// is charging when it is not is worse than one that is plainly down.
const BYPASS_PAYMENT = process.env.BYPASS_PAYMENT === "1";
if (BYPASS_PAYMENT) {
  console.warn("\n  *** BYPASS_PAYMENT=1 : /verify is UNPROTECTED. Local testing only. ***\n");
}

if (!BYPASS_PAYMENT) app.use(
  paymentMiddleware(
    {
      "POST /verify": {
        accepts,
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
    },
    new x402ResourceServer(facilitatorClient)
      .register(NETWORKS.evm, new ExactEvmScheme())
      .register(NETWORKS.svm, new ExactSvmScheme()),
  ),
);

// ------------------------------------------------------------- free routes --
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "verify402 - a machine-payable truth service",
      "",
      `  POST /verify   ${PRICE} per call   is this arbitrage opportunity real?`,
      "  GET  /info     free                machine-readable service description",
      "  GET  /health   free",
      "",
      "Call POST /verify with no payment to receive HTTP 402 and payment instructions.",
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
      "Measures whether a cross-venue arbitrage round trip is profitable at one pinned block. Quotes come from Uniswap's canonical QuoterV2 and each venue's own router, never from our own reimplementation of venue mathematics.",
    price: PRICE,
    payment: { protocol: "x402", scheme: "exact", accepts },
    chains: Object.entries(CHAINS).map(([id, c]) => ({
      chainId: Number(id),
      name: c.name,
      tokens: Object.keys(c.tokens),
      venues: [...c.v3Fees.map((f) => `uni-v3-${f / 10000}%`), ...c.v2Routers.map((r) => r.label)],
    })),
    usage: {
      method: "POST",
      path: "/verify",
      body: { chainId: 1, target: "WETH", base: "USDC", size: 100000 },
      response: {
        verdict: "edge | no_edge | no_edge_costs_ate_it",
        gross: "{ human, bps }",
        net: "{ human, bps }",
        costs: "{ flashLoanPremiumBps, gasUsd, ... }",
        evidence: "per-venue quotes for both legs, at the reported block",
      },
      unpayable: "A request without payment returns HTTP 402 with instructions in the payment-required header.",
    },
    honesty: [
      "No profit is promised. The measured answer for mainstream pairs is usually no_edge.",
      "If a response says edge, verify before acting; the service reports what it measured, not what it guarantees.",
      "Not financial advice.",
    ],
  });
});

// ------------------------------------------------------------ paid route ----
// Cache by (params, block): a measurement is deterministic given a block, so a
// second agent asking the same question in the same block gets the same answer
// for one RPC call instead of fifteen.
const cache = new Map();

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

    cache.set(key, result);
    // Keep the cache from growing without bound.
    if (cache.size > 500) cache.delete(cache.keys().next().value);

    res.json({ ...result, cache: { hit: false, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nverify402 listening on http://localhost:${PORT}`);
  console.log(`  mode        : ${MODE}  (${NETWORKS.label})`);
  console.log(`  price       : ${PRICE} per /verify call`);
  console.log(`  pay to EVM  : ${PAY_TO_EVM}`);
  console.log(`  pay to SVM  : ${PAY_TO_SVM}`);
  console.log(`  facilitator : ${FACILITATOR_URL}`);
  console.log(`  free        : GET / , /info , /health\n`);
});
