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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const LANDING_HTML = readFileSync(new URL("./landing.html", import.meta.url), "utf8");
const SITE_DIR = fileURLToPath(new URL("./site", import.meta.url));

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { measureRoundTrip, clientFor } from "./measure.mjs";
import { preTradeCheck } from "./safety.mjs";
import { fairQuoteCheck, bestRouteBook } from "./quotecheck.mjs";
import { depthProfile } from "./depth.mjs";
import { CHAINS, DEFAULT_SIZE, chain, resolveToken } from "./config.mjs";
import {
  IDEMPOTENCY_TTL_MS, IDEMPOTENCY_MAX_REPLAYS,
  recordSettlement, promoteSettlement, lookupRecovery,
  evidenceBundle, requestHash, expiredRecoveryInfo,
} from "./recovery.mjs";
import {
  preflight, verifyReceipt, PreflightError,
  PREFLIGHT_SPEC, RECEIPT_SPEC, RECEIPT_SECRET_SOURCE,
  DEFAULT_TTL_SECONDS,
} from "./preflight.mjs";
import { buildOpenapi } from "./openapi.mjs";
import { buildServiceManifest } from "./manifest.mjs";
import { recordPreflight, usageSnapshot } from "./usage.mjs";

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
// Fairness audit: cheap enough to run before every single swap.
const ROUTE_PRICE = process.env.ROUTE_PRICE || "$0.03";
const QUOTECHECK_PRICE = process.env.QUOTECHECK_PRICE || "$0.05";
// Sizing: the decision that happens BEFORE every trade after a route is known.
const DEPTH_PRICE = process.env.DEPTH_PRICE || "$0.05";

// The public x402.org facilitator is testnet-only. Mainnet needs a real one.
// Mainnet: Coinbase's CDP facilitator. createCdpFacilitatorClient() reads
// CDP_API_KEY_ID / CDP_API_KEY_SECRET from the environment itself. It is a
// *settlement service*: it never holds the money — signed payments go
// straight to the payTo addresses.
// The public x402.org facilitator is testnet-only. Mainnet options:
//   * a keyless hosted facilitator via FACILITATOR_URL — verified live:
//     PayAI (https://facilitator.payai.network) serves x402 v2 exact on
//     Base mainnet AND Solana mainnet, no account, no region lock.
//   * Coinbase CDP — used automatically when CDP_API_KEY_ID/SECRET are set
//     (region-restricted availability; kept as the upgrade path).
// The guard stands: no configured mainnet facilitator, no server.
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || (MODE === "mainnet" ? "" : "https://x402.org/facilitator");

if (MODE === "mainnet" && !FACILITATOR_URL) {
  console.error("REFUSING TO START: mainnet mode needs FACILITATOR_URL (e.g. https://facilitator.payai.network) or a CDP API key.");
  process.exit(1);
}
if (MODE === "mainnet" && process.env.FACILITATOR_URL?.includes("api.cdp.coinbase.com") && !process.env.CDP_API_KEY_ID) {
  console.error("REFUSING TO START: pointing at the CDP facilitator needs CDP_API_KEY_ID + CDP_API_KEY_SECRET (or switch FACILITATOR_URL to a keyless mainnet facilitator).");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 4021);

// ----------------------------------------------------------------- app -----
const app = express();
// We run behind a proxy (Render): without this, req.protocol reports http and
// the agent-registration file would advertise the wrong scheme.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

// Same price on both rails, so an agent can pay on whichever chain it already
// holds funds - and a Solana agent never has to bridge.
const accepts = (price) => [
  { scheme: "exact", price, network: NETWORKS.evm, payTo: PAY_TO_EVM },
  { scheme: "exact", price, network: NETWORKS.svm, payTo: PAY_TO_SVM },
];

// Testnet: the free x402.org facilitator.
// Mainnet: CDP when CDP_API_KEY_ID is present; otherwise the plain HTTP
// facilitator named by FACILITATOR_URL (e.g. PayAI, keyless). Same interface,
// zero changes downstream.
const facilitatorClient = MODE === "mainnet" && process.env.CDP_API_KEY_ID
  ? createCdpFacilitatorClient()
  : new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// Local development escape hatch. Loud on purpose: a service that believes it
// is charging when it is not is worse than one that is plainly down.
const BYPASS_PAYMENT = process.env.BYPASS_PAYMENT === "1";
if (BYPASS_PAYMENT) {
  console.warn("\n  *** BYPASS_PAYMENT=1 : paid routes are UNPROTECTED. Local testing only. ***\n");
}
if (BYPASS_PAYMENT && MODE === "mainnet") {
  console.error("REFUSING TO START: BYPASS_PAYMENT=1 is local-only and cannot be used with X402_MODE=mainnet.");
  process.exit(1);
}

// The payer an x402 payment proof names, when the rail exposes one. EVM exact
// carries it as payload.authorization.from; SVM proofs carry a transaction, so
// no stable payer string is assumed. Unknown scope is allowed to PAY, never to
// replay someone else's result.
function paymentScope(req) {
  const raw = req.get("x-payment") || req.get("payment-signature") || "";
  if (!raw) return null;
  try {
    const proof = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const from = proof?.payload?.authorization?.from;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- recovery --
// The recovery contract (see src/recovery.mjs): a caller that sends
// x-idempotency-key on its first call can replay that settled verdict —
// same bytes, no second charge — within the TTL, capped at MAX_REPLAYS.
// This middleware runs BEFORE the payment wall, which is the entire point:
// by the time paymentMiddleware inspects the request, a legitimate replay has
// already been answered.
app.use((req, res, next) => {
  const key = String(req.get("x-idempotency-key") || req.get("idempotency-key") || "").trim();
  // /preflight is free and issues its own receipt; it does not participate in
  // paid-settlement recovery, where a reused key would 409 the gate.
  if (key && req.method === "POST" && !req.path.startsWith("/.well-known") && !req.path.startsWith("/preflight")) {
    // A key is bound to one operation: the canonical request content plus the
    // payer identity the payment proof names. Reuse with different content or
    // a different payer is a conflict, rejected before payment — never a wrong
    // answer and never a free read (review: NSPG13, x402-foundation/x402#3848).
    const companion = requestHash(req.path, req.body || {});
    const scope = paymentScope(req);
    const found = lookupRecovery({
      key, companionKey: companion, requestHash: companion, scope,
    });
    if (found?.conflict) {
      res.set("Cache-Control", "no-store");
      return res.status(409).json({
        error: "recovery_conflict",
        conflict: found.conflict,
        note: found.conflict === "request_mismatch"
          ? "this idempotency key belongs to a different request; use a new key for a new operation"
          : "this idempotency key belongs to a different payment/authorization scope",
      });
    }
    if (found?.hit) {
      const hit = found.hit;
      return res.json({
        ...hit.payload,
        recovery: {
          replayed: true,
          responseHash: hit.responseHash,
          replays: hit.replays,
          ttlMinutes: IDEMPOTENCY_TTL_MS / 60000,
          maxReplays: IDEMPOTENCY_MAX_REPLAYS,
        },
      });
    }
    // Post-window typed signal: expired verdicts leave a tombstone; a retry
    // now re-measures with the paywall re-armed (no free measures), and the
    // response below will carry recovery.remeasured instead of being silent.
    req.expiredRecovery = expiredRecoveryInfo(key) || expiredRecoveryInfo(companion);
    req.idempotencyKey = key;
    req.recoveryCompanionKey = companion;
    req.recoveryScope = scope;
  }
  next();
});

// Shared exit path for the paid handlers: attach the standard evidence bundle,
// remember the settlement under the caller's idempotency key (if provided),
// then send. `core` is the handler's result; cache/elapsedMs may already be on it.
function emitPaid(req, res, core) {
  const body = req.body || {};
  const bundle = evidenceBundle({
    route: req.path,
    body,
    pinnedBlock: core?.cache?.pinnedBlock ?? core?.blockNumber ?? null,
    payload: core,
  });
  const full = { ...core, evidence_bundle: bundle };
  if (req.expiredRecovery) {
    // Typed signal (prismdeadlines): the caller can branch on this instead of
    // guessing whether it paid twice for one answer. The paywall re-armed for
    // this call; the flag makes the double charge visible, and hands back the
    // hash of the verdict they lost so the two measurements can be compared.
    full.recovery = {
      remeasured: true,
      previousResponseHash: req.expiredRecovery.previousResponseHash,
      expiredAt: req.expiredRecovery.expiredAt,
      note: "an earlier settlement of this operation existed but its replay window expired; this is a fresh measurement charged normally",
    };
  }
  if (req.idempotencyKey) {
    // STAGED, not settled: the x402 onAfterSettle hook (above) promotes this
    // record only after the settlement actually succeeds, and only for this
    // operation identity. In local bypass mode there is no settlement to wait
    // for, so the record promotes immediately (same loud warning as the
    // paywall bypass: local testing only).
    recordSettlement(req.idempotencyKey, full, req.recoveryCompanionKey || null, {
      settledNow: BYPASS_PAYMENT,
      requestHash: bundle.requestHash,
      scope: req.recoveryScope || null,
    });
  }
  res.json(full);
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
            method: "POST",
            bodyType: "json",
            input: { chainId: 1, target: "WETH", base: "USDC", size: 100000 },
            output: {
              example: {
                ok: true,
                verdict: "no_edge",
                chainId: 1,
                chainName: "ethereum",
                blockNumber: 21000000,
                base: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
                target: { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
                size: { raw: "100000000000", human: 100000 },
                buy: { venue: "uniswap-v3", kind: "v3", feeBps: 5, amountOutRaw: "30000000000000000000", amountOutHuman: 30 },
                sell: { venue: "sushiswap", kind: "v2", feeBps: 30, amountOutRaw: "99700000000", amountOutHuman: 99700 },
                gross: { raw: "-300000000", human: -300, bps: -30 },
                costs: { gasUsd: 2.4, flashLoanPremiumBps: 5, totalRaw: "1200000000" },
                net: { raw: "-1500000000", human: -1500, bps: -150 },
                method: { quoting: "V3 via Uniswap QuoterV2; V2 via router getAmountsOut", blockPinned: true, sameVenueRoundTrip: false },
                caveats: ["Measures a cross-venue round trip at one block. It is not a forecast, and it is not financial advice."],
              },
            },
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
            method: "POST",
            bodyType: "json",
            input: { chainId: 1, tokenAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", intendedUsd: 500 },
            output: {
              example: {
                ok: true,
                verdict: "TRUST",
                token: { input: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", chainId: 1, chainName: "ethereum" },
                reasons: [],
                notes: ["liquidity and a USD-sized sell probe both cleared"],
                checked: ["contract", "market", "sellability", "liquidity"],
                evidence: { canSell: true, probedInUsd: 500, venuesThatQuote: ["uniswap-v3", "sushiswap"] },
              },
            },
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
      "POST /route": {
        accepts: accepts(ROUTE_PRICE),
        description:
          "The full execution book right now: every venue (direct and WETH-routed) quoting tokenIn -> tokenOut at one pinned block, best first. Verdict-free evidence; pair it with /quotecheck to audit someone else's number.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            method: "POST",
            bodyType: "json",
            input: { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000000" },
            output: {
              example: {
                ok: true,
                chainId: 1,
                chainName: "ethereum",
                blockNumber: 21000000,
                amountIn: "1000000000",
                best: { venue: "uniswap-v3", kind: "v3", amountOut: "326259300000000000" },
                book: [
                  { venue: "uniswap-v3", kind: "v3", amountOut: "326259300000000000" },
                  { venue: "sushiswap", kind: "v2", amountOut: "325001000000000000" },
                ],
                unavailable: ["pancakeswap-v2"],
                note: null,
              },
            },
            inputSchema: {
              properties: {
                chainId: { type: "integer", description: "1 Ethereum, 42161 Arbitrum, 8453 Base" },
                tokenIn: { type: "string", description: "Token symbol or 0x address" },
                tokenOut: { type: "string", description: "Token symbol or 0x address" },
                amountIn: { type: "string", description: "Amount in RAW base units of tokenIn (wei-scale)" },
              },
              required: ["tokenIn", "tokenOut", "amountIn"],
            },
          }),
        },
      },
      "POST /depth": {
        accepts: accepts(DEPTH_PRICE),
        description:
          "Position sizing as a service. For a ladder of USD sizes, measure what the chain ACTUALLY pays: entry via the best route, immediate exit of the exact position, per-size impact %, round-trip cost %, and the largest size that stays under your cost tolerance. This is what pool-reserve-dollar figures cannot tell you: what a real block gives you for YOUR size.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            method: "POST",
            bodyType: "json",
            input: { chainId: 1, tokenAddress: "WETH", baseSymbol: "USDC", sizesUsd: [100, 1000, 10000, 100000] },
            output: {
              example: {
                ok: true,
                token: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", base: "USDC", chainId: 1 },
                blockNumber: 21000000,
                maxRoundTripPct: 1,
                capacityUsd: 10000,
                ladder: [
                  { sizeUsd: 100, fillable: true, buyVenue: "uniswap-v3", sellVenue: "uniswap-v3", gotTokens: 0.03, impliedPriceUsd: 3300.12, impactPct: 0.01, roundTripCostPct: 0.12, underTolerance: true },
                  { sizeUsd: 10000, fillable: true, buyVenue: "uniswap-v3", sellVenue: "sushiswap", gotTokens: 3.02, impliedPriceUsd: 3310.4, impactPct: 0.3, roundTripCostPct: 0.9, underTolerance: true },
                  { sizeUsd: 100000, fillable: false, buyVenue: null, sellVenue: null, gotTokens: null, impliedPriceUsd: null, impactPct: null, roundTripCostPct: null, underTolerance: false },
                ],
                checked: ["target token facts", "dexscreener liquidity", "entry via best route", "immediate exit of the exact position"],
                notes: ["largest size with round-trip cost <= 1%: $10,000"],
              },
            },
            inputSchema: {
              properties: {
                chainId: { type: "integer", description: "1 Ethereum, 42161 Arbitrum, 8453 Base" },
                tokenAddress: { type: "string", description: "Target token symbol or 0x address (the thing you plan to buy)" },
                baseSymbol: { type: "string", description: "What you pay with, default USDC" },
                sizesUsd: { type: "array", description: "Ladder of sizes in USD, max 6, each <= 1,000,000", items: { type: "number" } },
                maxRoundTripPct: { type: "number", description: "Your cost tolerance, default 1%" },
              },
              required: ["tokenAddress"],
            },
          }),
        },
      },
      "POST /quotecheck": {
        accepts: accepts(QUOTECHECK_PRICE),
        description:
          "Fairness audit of a quote someone else gave you. Returns fair / overpaying / too_good_to_be_true / unknown, with the full venue book at one pinned block as evidence. Ask this BEFORE signing any swap whose number you did not produce yourself.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            method: "POST",
            bodyType: "json",
            input: {
              chainId: 1, tokenIn: "USDC", tokenOut: "WETH",
              amountIn: "1000000000",
              quotedOut: "326259300000000000",
              venueClaimed: "some-router.example",
            },
            output: {
              example: {
                ok: true,
                verdict: "fair",
                offered: { quotedOut: "326259300000000000", claimedVenue: "some-router.example", claimedChain: null },
                blockNumber: 21000000,
                amountIn: "1000000000",
                book: [{ venue: "uniswap-v3", kind: "v3", amountOut: "326259300000000000" }],
                unavailable: [],
                evidence: { chainBest: { venue: "uniswap-v3", amountOut: "326259300000000000" }, ratioVsChainBest: 1.0 },
                checked: ["parsed offer", "quoted the book at the pinned block", "compared offer to chain best"],
                notes: ["the offer is inside the noise band of what the chain pays right now"],
              },
            },
            inputSchema: {
              properties: {
                chainId: { type: "integer", description: "1 Ethereum, 42161 Arbitrum, 8453 Base" },
                tokenIn: { type: "string", description: "Token symbol or 0x address" },
                tokenOut: { type: "string", description: "Token symbol or 0x address" },
                amountIn: { type: "string", description: "RAW units of tokenIn (wei-scale)" },
                quotedOut: { type: "string", description: "The RAW units of tokenOut you were offered" },
                venueClaimed: { type: "string", description: "Optional: who gave you this quote" },
              },
              required: ["tokenIn", "tokenOut", "amountIn", "quotedOut"],
            },
          }),
        },
      },
    },
    new x402ResourceServer(facilitatorClient)
      .register(NETWORKS.evm, new ExactEvmScheme())
      .register(NETWORKS.svm, new ExactSvmScheme())
      .onAfterSettle(async (ctx) => {
        // THE settlement gate for recovery: a staged verdict only becomes
        // replayable here — after the facilitator confirms THIS settle, for the
        // staged operation named in the response body, with the response bytes
        // as an additional check. Failed/pending settle promotes nothing.
        // Matching by bytes alone is not enough: two operations may return
        // identical output, and settling one must not promote the other.
        if (ctx?.phase !== "after-handler") return;
        try {
          promoteSettlement(ctx?.transportContext?.responseBody ?? null, {
            ok: ctx?.result?.success === true,
            transaction: ctx?.result?.transaction ?? null,
            network: ctx?.result?.network ?? null,
            payer: ctx?.result?.payer ?? ctx?.paymentPayload?.payload?.authorization?.from ?? null,
          });
        } catch (e) {
          console.error("[recovery] promotion failed:", e && e.message);
        }
      }),
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
      "Machine-payable truth service for AI agents. POST /preflight is the free pre-signing " +
      "gate: validate an x402 payment request or a chain transaction and get PASS / CAUTION / " +
      "BLOCK with a short-lived receipt bound to the exact intent. POST /verify measures whether a claimed " +
      "cross-venue arbitrage is real (pinned-block quotes from Uniswap QuoterV2 and each " +
      "router's own math; the honest answer is usually no_edge). POST /safety is a pre-trade " +
      "gate: contract facts, market liquidity and scam signals, a USD-sized sell probe across " +
      "every venue, round-trip cost at the intended size, and phantom-price detection. " +
      "TRUST / CAUTION / AVOID with evidence. Per-call x402 payment, USDC on Base or Solana. " +
      "An MCP server (verify402-mcp, stdio) exposes the free gate and all five checks to any " +
      "MCP client; install at /mcp. No profitability is ever promised; the service reports what it measured.",
    image: `${base}/agent-icon.svg`,
    services: [
      { name: "web", endpoint: base },
      { name: "x402", endpoint: `${base}/verify`, version: "x402" },
      { name: "x402", endpoint: `${base}/safety`, version: "x402" },
      { name: "x402", endpoint: `${base}/route`, version: "x402" },
      { name: "x402", endpoint: `${base}/quotecheck`, version: "x402" },
      { name: "x402", endpoint: `${base}/depth`, version: "x402" },
    ],
    x402Support: true,
    active: true,
    supportedTrust: ["reputation"],
    url: base,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    capabilities: { transports: ["http"], x402: { supported: true, network: "base", asset: "USDC" } },
    skills: [
      { id: "preflight", name: "preflight", description: "Free pre-signing gate for any x402 payment request or chain transaction: PASS / CAUTION / BLOCK, typed reasons, checked/notChecked, and a short-lived receipt bound to the exact intent and a fresh pinned block. Call before signing." },
      { id: "verify", name: "verify", description: "Cross-venue arbitrage truth check: pinned-block quotes from both sides, three-state verdict (edge / no_edge / no_edge_costs_ate_it), evidence included." },
      { id: "safety", name: "safety", description: "Pre-trade gate: contract facts, market liquidity, scam signals, a USD-sized sell probe, round-trip cost at the intended size, TRUST / CAUTION / AVOID with evidence." },
      { id: "route", name: "route", description: "What the chain would actually pay for a swap: best route plus every quoted venue at a USD size." },
      { id: "quotecheck", name: "quotecheck", description: "Audit a quote someone else gave you: fair / overpaying / too_good_to_be_true, re-measured at a pinned block." },
      { id: "depth", name: "depth", description: "Position sizing: how big can I trade before the round trip eats me? Capacity ladder across sizes." },
    ],
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

// 402 Index domain-ownership proof. The value is the public SHA-256 hash of a
// private claim token, by design; publishing it lets us edit our own 402 Index
// listings. The token itself stays in ~/.config/verify402/ (mode 600).
app.get("/.well-known/402index-verify.txt", (_req, res) => {
  res.type("text/plain").send("83f1c578d78d2b9645a4640bcc77939bdfbae84a86b7798d4d753e18085f3b14");
});

// Browsers and discovery crawlers both ask for /favicon.ico before anything
// else. Serve the PNG mark at that exact path.
app.get("/favicon.ico", (_req, res) => {
  res.type("image/png");
  res.sendFile(`${SITE_DIR}/favicon.png`);
});

// Crawler policy. Any agent is welcome; the service is public and free to read.
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send(
    [
      "User-agent: *",
      "Allow: /",
      "",
      "User-agent: GPTBot",
      "Allow: /",
      "",
      "User-agent: ClaudeBot",
      "Allow: /",
      "",
      "User-agent: PerplexityBot",
      "Allow: /",
      "",
      "Sitemap: https://verify402.onrender.com/sitemap.xml",
      "# Machine-readable discovery contracts:",
      "# Canonical service manifest: /.well-known/verify402.json",
      "# Plain-text contract: /llms.txt",
      "# OpenAPI specification: /openapi.json",
      "# x402 capability discovery: /.well-known/x402",
      "",
    ].join("\n"),
  );
});

// XML sitemap of all public documentation and landing pages for web crawlers.
app.get("/sitemap.xml", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://verify402.onrender.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://verify402.onrender.com/start</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://verify402.onrender.com/docs</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://verify402.onrender.com/mcp</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://verify402.onrender.com/preflight</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>https://verify402.onrender.com/checks</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>https://verify402.onrender.com/proof</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>https://verify402.onrender.com/live</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>https://verify402.onrender.com/donate</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
</urlset>`
  );
});

// llms.txt: the service contract in plain text, for LLM agents that read a
// site before calling it. Every price here is also in the live 402 challenge,
// which stays authoritative; this file is a map, not a quote.
app.get("/llms.txt", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.type("text/plain").send(
    [
      "# verify402",
      "",
      "> Per-call truth checks for trading agents. Free pre-signing gate plus",
      "> paid, evidence-backed verdicts: is this arbitrage real, is this token",
      "> safe, is this quote fair, and how much can my size move.",
      "",
      "Live: https://verify402.onrender.com",
      "Quickstart: https://verify402.onrender.com/start",
      "Interactive Docs: https://verify402.onrender.com/docs",
      "MCP Information: https://verify402.onrender.com/mcp",
      "Code: https://github.com/a32116150-ctrl/verify402",
      "",
      "## Free, no key, no wallet",
      "",
      "- POST /preflight — PASS / CAUTION / BLOCK for a payment or a chain",
      "  transaction, with typed reasons, the checks that ran, the checks that",
      "  did not, and a short-lived HMAC receipt (90s default).",
      "- POST /preflight/verify — recompute a receipt. Tampered or expired",
      "  receipts return valid: false.",
      "- GET /findings — free published verdicts.",
      "- GET /health — liveness and network configuration.",
      "- GET /info — JSON capabilities and pricing.",
      "",
      "## Paid, x402 exact, USDC on Base mainnet or Solana",
      "",
      "Each paid call returns a verdict with reproducible evidence and an",
      "evidence_bundle (requestHash, responseHash, pinnedBlock). The 402",
      "challenge is authoritative for price and payee.",
      "",
      "- POST /verify — 0.05 USDC. Is this cross-venue arbitrage real at one",
      "  pinned block? Most common honest answer: no_edge.",
      "- POST /safety — 0.10 USDC. Token gate: TRUST / CAUTION / AVOID, with a",
      "  USD-sized sell probe against every venue.",
      "- POST /route — 0.03 USDC. Every venue quoting tokenIn to tokenOut at",
      "  one pinned block, best first.",
      "- POST /quotecheck — 0.05 USDC. Audit someone else's quote: fair /",
      "  overpaying / too_good_to_be_true / unknown.",
      "- POST /depth — 0.05 USDC. Largest size that still clears your cost",
      "  tolerance; capacityUsd.",
      "",
      "## Machine-readable Manifests & Discovery",
      "",
      "- /.well-known/verify402.json — Canonical machine-readable service manifest.",
      "- /openapi.json — OpenAPI 3.1 contract with x-payment-info on every paid route.",
      "- /.well-known/x402 — x402 capability manifest (draft-hawkins-x402-dns-discovery-02).",
      "- /.well-known/agent-card.json — A2A agent card (ERC-8004).",
      "- /sitemap.xml — XML sitemap for public documentation indexers.",
      "- MCP bridge package: verify402-mcp (stdio transport)",
      "  Install: npx -y verify402-mcp",
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
    ].join("\n"),
  );
});

// Canonical machine-readable service manifest for agent discovery systems.
app.get("/.well-known/verify402.json", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "public, max-age=300");
  res.json(
    buildServiceManifest({
      baseUrl: "https://verify402.onrender.com",
      mode: MODE,
      prices: {
        verify: PRICE,
        safety: SAFETY_PRICE,
        route: ROUTE_PRICE,
        quotecheck: QUOTECHECK_PRICE,
        depth: DEPTH_PRICE,
      },
      payTo: {
        evm: PAY_TO_EVM,
        svm: PAY_TO_SVM,
      },
    })
  );
});

// OpenAPI contract for x402scan and any agent that reads a spec before paying.
// Prices are injected from the same strings the 402 middleware uses, so the
// metadata and the runtime challenge cannot drift apart.
app.get("/openapi.json", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "public, max-age=300");
  res.json(buildOpenapi({
    verify: PRICE,
    safety: SAFETY_PRICE,
    route: ROUTE_PRICE,
    quotecheck: QUOTECHECK_PRICE,
    depth: DEPTH_PRICE,
  }));
});

// x402 capability manifest, per draft-hawkins-x402-dns-discovery-02.
// A bare-domain crawler gets the full paid surface in one GET; each resource
// entry is a pointer, so the 402 challenge (not this file) stays authoritative
// for price and terms. Free resources are deliberately excluded.
app.get("/.well-known/x402", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    x402Version: 2,
    kind: "resource-server",
    name: "verify402",
    description:
      "Per-call truth checks for trading agents: arbitrage reality, token safety, execution book, quote fairness, and trade capacity. Free preflight gate; paid verdicts return reproducible evidence, not profit promises.",
    resources: [
      {
        url: "https://verify402.onrender.com/verify",
        method: "POST",
        description:
          "Is this cross-venue arbitrage real at one pinned block? Returns a verdict with full evidence; the most common honest answer is no_edge.",
      },
      {
        url: "https://verify402.onrender.com/safety",
        method: "POST",
        description:
          "Pre-trade token gate: TRUST / CAUTION / AVOID, with live contract facts and a USD-sized sell probe against every venue.",
      },
      {
        url: "https://verify402.onrender.com/route",
        method: "POST",
        description:
          "Every venue quoting tokenIn to tokenOut at one pinned block, direct and WETH-routed, best first.",
      },
      {
        url: "https://verify402.onrender.com/quotecheck",
        method: "POST",
        description:
          "Audit a quote someone else gave you: fair / overpaying / too_good_to_be_true / unknown, with the venue book as evidence.",
      },
      {
        url: "https://verify402.onrender.com/depth",
        method: "POST",
        description:
          "Largest size that still clears your cost tolerance: per-size entry and exit quotes, impact, round-trip cost, and capacityUsd.",
      },
    ],
    attestation: { type: "none" },
    docs: "https://verify402.onrender.com/start",
    contact: "a32116150@gmail.com",
    updated: "2026-10-19T00:00:00Z",
  });
});

// Hero verdicts, FREE. Ethereum majors at one size - the boring part of the
// market, and almost always no_edge. That is the point: an agent (or a
// human) can validate that this service tells reproducible truth before
// paying for a long-tail token.
//
// The first version recomputed every pair on every new block. That is correct
// and unusable: on a public RPC a full set can take 90-160 seconds, so the
// free "live" page - the one thing meant to earn trust - sat at "loading".
// The showcase does not need a fresh block for every visitor. It needs an
// honest snapshot, a timestamp, and a bound on how long a slow pair may hold
// the answer. So: one snapshot, served while a refresh runs in the background,
// measurements limited to two in flight (a burst of four gets throttled by
// public RPCs), each success cached for five minutes, and a hard per-pair
// budget that reports `unavailable` instead of hanging.
const FINDINGS_TTL_MS = 120_000;
const FINDINGS_PAIR_BUDGET_MS = 26_000;
const FINDINGS_PAIR_TTL_MS = 5 * 60_000;
const FINDINGS_CONCURRENCY = 2;
const findingsPairs = new Map(); // target -> { at, row }
let findingsSnap = null; // { payload, at }
let findingsRefresh = null;
let findingsFill = null;

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: no quote within ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);

// Small pool: enough concurrency to be quick, little enough not to trip the
// public RPC's rate limiter. Kept local so the endpoint has no new dependency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function measureFindingPair(target) {
  const hit = findingsPairs.get(target);
  if (hit && Date.now() - hit.at < FINDINGS_PAIR_TTL_MS) return hit.row;
  const baseTok = CHAINS[1].tokens.USDC;
  try {
    const r = await withTimeout(
      measureRoundTrip(1, {
        baseSymbol: "USDC",
        targetSymbol: target,
        size: BigInt(Math.round(100000 * 10 ** baseTok.decimals)),
        minNet: 0n,
      }),
      FINDINGS_PAIR_BUDGET_MS,
      target,
    );
    if (!r.ok) {
      return { target, verdict: "unavailable", reason: r.reason, blockNumber: r.blockNumber ?? null };
    }
    const row = {
      target: r.target.symbol,
      verdict: r.verdict,
      grossBps: r.gross.bps,
      netBps: r.net.bps,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash ?? null,
      // Reproducible inputs: everything needed to re-derive the two numbers above
      // from the same pinned block with a public RPC (feedback: clearreason_assistant,
      // Moltbook). Without these the row was a claim, not a receipt.
      inputs: {
        size: { raw: r.size.raw, human: r.size.human, symbol: r.base.symbol },
        minNetBps: 0,
        buy: { venue: r.buy.venue, kind: r.buy.kind, feeBps: r.buy.feeBps },
        sell: { venue: r.sell.venue, kind: r.sell.kind, feeBps: r.sell.feeBps },
        gas: {
          units: r.costs.gasUnits,
          priceGwei: r.costs.gasPriceGwei,
          tokenUsd: r.costs.gasTokenUsd,
          usd: r.costs.gasUsd,
        },
        flashLoanPremiumBps: r.costs.flashLoanPremiumBps,
      },
      method:
        "exact-input quote at the pinned block: buy then sell through the named venue routers, net = gross - gasUsd - flashLoanPremium. Re-quote both legs at blockNumber with any RPC to re-derive grossBps/netBps.",
    };
    findingsPairs.set(target, { at: Date.now(), row });
    return row;
  } catch (e) {
    return { target, verdict: "unavailable", reason: e.message, blockNumber: null };
  }
}

async function computeFindings() {
  const targets = Object.keys(CHAINS[1].tokens).filter((t) => t !== "USDC");
  const results = await mapLimit(targets, FINDINGS_CONCURRENCY, measureFindingPair);

  const blocks = results.map((r) => r.blockNumber).filter((n) => Number.isFinite(n));
  let blockNumber = blocks.length ? Math.max(...blocks) : null;
  if (blockNumber == null) {
    try { blockNumber = Number(await clientFor(1).getBlockNumber()); } catch { /* reported as null */ }
  }

  return {
    explanation:
      "Free showcase: Ethereum majors, $100k round trips, each pair pinned to the latest block it was measured at. Every row carries its own reproducible inputs (size, buy/sell venue + fee tier, gas at the pinned block, flash-loan premium) so the two bps numbers can be re-derived by anyone with an RPC. The honest answer is normally no_edge - that is the market's fee boundary, not a failure. Arbitrary tokens and live sizes are the paid routes POST /verify and POST /safety.",
    blockNumber,
    measuredAt: new Date().toISOString(),
    results,
  };
}

// A pair that timed out is retried once, alone, after the snapshot is already
// being served. The result is a complete snapshot within a minute or so without
// ever making a visitor wait for the retry.
function fillMissingFindings() {
  if (findingsFill) return;
  const missing = (findingsSnap?.payload.results || [])
    .filter((r) => r.verdict === "unavailable")
    .map((r) => r.target);
  if (!missing.length) return;
  findingsFill = new Promise((resolve) => setTimeout(resolve, 4000))
    .then(async () => {
      for (const target of missing) {
        findingsPairs.delete(target);
        await measureFindingPair(target);
      }
      const payload = await computeFindings();
      findingsSnap = { payload, at: Date.now() };
    })
    .catch((e) => console.warn("findings retry failed:", e.message))
    .finally(() => { findingsFill = null; });
}

function refreshFindings() {
  if (!findingsRefresh) {
    findingsRefresh = computeFindings()
      .then((payload) => {
        findingsSnap = { payload, at: Date.now() };
        fillMissingFindings();
        return payload;
      })
      .finally(() => { findingsRefresh = null; });
  }
  return findingsRefresh;
}

const findingsAge = () => Math.round((Date.now() - findingsSnap.at) / 1000);

app.get("/findings", async (_req, res) => {
  if (findingsSnap && Date.now() - findingsSnap.at < FINDINGS_TTL_MS) {
    res.set("Cache-Control", "public, max-age=30");
    return res.json({ ...findingsSnap.payload, ageSeconds: findingsAge() });
  }
  if (findingsSnap) {
    // Stale-while-revalidate: the visitor gets the last honest snapshot now,
    // clearly marked with its age, while a fresh one is measured behind it.
    refreshFindings().catch(() => {});
    res.set("Cache-Control", "no-store");
    return res.json({ ...findingsSnap.payload, stale: true, ageSeconds: findingsAge() });
  }
  try {
    // Cold: bounded by the per-pair budget, so this cannot hang for minutes.
    const payload = await refreshFindings();
    res.set("Cache-Control", "public, max-age=30");
    return res.json({ ...payload, ageSeconds: 0 });
  } catch (e) {
    res.status(503).json({ error: e.message, hint: "The measurement pass failed; retry in a few seconds." });
  }
});

// ---------------------------------------------------------- preflight gate --
// The pre-signing check. FREE on purpose: a control that an agent must run
// before every signature is infrastructure, not a toll booth. The deep
// measurements (/verify, /safety, /depth) stay paid. Free still costs RPC, so
// the gate is rate-limited per IP and capped in flight; otherwise a free
// endpoint becomes a public proxy for the chain.
const PREFLIGHT_RATE_PER_MIN = 60;
const PREFLIGHT_MAX_IN_FLIGHT = 8;
const preflightBuckets = new Map();
let preflightBucketsSweptAt = 0;
let preflightInFlight = 0;

function preflightRateLimit(req, res, next) {
  // trust proxy=1 makes req.ip the rightmost untrusted hop (the client address
  // appended by Render), not a client-supplied leftmost X-Forwarded-For value.
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = preflightBuckets.get(ip);
  if (!bucket || now - bucket.at >= 60_000) {
    preflightBuckets.set(ip, { at: now, n: 1 });
  } else {
    bucket.n += 1;
    if (bucket.n > PREFLIGHT_RATE_PER_MIN) {
      res.set("Retry-After", "60");
      return res.status(429).json({
        error: "rate_limited",
        message: `max ${PREFLIGHT_RATE_PER_MIN} preflight calls per minute per IP`,
      });
    }
  }
  if (now - preflightBucketsSweptAt >= 60_000) {
    preflightBucketsSweptAt = now;
    for (const [k, v] of preflightBuckets) if (now - v.at > 120_000) preflightBuckets.delete(k);
  }
  next();
}

function preflightConcurrency(req, res, next) {
  if (preflightInFlight >= PREFLIGHT_MAX_IN_FLIGHT) {
    res.set("Retry-After", "2");
    return res.status(429).json({ error: "busy", message: "too many concurrent preflights; retry shortly" });
  }
  preflightInFlight += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    preflightInFlight -= 1;
  };
  res.on("finish", release);
  res.on("close", release);
  next();
}

app.post("/preflight", preflightRateLimit, preflightConcurrency, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const started = Date.now();
  try {
    const result = await preflight(req.body || {});
    const ms = Date.now() - started;
    recordPreflight({ req, result, status: 200, ms });
    res.json({ ...result, elapsedMs: ms });
  } catch (e) {
    const ms = Date.now() - started;
    if (e instanceof PreflightError) {
      recordPreflight({ req, result: null, status: e.status, ms, code: e.code });
      return res.status(e.status).json({ error: e.code, message: e.message });
    }
    recordPreflight({ req, result: null, status: 503, ms, code: "preflight_unavailable" });
    console.error("[preflight]", e);
    // Fail closed: no receipt means an executor must refuse to sign. A 200
    // with a guessed verdict would be the one failure mode this gate exists
    // to prevent.
    res.status(503).json({
      error: "preflight_unavailable",
      message: "the chain could not be read, so no receipt was issued; the gate must fail closed",
      detail: e.message,
    });
  }
});

// Anonymous, process-local free-gate counts. This is a call counter, not an
// identity system; see src/usage.mjs for the boundary.
app.get("/usage", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(usageSnapshot());
});

app.post("/preflight/verify", preflightRateLimit, (req, res) => {
  res.set("Cache-Control", "no-store");
  const receipt = req.body?.receipt ?? req.body;
  res.json(verifyReceipt(receipt));
});

// Static pages for humans: /start, /checks, /live, /proof, /docs, /donate (+ /assets).
// Clean URLs via the html extension; HTML is no-store so edits go live at once.
app.use(express.static(SITE_DIR, {
  index: false,
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
    else res.setHeader("Cache-Control", "public, max-age=300");
  },
}));


app.get("/", (req, res) => {
  // Humans and search/verification crawlers get the landing page; machine clients keep the plain menu.
  const accept = String(req.headers.accept || "");
  const ua = String(req.headers["user-agent"] || "");
  const isCrawler = /google|bot|crawler|spider|slurp|facebookexternalhit|bingbot|yandex|duckduckbot/i.test(ua);
  const wantsHtml = accept.includes("text/html") || isCrawler;
  if (wantsHtml) {
    res.set("Cache-Control", "no-store");
    return res.type("text/html").send(LANDING_HTML);
  }
  res.type("text/plain").send(
    [
      "verify402 - a machine-payable truth service",
      "",
      "  POST /preflight free               should I sign this payment or transaction? (gate)",
      "  POST /preflight/verify free        verify a preflight receipt (HMAC + expiry)",
      `  POST /verify   ${PRICE} per call        is this arbitrage opportunity real?`,
      `  POST /safety   ${SAFETY_PRICE} per call        is this token safe to buy? (pre-trade gate)`,
      `  POST /route    ${ROUTE_PRICE} per call        what would the chain actually pay for this swap?`,
      `  POST /quotecheck ${QUOTECHECK_PRICE} per call      audit a quote someone else gave you`,
      `  POST /depth    ${DEPTH_PRICE} per call        how big can I trade before cost eats me?`,
      "  GET  /findings free                 live verdicts on Ethereum majors, free",
      "  GET  /usage    free                 anonymous free-gate call counts (process-local)",
      "  GET  /mcp      free                 MCP server: free gate + five paid tools",
      "  GET  /start    free                 five-minute quickstart for developers (human page)",
      "  GET  /info     free                 machine-readable service description",
      "  GET  /health   free",
      "  GET  /.well-known/agent-registration.json   free   agent identity file",
      "",
      "Call a paid route with no payment to receive HTTP 402 and payment instructions.",
      "Preflight is free and fail-closed: if the chain cannot be read, it returns 503 and no receipt.",
      "Send x-idempotency-key on the first call: within 10 min a retry of a paid call",
      "replays the SAME verdict with no second charge (3 replays max).",
      "Every paid response carries an evidence_bundle (requestHash/responseHash/pinnedBlock).",
      "",
    ].join("\n"),
  );
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: MODE, price: PRICE, preflight: "free", networks: NETWORKS.label });
});

app.get("/info", (_req, res) => {
  res.json({
    name: "verify402",
    description:
      "Machine-payable truth service. /preflight is the free pre-signing gate: validate an x402 payment request or a chain transaction and get PASS / CAUTION / BLOCK with typed reasons and a short-lived receipt. /verify measures whether a cross-venue arbitrage round trip is profitable; /safety is a pre-trade gate that tells an agent whether a token is safe to buy before it risks capital. All quotes come from Uniswap's canonical QuoterV2 and each venue's own router, never from our own reimplementation of venue mathematics. The MCP server (verify402-mcp) exposes the gate and the five checks as native tools; install at /mcp.",
    prices: {
      preflight: "free",
      preflight_verify: "free",
      verify: PRICE,
      safety: SAFETY_PRICE,
      route: ROUTE_PRICE,
      quotecheck: QUOTECHECK_PRICE,
      depth: DEPTH_PRICE,
    },
    usage: {
      path: "/usage",
      price: "free",
      scope: "this process instance; resets on restart or deploy",
      note: "Anonymous free-gate call counts. Not a unique-agent count; paid settlements are the identity-backed signal.",
    },
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
        path: "/preflight",
        price: "free",
        body: {
          kind: "payment",
          payment: {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "10000",
            payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
            resource: "https://verify402.onrender.com/verify",
            maxTimeoutSeconds: 60,
          },
          from: "0x...",
          policy: { maxAmountUsd: 0.25, allowedPayTo: ["0x..."] },
        },
        response: {
          verdict: "PASS | CAUTION | BLOCK",
          reasons: "[{ code, severity, message }]",
          checked: "[what was actually checked]",
          notChecked: "[what was deliberately not checked]",
          receipt: "{ spec, id, verdict, intentHash, blockNumber, blockHash, issuedAt, expiresAt, signature }",
        },
        use_when: "an agent is about to sign ANY x402 payment request or chain transaction; free and fail-closed",
      },
      {
        method: "POST",
        path: "/preflight/verify",
        price: "free",
        body: { receipt: "{...the receipt returned by /preflight...}" },
        response: { valid: "boolean", reason: "null | missing_receipt | unknown_spec | missing_signature | bad_signature | bad_expiry | expired" },
        use_when: "an executor verifies a preflight receipt before allowing a signature",
      },
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
      {
        method: "POST",
        path: "/route",
        price: ROUTE_PRICE,
        body: { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000000" },
        response: {
          best: "{ venue, kind, amountOut(raw) } | null",
          book: "every venue (direct + WETH-routed), best first, one pinned block",
          unavailable: ["venues that could not quote the size"],
        },
        use_when: "an agent wants the chain's own answer for what a swap should pay, before trusting any counterparty's number",
      },
      {
        method: "POST",
        path: "/quotecheck",
        price: QUOTECHECK_PRICE,
        body: { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000000", quotedOut: "326259300000000000", venueClaimed: "who-gave-you-this" },
        response: {
          verdict: "fair | overpaying | too_good_to_be_true | unknown",
          notes: ["why"],
          evidence: "offered quote, chain best, full venue book, ratio, shortfallBps",
        },
        use_when: "an agent was OFFERED a quote by a broker/aggregator/bot and is about to sign it",
      },
      {
        method: "POST",
        path: "/depth",
        price: DEPTH_PRICE,
        body: { chainId: 1, tokenAddress: "WETH", baseSymbol: "USDC", sizesUsd: [100, 1000, 10000, 100000], maxRoundTripPct: 1 },
        response: {
          capacityUsd: "largest rung with round-trip cost <= maxRoundTripPct",
          ladder: "per size: impactPct, roundTripCostPct, buyVenue, sellVenue, impliedPriceUsd",
          notes: ["the honest caveats, block-pinned"],
        },
        use_when: "an agent is ABOUT TO CHOOSE A SIZE and needs to know what the pool will really give it",
      },
    ],
    unpayable: "A request without payment returns HTTP 402 with instructions in the payment-required header.",
    preflight: {
      spec: PREFLIGHT_SPEC,
      receiptSpec: RECEIPT_SPEC,
      price: "free",
      defaultTtlSeconds: DEFAULT_TTL_SECONDS,
      limits: { perMinutePerIp: PREFLIGHT_RATE_PER_MIN, maxInFlight: PREFLIGHT_MAX_IN_FLIGHT },
      intents: ["payment", "transaction"],
      paymentNetworks: "EVM (1, 42161, 8453, 84532, 11155111) + Solana mainnet/devnet",
      transactionChains: Object.keys(CHAINS).map(Number),
      verdicts: {
        PASS: "every check in `checked` passed at this fresh pinned block",
        CAUTION: "at least one check needs a decision; read `reasons`",
        BLOCK: "at least one hard check failed; do not sign",
      },
      blockFreshness: {
        cautionAfterSeconds: 30,
        blockAfterSeconds: 120,
        noTimestamp: "503, no receipt",
        note: "EVM only; the response carries block.timestamp and block.ageSeconds",
      },
      binding: "sha256 of the canonical normalized intent, a fresh pinned block where the chain is readable, and an expiry (default 90s, max 300s)",
      failClosed: "if the chain cannot be read, /preflight returns 503 and issues no receipt; an executor should refuse to sign without a verifiable PASS or an explicitly acknowledged CAUTION",
      receiptSigning: RECEIPT_SECRET_SOURCE === "env"
        ? "hmac-sha256 with PREFLIGHT_SECRET"
        : "hmac-sha256 with an ephemeral per-process secret; set PREFLIGHT_SECRET for multi-instance verification",
      verify: "POST /preflight/verify",
      mcpTool: "preflight_gate",
      doesNotCheck: [
        "recipient reputation",
        "sanctions screening",
        "contract audits",
        "balance-delta simulation",
        "MEV/sandwich protection",
        "payment signature / signed payload",
        "gas price/limit chosen by the signer",
        "raw signed-transaction binding",
        "facilitator settlement",
      ],
      note: "A PASS is not a guarantee. It means the listed checks passed at this block; `notChecked` lists what was not examined.",
    },
    mcp: {
      package: "verify402-mcp",
      version: "1.0.2",
      license: "Apache-2.0",
      transport: "stdio",
      install: "https://verify402.onrender.com/mcp",
      freeTool: "preflight_gate",
      paidTools: ["verify_arbitrage", "check_token_safety", "get_best_route", "verify_quote_fairness", "get_trade_depth"],
      freeOnlyWithoutWallet: true,
      note: "Start with no EVM_PRIVATE_KEY to expose only the free gate. Paid tools use a dedicated hot wallet, cap each payment at MAX_PAYMENT_USD, and only pay an allowlisted network/payee. The bridge signs x402 payments only, never a trade.",
    },
    recovery: {
      header: "x-idempotency-key",
      behavior: "Send this header on the FIRST call of an operation. If the response is lost after settlement, retrying with the same header returns the SAME verdict within the TTL without requiring payment again. Records are promoted to replayable ONLY after your settlement is confirmed by the facilitator: a failed or pending settlement leaves no free replay (fail-closed).",
      ttlMinutes: 10,
      maxReplays: 3,
      maxReplaysNote: "the cap is per operation, shared between the caller key and the content-hash companion key",
      doubleKeying: "verdicts are also recorded under a hash of the canonical request content, so a retry that mints a fresh id still replays free within the window",
      afterWindow: "expired verdicts leave a tombstone holding the previous responseHash for 6 hours; a retry re-measures with the paywall re-armed and the response carries recovery.remeasured + previousResponseHash so agents can branch instead of guessing",
      delegatedSpend: "the caps here are client-side for the signer that constructs the payment; spend through wallets delegated to OTHER agents is outside this contract and governed by the delegating owner's own controls",
      warn: "The key is the caller's secret: whoever presents it can replay the verdict for free. Do not log it publicly.",
    },
    evidence_bundle: {
      spec: "verify402/evidence-bundle@1",
      included: "evidence_bundle: { requestHash, responseHash, pinnedBlock, mode, createdAt, payment.in }",
      requestHash: "sha256 of the canonical JSON { route, body } (keys sorted recursively, no whitespace)",
      responseHash: "sha256 of the canonical JSON of the response body excluding evidence_bundle, recovery, cache, elapsedMs",
      verifier: "use src/recovery.mjs canonicalStable() as reference, or key-sort and stringify with no whitespace, then sha256",
    },
    honesty: [
      "No profit is promised. The measured answer for mainstream pairs is usually no_edge.",
      "If a response says edge, verify before acting; the service reports what it measured, not what it guarantees.",
      "Safety verdicts are measured evidence (live contract calls, actual venue quotes, market data), not a paid audit or a score from folklore.",
      "A preflight PASS is not a guarantee: it means the listed checks passed at that block; `notChecked` names what was not examined.",
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
      return emitPaid(req, res, { ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const raw = BigInt(Math.round(size * 10 ** baseTok.decimals));
    const result = await measureRoundTrip(chainId, {
      baseSymbol: base,
      targetSymbol: target,
      size: raw,
      minNet: BigInt(Math.round(minNet * 10 ** baseTok.decimals)),
    });

    cachePut(key, result);
    emitPaid(req, res, {
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
      return emitPaid(req, res, {
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
    emitPaid(req, res, {
      ...result,
      cache: { hit: false, pinnedBlock: Number(blockNumber) },
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Route book + fairness audit: the two calls that bracket every swap.
app.post("/route", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = Number(body.chainId ?? 1);
    if (!CHAINS[chainId]) {
      return res.status(400).json({ error: `unsupported chainId ${chainId}`, supported: Object.keys(CHAINS).map(Number) });
    }
    let addrIn; let addrOut; let amountIn;
    try {
      addrIn = resolveToken(chainId, String(body.tokenIn ?? "").trim()).address;
    } catch {
      addrIn = String(body.tokenIn ?? "").trim();
    }
    try {
      addrOut = resolveToken(chainId, String(body.tokenOut ?? "").trim()).address;
    } catch {
      addrOut = String(body.tokenOut ?? "").trim();
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(addrIn) || !/^0x[0-9a-fA-F]{40}$/.test(addrOut)) {
      return res.status(400).json({ error: "tokenIn/tokenOut must be a known symbol or a 0x address" });
    }
    if (addrIn.toLowerCase() === addrOut.toLowerCase()) {
      return res.status(400).json({ error: "tokenIn and tokenOut must differ" });
    }
    try {
      amountIn = BigInt(body.amountIn);
      if (amountIn <= 0n) throw new Error();
    } catch {
      return res.status(400).json({ error: "amountIn must be a positive integer string in RAW units of tokenIn" });
    }

    const client = clientFor(chainId);
    const blockNumber = await client.getBlockNumber();
    const key = `route:${chainId}:${addrIn.toLowerCase()}:${addrOut.toLowerCase()}:${amountIn.toString()}:${blockNumber}`;
    if (cache.has(key)) {
      return emitPaid(req, res, { ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const book = await bestRouteBook(client, chainId, { tokenIn: addrIn, tokenOut: addrOut, amountIn, blockNumber });
    const best = book.quoted[0] ?? null;
    const result = {
      ok: true,
      chainId,
      chainName: CHAINS[chainId].name,
      blockNumber: Number(blockNumber),
      amountIn: amountIn.toString(),
      best: best ? { venue: best.venue, kind: best.kind, amountOut: best.amountOut.toString() } : null,
      book: book.quoted.map((q) => ({ venue: q.venue, kind: q.kind, amountOut: q.amountOut.toString() })),
      unavailable: book.unavailable.map((u) => u.venue),
      note: best ? null : "no venue quoted this pair at this size",
    };
    cachePut(key, result);
    emitPaid(req, res, { ...result, cache: { hit: false, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/quotecheck", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = Number(body.chainId ?? 1);
    if (!CHAINS[chainId]) {
      return res.status(400).json({ error: `unsupported chainId ${chainId}`, supported: Object.keys(CHAINS).map(Number) });
    }
    const required = ["tokenIn", "tokenOut", "amountIn", "quotedOut"];
    const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === "");
    if (missing.length) {
      return res.status(400).json({ error: `missing fields: ${missing.join(", ")}`, example: required.map((k) => ({ [k]: "..." })).reduce((a, b) => ({ ...a, ...b })) });
    }

    // Cache by offered number: two agents auditing the same offer in the same
    // block share one book.
    const blockNumber = await clientFor(chainId).getBlockNumber();
    const key = `qc:${chainId}:${String(body.tokenIn).toLowerCase()}:${String(body.tokenOut).toLowerCase()}:${String(body.amountIn)}:${String(body.quotedOut)}:${blockNumber}`;
    if (cache.has(key)) {
      return emitPaid(req, res, { ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const result = await fairQuoteCheck(chainId, {
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      amountIn: body.amountIn,
      quotedOut: body.quotedOut,
      venueClaimed: body.venueClaimed ?? null,
      chainIn: body.chainIn ?? null,
    });

    cachePut(key, result);
    emitPaid(req, res, { ...result, cache: { hit: false, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Position sizing: the ladder scan.
app.post("/depth", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = Number(body.chainId ?? 1);
    if (!CHAINS[chainId]) {
      return res.status(400).json({ error: `unsupported chainId ${chainId}`, supported: Object.keys(CHAINS).map(Number) });
    }
    const token = String(body.tokenAddress ?? "").trim();
    if (!token) return res.status(400).json({ error: 'tokenAddress is required, e.g. {"tokenAddress":"WETH"}' });
    const baseSymbol = String(body.baseSymbol ?? "USDC").toUpperCase();
    const maxRoundTripPct = body.maxRoundTripPct != null ? Number(body.maxRoundTripPct) : 1.0;
    if (!Number.isFinite(maxRoundTripPct) || maxRoundTripPct <= 0 || maxRoundTripPct > 100) {
      return res.status(400).json({ error: "maxRoundTripPct must be a number in (0, 100]" });
    }
    let sizesUsd = null;
    if (Array.isArray(body.sizesUsd) && body.sizesUsd.length) sizesUsd = body.sizesUsd.map(Number);

    const blockNumber = await clientFor(chainId).getBlockNumber();
    const key = `depth:${chainId}:${token.toLowerCase()}:${baseSymbol}:${JSON.stringify(sizesUsd)}:${maxRoundTripPct}:${blockNumber}`;
    if (cache.has(key)) {
      return emitPaid(req, res, { ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const result = await depthProfile(chainId, { tokenAddress: token, baseSymbol, sizesUsd, maxRoundTripPct });
    cachePut(key, result);
    emitPaid(req, res, {
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
  console.log(`  /preflight  : free   (should I sign this payment or transaction?)`);
  console.log(`  /verify     : ${PRICE}   (is this arbitrage real?)`);
  console.log(`  /safety     : ${SAFETY_PRICE}   (is this token safe to buy?)`);
  console.log(`  /route      : ${ROUTE_PRICE}   (what would the chain actually pay?)`);
  console.log(`  /quotecheck : ${QUOTECHECK_PRICE}   (is someone else's quote honest?)`);
  console.log(`  pay to EVM  : ${PAY_TO_EVM}`);
  console.log(`  pay to SVM  : ${PAY_TO_SVM}`);
  console.log(`  facilitator : ${FACILITATOR_URL}`);
  console.log(`  free        : GET / , /info , /health , /findings , /.well-known/*.json\n`);

  // Warm the free snapshot as soon as the process is up: a cold Render instance
  // should spend its boot time measuring, not making the first visitor wait.
  refreshFindings().catch((e) => console.warn("findings prewarm failed:", e.message));
});
