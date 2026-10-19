#!/usr/bin/env node
// verify402 MCP bridge.
//
// Makes verify402 consumable by any MCP client (Claude Desktop, OpenCode, any
// agent framework) as native tools. The free preflight gate works with no
// wallet. The five paid checks use an x402 payment handshake from the wallet in
// EVM_PRIVATE_KEY and return the verdict.
//
// ARCHITECTURE (per docs.x402.org/guides/mcp-server-with-x402):
//
//   MCP client ──▶ this bridge (MCP server + x402 payer) ──▶ verify402.com
//
//   1. tool call            3. 402 + PAYMENT-REQUIRED
//   2. paid GET/POST        4. sign payment (wallet in env)
//                           5. retry with proof → verdict
//
// PAYMENT POLICY (load-bearing, do not remove): before a signature exists,
// x402Client's spend controls enforce the USD cap and the default-asset
// (USDC) allowlist; payment-policy.mjs then enforces the network allowlist,
// the verify402 payee, and a known paid resource on the configured server.
// Redirects are refused. An MCP server that signs anything any remote 402
// asks for is a blank cheque. This one is not.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "dotenv";
import { z } from "zod";

config();

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
const SERVER_URL = process.env.VERIFY402_URL || "https://verify402.onrender.com";
// Preflight is free, so it does not go through the paying client. Keeping the
// two clients separate means a misconfigured 402 on a free route can never
// turn into a signature.
const freeApi = axios.create({ baseURL: SERVER_URL, timeout: 30_000, maxRedirects: 0 });
// Spend guard: the x402 client refuses to SIGN any payment above this, before
// a signature exists. Enforced inside x402Client (applySpendControls), not by
// our own request code - so it cannot be bypassed by a caller.
const MAX_PAYMENT_USD = Number(process.env.MAX_PAYMENT_USD || 0.25);

// Free-only mode is deliberate: an agent can install the bridge and call the
// free preflight gate without handing it a private key. The paid tools are
// registered only when a wallet is configured.
const PAID_ENABLED = Boolean(EVM_PRIVATE_KEY);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`verify402-mcp — MCP server for verify402

Usage:
  verify402-mcp                 start the stdio MCP server
  verify402-mcp --help          show this help
  verify402-mcp --version       print the version

Environment:
  VERIFY402_URL     verify402 base URL (default https://verify402.onrender.com)
  EVM_PRIVATE_KEY   optional; omit for the free preflight_gate only
  MAX_PAYMENT_USD   cap on one x402 payment (default 0.25)
  MAX_DAILY_USD     optional cap for the UTC day, persisted in a small ledger
  SPEND_LEDGER_PATH optional ledger path (default .spend-ledger.json)
  VERIFY402_NETWORKS  comma-separated EVM networks for paid calls (default eip155:8453)
  VERIFY402_PAY_TO    EVM payee the 402 must name (default the verify402 payee)
  VERIFY402_RESOURCE_PREFIX  resource origin/prefix the 402 must match (default VERIFY402_URL)

The free gate is preflight_gate. The paid tools are verify_arbitrage,
check_token_safety, get_best_route, verify_quote_fairness and get_trade_depth.
The bridge signs x402 payments only; it never signs or sends a trade.
`);
  process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log("1.0.2");
  process.exit(0);
}

// ---------------------------------------------------------------- payment ---
async function createPaidClient() {
  if (!Number.isFinite(MAX_PAYMENT_USD) || MAX_PAYMENT_USD <= 0) {
    throw new Error("MAX_PAYMENT_USD must be a positive number");
  }
  const policy = createPaymentPolicy({
    networks: process.env.VERIFY402_NETWORKS || DEFAULT_NETWORKS,
    payTo: process.env.VERIFY402_PAY_TO || DEFAULT_PAY_TO,
    resourcePrefix: process.env.VERIFY402_RESOURCE_PREFIX || SERVER_URL,
    paidRoutes: Object.keys(DEFAULT_PRICES),
  });
  const account = privateKeyToAccount(EVM_PRIVATE_KEY);
  const client = x402Client.fromConfig({
    schemes: [], // registered below, one per allowlisted network
    spendControls: { maxAmountPerPayment: `$${MAX_PAYMENT_USD}` },
    policies: [(version, requirements) => policy.filter(version, requirements)],
  });
  for (const network of policy.allowedNetworks) {
    client.register(network, new ExactEvmScheme(account));
  }
  client.onBeforePaymentCreation((context) => policy.checkBeforeSign(context));
  console.error(
    `paid policy: networks=${policy.allowedNetworks.join(",")} ` +
      `payee=${policy.allowedPayTo} resources=${policy.resourcePrefix} ` +
      `{${policy.paidRoutes.join(",")}}`,
  );
  const axiosInstance = axios.create({ baseURL: SERVER_URL, timeout: 120_000, maxRedirects: 0 });
  return wrapAxiosWithPayment(axiosInstance, client);
}

// ------------------------------------------------------------------ budget --
// The second, broader guard: MAX_PAYMENT_USD caps ONE payment; MAX_DAILY_USD
// (optional) caps the whole UTC day across restarts, persisted in a tiny
// ledger file. Attempted charges are counted conservatively (before payment).
import { createDailyBudget, DEFAULT_PRICES } from "./budget.mjs";
import { createPaymentPolicy, DEFAULT_NETWORKS, DEFAULT_PAY_TO } from "./payment-policy.mjs";
const dailyBudget = createDailyBudget({
  maxDailyUsd: process.env.MAX_DAILY_USD,
});

async function guardedPaidCall(route, run) {
  if (dailyBudget.enabled) dailyBudget.assert(route);
  return run();
}

// ------------------------------------------------------------------ tools ---
const DESCRIPTIONS = {
  preflight_gate:
    "Call this BEFORE signing any crypto transaction or x402 payment request. " +
    "Returns PASS / CAUTION / BLOCK with typed reasons, the checks that actually ran, " +
    "the checks that did not, and a short-lived receipt bound to the exact intent + block. " +
    "If sign_allowed is false, DO NOT SIGN. If requires_ack is true, surface the reasons to the " +
    "operator before signing. The receipt expires (default 90s): call again rather than reuse it. " +
    "Free. Pass `from` (the wallet that will sign) to enable simulation and balance checks.",
  verify_arbitrage:
    "Ask verify402 whether a cross-venue arbitrage opportunity is REAL, right now. " +
    "Quotes come from Uniswap's canonical QuoterV2 and each DEX router at one pinned block. " +
    "The honest answer is usually 'no_edge' - that IS the product. Costs $0.05 per call.",
  check_token_safety:
    "Ask verify402 whether a token is safe to buy BEFORE the agent risks capital. " +
    "Returns TRUST/CAUTION/AVOID with evidence: live contract facts, market liquidity, " +
    "a USD-sized sell probe against every venue (honeypot test), round-trip cost at your " +
    "intended size, and phantom-price detection. Costs $0.10 per call.",
  get_best_route:
    "Ask verify402 what the chain would ACTUALLY pay for a swap: the full execution book " +
    "(every venue, direct and WETH-routed) at one pinned block, best first. Costs $0.03 per call.",
  verify_quote_fairness:
    "Audit a swap quote someone else gave you (aggregator, broker, bot) BEFORE signing. " +
    "Returns fair / overpaying / too_good_to_be_true with the full chain book as evidence. " +
    "Ask this before accepting ANY number you did not produce yourself. Costs $0.05 per call.",
  get_trade_depth:
    "Position sizing: measure how much of a token the chain ACTUALLY lets you trade - " +
    "entry and exit across every venue at a ladder of USD sizes, per-size impact and " +
    "round-trip cost, plus the largest size under your cost tolerance. Ask BEFORE choosing " +
    "a position size. Costs $0.05 per call.",
};

async function main() {
  const paidApi = PAID_ENABLED ? await createPaidClient() : null;

  const server = new McpServer({ name: "verify402", version: "1.0.2" });

  server.tool(
    "preflight_gate",
    DESCRIPTIONS.preflight_gate,
    {
      kind: z.enum(["payment", "transaction"]).describe("payment = an x402 402 challenge; transaction = a chain transaction"),
      chainId: z.number().optional().describe("EVM chain id: 1 Ethereum, 42161 Arbitrum, 8453 Base. For payment, cross-checks the network."),
      from: z.string().optional().describe("The wallet that will sign. Strongly recommended: enables simulation and balance checks."),
      payment: z.object({
        scheme: z.string().optional().describe('x402 scheme, normally "exact"'),
        network: z.string().describe('CAIP-2 network, e.g. "eip155:8453" or "solana:..."'),
        asset: z.string().describe("Token address or mint, e.g. canonical USDC on that network"),
        amount: z.string().describe("RAW amount in the asset's smallest unit, as a string"),
        payTo: z.string().describe("Recipient address from the 402 challenge"),
        resource: z.string().optional().describe("The resource URL the payment is for"),
        maxTimeoutSeconds: z.number().optional().describe("maxTimeoutSeconds from the 402 challenge"),
        extra: z.object({
          validAfter: z.number().optional(),
          validBefore: z.number().optional(),
          facilitator: z.string().optional(),
        }).optional().describe("x402 extra fields: validAfter / validBefore / facilitator"),
      }).optional().describe("Required when kind=payment"),
      to: z.string().optional().describe("Transaction target (required when kind=transaction)"),
      data: z.string().optional().describe("0x calldata for the transaction"),
      value: z.string().optional().describe("Native value in wei, as a decimal string"),
      policy: z.object({
        maxAmountUsd: z.number().optional().describe("Reject payments above this USD value"),
        maxValueWei: z.string().optional().describe("Reject native value above this wei amount"),
        maxValueEth: z.number().optional().describe("Reject native value above this ETH amount"),
        allowedNetworks: z.array(z.string()).optional().describe("Allowlist of CAIP-2 networks"),
        allowedPayTo: z.array(z.string()).optional().describe("Allowlist of payment recipients"),
        allowedTo: z.array(z.string()).optional().describe("Allowlist of transaction targets"),
        allowedSpenders: z.array(z.string()).optional().describe("Allowlist of approval spenders"),
        allowedAssets: z.array(z.string()).optional().describe("Allowlist of payment assets"),
        allowedFacilitators: z.array(z.string()).optional().describe("Allowlist of x402 facilitators"),
        expectedResource: z.string().optional().describe("The exact resource URL the agent intends to pay for"),
        forbidUnlimitedApproval: z.boolean().optional().describe("Turn an unlimited approve into a BLOCK"),
        maxTimeoutSeconds: z.number().optional().describe("Reject challenges with a longer timeout"),
      }).optional().describe("Operator policy. Omit for structural checks only."),
      ttlSeconds: z.number().optional().describe("Receipt lifetime in seconds, 15-300 (default 90)"),
    },
    async (args) => {
      const payload = {
        kind: args.kind,
        chainId: args.chainId,
        from: args.from,
        payment: args.payment,
        to: args.to,
        data: args.data,
        value: args.value,
        policy: args.policy,
        ttlSeconds: args.ttlSeconds,
      };
      try {
        const res = await freeApi.post("/preflight", payload);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
      } catch (e) {
        const status = e.response?.status;
        const body = e.response?.data;
        return {
          isError: true,
          content: [{
            type: "text",
            text: `preflight failed${status ? ` (${status})` : ""}: ${JSON.stringify(body ?? e.message)}. Do not sign without a verifiable receipt.`,
          }],
        };
      }
    },
  );

  // Paid tools require a wallet. Without EVM_PRIVATE_KEY the server still
  // exposes the free gate, so "install it and try it" never asks for a key.
  if (paidApi) {
  server.tool(
    "verify_arbitrage",
    DESCRIPTIONS.verify_arbitrage,
    {
      target: z.string().describe('Token to buy and sell back, e.g. "WETH"'),
      chainId: z.number().optional().describe("1 Ethereum, 42161 Arbitrum, 8453 Base (default 1)"),
      base: z.string().optional().describe('Token to trade from, e.g. "USDC" (default USDC)'),
      size: z.number().optional().describe("Trade size in whole base units, e.g. 100000 (default 100000)"),
    },
    async (args) => {
      const res = await guardedPaidCall("/verify", () => paidApi.post("/verify", {
        chainId: args.chainId ?? 1,
        target: String(args.target ?? "WETH").toUpperCase(),
        base: String(args.base ?? "USDC").toUpperCase(),
        size: args.size ?? 100000,
      }));
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  server.tool(
    "check_token_safety",
    DESCRIPTIONS.check_token_safety,
    {
      tokenAddress: z.string().describe("ERC-20 contract address, or a known symbol like WETH"),
      chainId: z.number().optional().describe("1 Ethereum, 42161 Arbitrum, 8453 Base (default 1)"),
      intendedUsd: z.number().optional().describe("Size the agent plans to buy, in USD (default 500)"),
      offeredPriceUsd: z.number().optional().describe("Optional price per token someone offered you"),
    },
    async (args) => {
      const res = await guardedPaidCall("/safety", () => paidApi.post("/safety", {
        chainId: args.chainId ?? 1,
        tokenAddress: String(args.tokenAddress ?? "").trim(),
        intendedUsd: args.intendedUsd ?? 500,
        offeredPriceUsd: args.offeredPriceUsd ?? null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  server.tool(
    "get_best_route",
    DESCRIPTIONS.get_best_route,
    {
      tokenIn: z.string().describe("Token symbol (e.g. USDC) or 0x address"),
      tokenOut: z.string().describe("Token symbol (e.g. WETH) or 0x address"),
      amountIn: z.string().describe("RAW base units of tokenIn, wei-scale, as a string"),
      chainId: z.number().optional().describe("1 Ethereum, 42161 Arbitrum, 8453 Base (default 1)"),
    },
    async (args) => {
      const res = await guardedPaidCall("/route", () => paidApi.post("/route", {
        chainId: args.chainId ?? 1,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
      }));
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  server.tool(
    "verify_quote_fairness",
    DESCRIPTIONS.verify_quote_fairness,
    {
      tokenIn: z.string().describe("Token you are selling (symbol or 0x address)"),
      tokenOut: z.string().describe("Token you would receive (symbol or 0x address)"),
      amountIn: z.string().describe("RAW units of tokenIn, as in the offer"),
      quotedOut: z.string().describe("RAW units of tokenOut you were OFFERED"),
      venueClaimed: z.string().optional().describe("Optional: who gave you the offer"),
      chainId: z.number().optional().describe("1 Ethereum, 42161 Arbitrum, 8453 Base (default 1)"),
    },
    async (args) => {
      const res = await guardedPaidCall("/quotecheck", () => paidApi.post("/quotecheck", {
        chainId: args.chainId ?? 1,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        quotedOut: args.quotedOut,
        venueClaimed: args.venueClaimed ?? null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  server.tool(
    "get_trade_depth",
    DESCRIPTIONS.get_trade_depth,
    {
      tokenAddress: z.string().describe("Token you plan to buy (symbol or 0x address)"),
      chainId: z.number().optional().describe("1 Ethereum, 42161 Arbitrum, 8453 Base (default 1)"),
      baseSymbol: z.string().optional().describe("What you pay with (default USDC)"),
      sizesUsd: z.array(z.number()).optional().describe("Ladder of sizes in USD, max 6 (default 100, 1000, 10000, 100000)"),
      maxRoundTripPct: z.number().optional().describe("Your round-trip cost tolerance, default 1%"),
    },
    async (args) => {
      const res = await guardedPaidCall("/depth", () => paidApi.post("/depth", {
        chainId: args.chainId ?? 1,
        tokenAddress: args.tokenAddress,
        baseSymbol: args.baseSymbol ?? "USDC",
        sizesUsd: args.sizesUsd ?? null,
        maxRoundTripPct: args.maxRoundTripPct ?? 1.0,
      }));
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );
  } // end paid tools

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    paidApi
      ? `verify402 MCP bridge connected -> ${SERVER_URL} (paid tools on, max payment $${MAX_PAYMENT_USD})`
      : `verify402 MCP bridge connected -> ${SERVER_URL} (free preflight_gate only; set EVM_PRIVATE_KEY for paid tools)`,
  );
}

main().catch((e) => {
  console.error("bridge failed:", e.message);
  process.exit(1);
});
