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
import { fileURLToPath, pathToFileURL } from "node:url";
const LANDING_HTML = readFileSync(new URL("./landing.html", import.meta.url), "utf8");
const SITE_DIR = fileURLToPath(new URL("./site", import.meta.url));

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { measureRoundTrip, clientFor, isHardQuoteFailure } from "./measure.mjs";
import { preTradeCheck } from "./safety.mjs";
import { fairQuoteCheck, bestRouteBook, parseRawPositive } from "./quotecheck.mjs";
import { depthProfile } from "./depth.mjs";
import { CHAINS, DEFAULT_SIZE, chain, resolveToken, requireChainId } from "./config.mjs";
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
import {
  HttpError, requestIdMiddleware, sendPublicError, sendClassifiedError, classifyError,
} from "./errors.mjs";
import { paidHonesty, honestFailure, unconfiguredVenues } from "./honesty.mjs";

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
// contract facts, market data, a quote-based sellability check and a full round trip.
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
app.use(requestIdMiddleware);

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

// ---------------------------------------------------------------- recovery --
// The recovery contract (see src/recovery.mjs): a caller that sends
// x-idempotency-key on its first call can replay that settled verdict —
// same bytes, no second charge — within the TTL, capped at MAX_REPLAYS.
// This middleware runs BEFORE the payment wall, which is the entire point:
// by the time paymentMiddleware inspects the request, a legitimate replay has
// already been answered.
//
// C-1: the key is the only credential. No payer scope is derived from
// `x-payment` / `payment-signature`; those headers are unverified at this
// layer. The settled record's verified payer comes only from the facilitator.
app.use((req, res, next) => {
  const key = String(req.get("x-idempotency-key") || req.get("idempotency-key") || "").trim();
  // /preflight is free and issues its own receipt; it does not participate in
  // paid-settlement recovery, where a reused key would 409 the gate.
  if (key && req.method === "POST" && !req.path.startsWith("/.well-known") && !req.path.startsWith("/preflight")) {
    // A key is bound to one operation's canonical request content. Reuse with
    // different content is a conflict, rejected before payment — never a wrong
    // answer and never a free read.
    const rh = requestHash(req.path, req.body || {});
    const found = lookupRecovery({ key, requestHash: rh });
    if (found?.conflict) {
      const h = honestFailure(req.path, null);
      res.set("Cache-Control", "no-store");
      return res.status(409).json({
        error: "recovery_conflict",
        code: "request_mismatch",
        conflict: found.conflict,
        message: "this idempotency key belongs to a different request; use a new key for a new operation",
        requestId: req.requestId,
        ...h,
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
    req.expiredRecovery = expiredRecoveryInfo(key);
    req.idempotencyKey = key;
    req.recoveryRequestHash = rh;
  }
  next();
});

// Shared exit path for the paid handlers: attach the honesty contract and the
// standard evidence bundle, remember the settlement under the caller's
// idempotency key (if provided), then send. `core` is the handler's result;
// cache/elapsedMs may already be on it.
function emitPaid(req, res, core) {
  const body = req.body || {};
  // `_detail` is provider detail retained for server-side logging only. It must
  // never cross the public boundary (H-6).
  const clean = { ...core };
  delete clean._detail;
  const honesty = paidHonesty(req.path, {
    checked: Array.isArray(clean.checked) ? clean.checked : [],
    notChecked: Array.isArray(clean.notChecked) ? clean.notChecked : [],
  });
  const bundle = evidenceBundle({
    route: req.path,
    body,
    pinnedBlock: clean?.cache?.pinnedBlock ?? clean?.blockNumber ?? null,
    payload: clean,
  });
  const full = { ...clean, ...honesty, evidence_bundle: bundle };
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
    recordSettlement(req.idempotencyKey, full, null, {
      settledNow: BYPASS_PAYMENT,
      requestHash: bundle.requestHash,
    });
  }
  res.json(full);
}

// A typed failure on a paid route. Never echoes the provider's message; logs
// it under the request id. Both honesty arrays are always present (H-1).
function paidFail(req, res, status, code, message, { kind = null, log = null, extra = {} } = {}) {
  const honesty = honestFailure(req.path, kind);
  return sendPublicError(req, res, status, code, message, {
    log,
    extra: { ...honesty, ...extra },
  });
}

// Map a typed engine result to an HTTP failure. Only transport/decode are hard
// failures; no_pool/revert are market facts and stay 200 with ok:false.
function hardFailureResponse(req, res, result) {
  if (!result || result.ok !== false || !isHardQuoteFailure(result)) return false;
  const code = result.kind === "decode" ? "internal_error" : "rpc_unavailable";
  const message = result.kind === "decode"
    ? "the provider returned data this service could not decode; no verdict was issued"
    : "the chain could not be read; no verdict was issued and no settlement should occur";
  paidFail(req, res, 503, code, message, {
    kind: result.kind,
    log: result._detail ?? result.kind,
    extra: { quote_status: "failed", unavailable_reason: result.kind },
  });
  return true;
}

function paidCatch(req, res, e) {
  if (e instanceof HttpError) {
    return paidFail(req, res, e.status, e.code, e.message);
  }
  const c = classifyError(e);
  const kind = c.code === "rpc_unavailable" || c.code === "rpc_rate_limited" ? "transport" : null;
  return paidFail(req, res, c.status, c.code, c.message, { kind, log: e });
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
          "Pre-trade gate for an agent about to buy a token. Verdict TRUST / CAUTION / AVOID with evidence: contract facts from the live chain, market liquidity and scam signals, a quote-based sellability check (a USD-sized sell QUOTED through the configured venues' own routers, direct and WETH-routed), a full round-trip cost at your intended size, and an offered-price sanity check against chain consensus. It does not execute a transfer; transfer restrictions and unconfigured venues are named in notChecked.",
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
                notes: ["liquidity and a quote-based sellability check both cleared"],
                checked: ["contract", "market", "quote-based sellability", "liquidity"],
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
          "The full execution book right now: every configured venue (direct and WETH-routed) quoting tokenIn -> tokenOut at one pinned block, best first. Verdict-free evidence; pair it with /quotecheck to audit someone else's number.",
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
            payer: ctx?.result?.payer ?? null,
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
      "gate: contract facts, market liquidity and scam signals, a quote-based sellability " +
      "check through the configured venues' own routers, round-trip cost at the intended size, " +
      "and phantom-price detection. It does not execute a transfer; transfer restrictions and " +
      "unconfigured venues are named in notChecked. " +
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
      { id: "safety", name: "safety", description: "Pre-trade gate: contract facts, market liquidity, scam signals, a quote-based sellability check, round-trip cost at the intended size, TRUST / CAUTION / AVOID with evidence and notChecked transfer restrictions." },
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
      "  quote-based sellability check on the configured venues. It does not execute",
      "  a transfer; transfer restrictions and unconfigured venues are in notChecked.",
      "- POST /route — 0.03 USDC. Every configured venue quoting tokenIn to tokenOut at",
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
          "Pre-trade token gate: TRUST / CAUTION / AVOID, with live contract facts and a quote-based sellability check on the configured venues. Does not execute a transfer; transfer restrictions are in notChecked.",
      },
      {
        url: "https://verify402.onrender.com/route",
        method: "POST",
        description:
          "Every configured venue quoting tokenIn to tokenOut at one pinned block, direct and WETH-routed, best first. Aggregators and unconfigured DEXs are excluded.",
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
    // Free route, same H-6 boundary: never echo the provider's message. The
    // row is explicitly unavailable; the detail stays in the log.
    console.error("[findings] measurement failed:", e?.message || e);
    return { target, verdict: "unavailable", reason: "measurement unavailable: the chain/provider could not be read", blockNumber: null };
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

app.get("/findings", async (req, res) => {
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
    return sendPublicError(req, res, 503, "rpc_unavailable", "the measurement pass failed; retry in a few seconds", {
      log: e,
      extra: { hint: "The measurement pass failed; retry in a few seconds." },
    });
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
        requestId: req.requestId,
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
    return res.status(429).json({ error: "busy", message: "too many concurrent preflights; retry shortly", requestId: req.requestId });
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
      if (e.status >= 500) {
        return sendPublicError(req, res, e.status, "preflight_unavailable", "the chain could not be read, so no receipt was issued; the gate must fail closed", {
          log: e,
          extra: { code: e.code },
        });
      }
      return sendPublicError(req, res, e.status, e.code, e.message, { extra: { code: e.code } });
    }
    recordPreflight({ req, result: null, status: 503, ms, code: "preflight_unavailable" });
    // Fail closed: no receipt means an executor must refuse to sign. A 200
    // with a guessed verdict would be the one failure mode this gate exists
    // to prevent. The provider's message stays in the log, never the body.
    return sendPublicError(req, res, 503, "preflight_unavailable", "the chain could not be read, so no receipt was issued; the gate must fail closed", {
      log: e,
      extra: { code: "preflight_unavailable" },
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
  res.json({ ok: true, mode: MODE, price: PRICE, preflight: "free", networks: NETWORKS.label, ready: "/ready" });
});

// Readiness is a DEEP check: read the latest block with a short timeout. A
// process that is up but cannot reach a chain must not receive traffic. Liveness
// stays /health; orchestrators should use /ready for traffic.
app.get("/ready", async (req, res) => {
  const started = Date.now();
  const chainId = Number(process.env.READY_CHAIN_ID || 1);
  try {
    if (!CHAINS[chainId]) throw new Error(`READY_CHAIN_ID ${chainId} is not configured`);
    const blockNumber = await withTimeout(clientFor(chainId).getBlockNumber(), 3000, "ready");
    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      ready: true,
      mode: MODE,
      chainId,
      blockNumber: Number(blockNumber),
      latencyMs: Date.now() - started,
    });
  } catch (e) {
    return sendPublicError(req, res, 503, "rpc_unavailable", "the chain could not be read within the readiness timeout", {
      log: e,
      extra: { ready: false, chainId, latencyMs: Date.now() - started },
    });
  }
});

app.get("/info", (_req, res) => {
  res.json({
    name: "verify402",
    description:
      "Machine-payable truth service. /preflight is the free pre-signing gate: validate an x402 payment request or a chain transaction and get PASS / CAUTION / BLOCK with typed reasons and a short-lived receipt. /verify measures whether a cross-venue arbitrage round trip is profitable; /safety is a pre-trade gate with a quote-based sellability check, not a honeypot proof. All quotes come from Uniswap's canonical QuoterV2 and each venue's own router, never from our own reimplementation of venue mathematics. The MCP server (verify402-mcp) exposes the gate and the five checks as native tools; install at /mcp.",
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
          checked: ["contract", "market", "quote-based sellability", "liquidity", "price-sanity"],
          notChecked: ["actual token transfer or sell execution", "transfer tax / fee-on-transfer", "blacklist / pause / max-tx restrictions", "venues not in config"],
          evidence: "contract facts, market data, quote-based sellability venues, round-trip cost, price comparison",
        },
        use_when: "an agent is about to BUY a token and needs a quote-based check that it can exit on the configured venues, plus the stated untested restrictions",
      },
      {
        method: "POST",
        path: "/route",
        price: ROUTE_PRICE,
        body: { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000000" },
        response: {
          best: "{ venue, kind, amountOut(raw) } | null",
          book: "every configured venue (direct + WETH-routed), best first, one pinned block",
          unavailable: ["venues that could not quote the size"],
          checked: ["every configured venue", "direct and WETH-routed paths"],
          notChecked: ["aggregators", "unconfigured DEX venues", "execution", "MEV"],
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
    chainIdRequired: "Every paid route and every transaction preflight requires an integer chainId. Missing => 400 missing_chain; wrong type => 400 invalid_chain; unsupported => 400 unsupported_chain. There is no silent Ethereum default.",
    errors: {
      bad_request: "400; the caller's input is wrong (specific code: missing_chain, invalid_chain, unsupported_chain, invalid_size, ...)",
      rate_limited: "429; retry after the advertised window",
      busy: "429; too many concurrent requests",
      rpc_unavailable: "503; the chain/provider could not be read; no verdict was issued",
      rpc_rate_limited: "503; the provider rate-limited us; no verdict was issued",
      internal_error: "500; no provider detail is returned",
      requestId: "Every error carries requestId and the same value in the x-request-id header; server logs use it.",
      settlement: "x402 settlement is cancelled for any response >=400 (the installed @x402/express middleware checks res.statusCode). A 503 means no charge.",
    },
    readiness: {
      path: "/ready",
      price: "free",
      check: "latest block read with a 3s timeout",
      liveness: "/health",
    },
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
        "counterparty identity / tool metadata",
        "prompt injection / hidden Unicode in tool output",
      ],
      note: "A PASS is not a guarantee or a counterparty audit. It means the listed checks passed at this block; `notChecked` lists what was not examined, including tool metadata and response content.",
    },
    mcp: {
      package: "verify402-mcp",
      version: "1.0.3",
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
      maxReplaysNote: "the cap is per operation, bound to the caller's key",
      identity: "The original idempotency key is the only replay credential. The service does NOT derive a payer identity from x-payment, payment-signature, or authorization.from. The settled record stores the facilitator-confirmed payer as verified_payer for audit only.",
      noCompanionAlias: "There is no content-hash companion alias. A public content hash would turn a known body into a free read, and a token returned only in the original response cannot help a lost-response retry. The caller's secret key is the only credential that survives.",
      requestBinding: "The key is bound to the canonical request body; reusing it for a different operation returns 409 recovery_conflict before payment.",
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
      "Safety verdicts use a quote-based sellability check (quotes, not transfer execution). Transfer tax, blacklist, pause, and max-tx restrictions are listed in notChecked.",
      "A preflight PASS is not a guarantee: it means the listed checks passed at that block; `notChecked` names what was not examined.",
      "Payment preflight PASS can be structural_only: with no payer from address or no proof, it validates the request shape and says so.",
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
    const chainId = requireChainId(body);
    const base = String(body.base ?? "USDC").toUpperCase();
    const target = String(body.target ?? "").toUpperCase();
    const size = Number(body.size ?? DEFAULT_SIZE);
    const minNet = Number(body.minNet ?? 0);

    if (!target) return paidFail(req, res, 400, "missing_target", 'target is required, e.g. {"target":"WETH"}');
    const c = CHAINS[chainId];
    const baseTok = c.tokens[base];
    const targetTok = c.tokens[target];
    if (!baseTok) return paidFail(req, res, 400, "unknown_base", `unknown base ${base}`, { extra: { known: Object.keys(c.tokens) } });
    if (!targetTok) return paidFail(req, res, 400, "unknown_target", `unknown target ${target}`, { extra: { known: Object.keys(c.tokens) } });

    const maxWhole = Number.MAX_SAFE_INTEGER / 10 ** baseTok.decimals;
    if (!Number.isFinite(size) || size <= 0 || size > maxWhole) {
      return paidFail(req, res, 400, "invalid_size", `size must be a positive number <= ${maxWhole}`);
    }
    if (!Number.isFinite(minNet) || minNet < 0 || minNet > maxWhole) {
      return paidFail(req, res, 400, "invalid_minNet", `minNet must be a non-negative number <= ${maxWhole}`);
    }

    let blockNumber;
    try {
      blockNumber = await clientFor(chainId).getBlockNumber();
    } catch (e) {
      return paidCatch(req, res, e);
    }
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

    // transport/decode: 503, no charge, no cached verdict, no settlement record.
    if (hardFailureResponse(req, res, result)) return;

    cachePut(key, result);
    emitPaid(req, res, {
      ...result,
      cache: { hit: false, pinnedBlock: Number(blockNumber) },
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    return paidCatch(req, res, e);
  }
});

// The pre-trade gate: the call an agent makes before every swap. Accepts any
// ERC-20 address, not just registry symbols, because the long tail is exactly
// where the danger lives.
app.post("/safety", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = requireChainId(body);
    const tokenAddress = String(body.tokenAddress ?? "").trim();
    const intendedUsd = Number(body.intendedUsd ?? 500);
    const offeredPriceUsd = body.offeredPriceUsd != null ? Number(body.offeredPriceUsd) : null;
    const baseSymbol = String(body.baseSymbol ?? "USDC").toUpperCase();

    if (!tokenAddress) {
      return paidFail(req, res, 400, "missing_tokenAddress", 'tokenAddress is required, e.g. {"tokenAddress":"0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE"}');
    }
    const c = CHAINS[chainId];
    const baseTok = c.tokens[baseSymbol];
    if (!baseTok) return paidFail(req, res, 400, "unknown_base", `unknown base ${baseSymbol}`, { extra: { known: Object.keys(c.tokens) } });
    const maxWhole = Number.MAX_SAFE_INTEGER / 10 ** baseTok.decimals;
    if (!Number.isFinite(intendedUsd) || intendedUsd <= 0 || intendedUsd > maxWhole) {
      return paidFail(req, res, 400, "invalid_intendedUsd", `intendedUsd must be a positive number <= ${maxWhole}`);
    }
    if (offeredPriceUsd != null && (!Number.isFinite(offeredPriceUsd) || offeredPriceUsd < 0)) {
      return paidFail(req, res, 400, "invalid_offeredPriceUsd", "offeredPriceUsd must be a non-negative number when supplied");
    }

    // Same (route, params, block) cache key: two agents asking about the same
    // token in the same block share one set of probes.
    let blockNumber;
    try {
      blockNumber = await clientFor(chainId).getBlockNumber();
    } catch (e) {
      return paidCatch(req, res, e);
    }
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

    if (hardFailureResponse(req, res, result)) return;
    if (result?.ok === false && result.kind === "bad_request") {
      return paidFail(req, res, 400, "bad_request", result.error || "invalid token or parameters");
    }

    cachePut(key, result);
    emitPaid(req, res, {
      ...result,
      cache: { hit: false, pinnedBlock: Number(blockNumber) },
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    return paidCatch(req, res, e);
  }
});

// Route book + fairness audit: the two calls that bracket every swap.
app.post("/route", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = requireChainId(body);
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
      return paidFail(req, res, 400, "invalid_token", "tokenIn/tokenOut must be a known symbol or a 0x address");
    }
    if (addrIn.toLowerCase() === addrOut.toLowerCase()) {
      return paidFail(req, res, 400, "same_token", "tokenIn and tokenOut must differ");
    }
    try {
      if (String(body.amountIn ?? "").length > 100) throw new Error();
      amountIn = BigInt(body.amountIn);
      if (amountIn <= 0n) throw new Error();
    } catch {
      return paidFail(req, res, 400, "invalid_amountIn", "amountIn must be a positive integer string in RAW units of tokenIn");
    }

    const client = clientFor(chainId);
    let blockNumber;
    try {
      blockNumber = await client.getBlockNumber();
    } catch (e) {
      return paidCatch(req, res, e);
    }
    const key = `route:${chainId}:${addrIn.toLowerCase()}:${addrOut.toLowerCase()}:${amountIn.toString()}:${blockNumber}`;
    if (cache.has(key)) {
      return emitPaid(req, res, { ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const book = await bestRouteBook(client, chainId, { tokenIn: addrIn, tokenOut: addrOut, amountIn, blockNumber });
    if (book.hard_failure) {
      return hardFailureResponse(req, res, { ok: false, kind: book.hard_failure.kind, _detail: book.hard_failure.detail });
    }

    const best = book.quoted[0] ?? null;
    const quoteStatus = best ? (book.unavailable.length ? "partial" : "ok") : "no_pool";
    const result = {
      ok: Boolean(best),
      quote_status: quoteStatus,
      unavailable_reason: quoteStatus === "no_pool" ? "no_pool" : quoteStatus === "partial" ? "some_venues_no_pool" : null,
      chainId,
      chainName: CHAINS[chainId].name,
      blockNumber: Number(blockNumber),
      amountIn: amountIn.toString(),
      best: best ? { venue: best.venue, kind: best.kind, amountOut: best.amountOut.toString() } : null,
      book: book.quoted.map((q) => ({ venue: q.venue, kind: q.kind, amountOut: q.amountOut.toString() })),
      // Backward-compatible names plus typed reasons.
      unavailable: book.unavailable.map((u) => u.venue),
      unavailable_reasons: book.unavailable,
      note: best ? null : "no configured venue quoted this pair at this size",
    };
    cachePut(key, result);
    emitPaid(req, res, { ...result, cache: { hit: false, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
  } catch (e) {
    return paidCatch(req, res, e);
  }
});

app.post("/quotecheck", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = requireChainId(body);
    const required = ["tokenIn", "tokenOut", "amountIn", "quotedOut"];
    const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === "");
    if (missing.length) {
      return paidFail(req, res, 400, "missing_fields", `missing fields: ${missing.join(", ")}`);
    }
    let amountIn;
    let quotedOut;
    try {
      amountIn = parseRawPositive(body.amountIn, "amountIn");
    } catch (e) {
      return paidFail(req, res, 400, "invalid_amountIn", e.message);
    }
    try {
      quotedOut = parseRawPositive(body.quotedOut, "quotedOut");
    } catch (e) {
      return paidFail(req, res, 400, "invalid_quotedOut", e.message);
    }

    // Cache by offered number: two agents auditing the same offer in the same
    // block share one book.
    let blockNumber;
    try {
      blockNumber = await clientFor(chainId).getBlockNumber();
    } catch (e) {
      return paidCatch(req, res, e);
    }
    const key = `qc:${chainId}:${String(body.tokenIn).toLowerCase()}:${String(body.tokenOut).toLowerCase()}:${amountIn.toString()}:${quotedOut.toString()}:${blockNumber}`;
    if (cache.has(key)) {
      return emitPaid(req, res, { ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const result = await fairQuoteCheck(chainId, {
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      amountIn: amountIn.toString(),
      quotedOut: quotedOut.toString(),
      venueClaimed: body.venueClaimed ?? null,
      chainIn: body.chainIn ?? null,
    });

    if (hardFailureResponse(req, res, result)) return;
    if (result?.ok === false && result.kind === "bad_request") {
      return paidFail(req, res, 400, "bad_request", result.error || "invalid token or parameters");
    }

    cachePut(key, result);
    emitPaid(req, res, { ...result, cache: { hit: false, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
  } catch (e) {
    return paidCatch(req, res, e);
  }
});

// Position sizing: the ladder scan.
app.post("/depth", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const chainId = requireChainId(body);
    const token = String(body.tokenAddress ?? "").trim();
    if (!token) return paidFail(req, res, 400, "missing_tokenAddress", 'tokenAddress is required, e.g. {"tokenAddress":"WETH"}');
    const baseSymbol = String(body.baseSymbol ?? "USDC").toUpperCase();
    const maxRoundTripPct = body.maxRoundTripPct != null ? Number(body.maxRoundTripPct) : 1.0;
    if (!Number.isFinite(maxRoundTripPct) || maxRoundTripPct <= 0 || maxRoundTripPct > 100) {
      return paidFail(req, res, 400, "invalid_maxRoundTripPct", "maxRoundTripPct must be a number in (0, 100]");
    }
    let sizesUsd = null;
    if (body.sizesUsd != null) {
      if (!Array.isArray(body.sizesUsd) || !body.sizesUsd.length) {
        return paidFail(req, res, 400, "invalid_sizesUsd", "sizesUsd must be a non-empty array of positive numbers, each <= 1,000,000 USD");
      }
      sizesUsd = body.sizesUsd.map(Number);
      if (sizesUsd.some((s) => !Number.isFinite(s) || s <= 0 || s > 1_000_000)) {
        return paidFail(req, res, 400, "invalid_sizesUsd", "sizesUsd must contain only positive numbers, each <= 1,000,000 USD");
      }
    }

    let blockNumber;
    try {
      blockNumber = await clientFor(chainId).getBlockNumber();
    } catch (e) {
      return paidCatch(req, res, e);
    }
    const key = `depth:${chainId}:${token.toLowerCase()}:${baseSymbol}:${JSON.stringify(sizesUsd)}:${maxRoundTripPct}:${blockNumber}`;
    if (cache.has(key)) {
      return emitPaid(req, res, { ...cache.get(key), cache: { hit: true, pinnedBlock: Number(blockNumber) }, elapsedMs: Date.now() - started });
    }

    const result = await depthProfile(chainId, { tokenAddress: token, baseSymbol, sizesUsd, maxRoundTripPct });
    if (hardFailureResponse(req, res, result)) return;
    if (result?.ok === false && result.kind === "bad_request") {
      return paidFail(req, res, 400, "bad_request", result.error || "invalid token or parameters");
    }

    cachePut(key, result);
    emitPaid(req, res, {
      ...result,
      cache: { hit: false, pinnedBlock: Number(blockNumber) },
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    return paidCatch(req, res, e);
  }
});

export { app };

const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
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
    console.log(`  free        : GET / , /info , /health , /ready , /findings , /.well-known/*.json\n`);

    // Warm the free snapshot as soon as the process is up: a cold Render instance
    // should spend its boot time measuring, not making the first visitor wait.
    refreshFindings().catch((e) => console.warn("findings prewarm failed:", e.message));
  });
}
