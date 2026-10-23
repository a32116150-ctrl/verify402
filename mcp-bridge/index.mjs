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
import { installConsoleRedaction, logInfo, logError } from "./log.mjs";
import { paidPost } from "./paid-call.mjs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

installConsoleRedaction();

// Only the process entry point loads the operator's `.env`. Importing this
// module (tests, tooling) must never read the wallet file.
const IS_MAIN = isMainModule();
if (IS_MAIN) config();

const VERSION = "1.0.6";
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
// Normalise once so the axios base URL, the payment policy prefix, and the
// per-tool expected resource are all the same string (no trailing slash).
const SERVER_URL = (process.env.VERIFY402_URL || "https://verify402.onrender.com")
  .trim()
  .replace(/\/+$/, "");
// Tell the server which client made the call. This is a label, not an identity:
// it helps separate MCP use from generic HTTP probes without collecting keys or
// wallet addresses.
const CLIENT_HEADERS = {
  "User-Agent": `verify402-mcp/${VERSION}`,
  "X-Verify402-Client": `mcp/${VERSION}`,
};
// Preflight is free, so it does not go through the paying client. Keeping the
// two clients separate means a misconfigured 402 on a free route can never
// turn into a signature.
const freeApi = axios.create({ baseURL: SERVER_URL, timeout: 30_000, maxRedirects: 0, headers: CLIENT_HEADERS });
// Spend guard: the x402 client refuses to SIGN any payment above this, before
// a signature exists. Enforced inside x402Client (applySpendControls), not by
// our own request code - so it cannot be bypassed by a caller.
const MAX_PAYMENT_USD = Number(process.env.MAX_PAYMENT_USD || 0.25);

// Free-only mode is deliberate: an agent can install the bridge and call the
// free preflight gate without handing it a private key. The paid tools are
// registered only when a wallet is configured.
const PAID_ENABLED = Boolean(EVM_PRIVATE_KEY);

// Each paid MCP tool is bound to exactly one paid API route. This map is local,
// trusted configuration: a 402 challenge can never choose which resource a tool
// is allowed to pay for. The pre-sign guard compares the challenge's resource
// against the route of the tool that is currently running.
export const PAID_TOOL_ROUTES = Object.freeze({
  verify_arbitrage: "/verify",
  check_token_safety: "/safety",
  get_best_route: "/route",
  verify_quote_fairness: "/quotecheck",
  get_trade_depth: "/depth",
});

// Carries the current tool's expected resource from the tool handler to the
// pre-sign hook. AsyncLocalStorage keeps concurrent tool calls isolated and is
// the only channel the guard trusts for the expected resource.
const paymentContext = new AsyncLocalStorage();

function paidCallContext(tool) {
  const route = PAID_TOOL_ROUTES[tool];
  if (!route) throw new Error(`unknown paid tool: ${String(tool)}`);
  return { tool, route, expectedResource: `${SERVER_URL}${route}` };
}

/**
 * Run `run` as the given paid tool. Exported so tests can drive the real
 * binding without starting the MCP transport.
 */
export function runWithPaidTool(tool, run) {
  return paymentContext.run(paidCallContext(tool), run);
}

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
  VERIFY402_NETWORKS  comma-separated EVM networks for paid calls (default eip155:84532, Base Sepolia testnet; eip155:8453 only by explicit opt-in)
  VERIFY402_PAY_TO    EVM payee the 402 must name (default the verify402 payee)
  VERIFY402_RESOURCE_PREFIX  resource origin/prefix the 402 must match (default VERIFY402_URL)

The free gate is preflight_gate. The paid tools are verify_arbitrage,
check_token_safety, get_best_route, verify_quote_fairness and get_trade_depth.
The bridge signs x402 payments only; it never signs or sends a trade.
`);
  process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

// ---------------------------------------------------------------- payment ---
export function createBridgeClientFromEnv() {
  if (!Number.isFinite(MAX_PAYMENT_USD) || MAX_PAYMENT_USD <= 0) {
    throw new Error("MAX_PAYMENT_USD must be a positive number");
  }
  const policy = createPaymentPolicyFromEnv({
    resourcePrefix: SERVER_URL,
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
  // Full-challenge guard (version, every EVM offer, canonical asset/domain,
  // payee, amount cap, timeout, EIP-3009) plus the resource/route layer. It
  // runs after the SDK has selected a requirement and before the signer.
  // The expected resource is resolved per invocation from the tool handler
  // context, never from the 402 challenge.
  client.onBeforePaymentCreation(
    createPaymentGuard(policy, {
      maxAmountUsd: MAX_PAYMENT_USD,
      expectedResource: () => paymentContext.getStore()?.expectedResource,
    }),
  );
  logInfo(
    `paid policy: networks=${policy.allowedNetworks.join(",")} ` +
      `payee=${policy.allowedPayTo} resources=${policy.resourcePrefix} ` +
      `{${policy.paidRoutes.join(",")}}`,
  );
  return client;
}

export async function createBridgePaidClient(client = createBridgeClientFromEnv()) {
  if (!Number.isFinite(MAX_PAYMENT_USD) || MAX_PAYMENT_USD <= 0) {
    throw new Error("MAX_PAYMENT_USD must be a positive number");
  }
  const axiosInstance = axios.create({ baseURL: SERVER_URL, timeout: 120_000, maxRedirects: 0, headers: CLIENT_HEADERS });
  return wrapAxiosWithPayment(axiosInstance, client);
}

// ------------------------------------------------------------------ budget --
// The second, broader guard: MAX_PAYMENT_USD caps ONE payment; MAX_DAILY_USD
// (optional) caps the whole UTC day across restarts, persisted in a tiny
// ledger file. Attempted charges are counted conservatively (before payment).
import { createDailyBudget, DEFAULT_PRICES } from "./budget.mjs";
import { createPaymentGuard, createPaymentPolicyFromEnv } from "./payment-policy.mjs";
const dailyBudget = createDailyBudget({
  maxDailyUsd: process.env.MAX_DAILY_USD,
});

async function guardedPaidCall(tool, run) {
  const context = paidCallContext(tool);
  if (dailyBudget.enabled) dailyBudget.assert(context.route);
  const res = await paymentContext.run(context, run);
  if (res?.data?.recovery?.replayed) {
    // Visible to the operator without exposing the bearer key. The same flag
    // is already in the JSON returned to the MCP client.
    logInfo(`${context.route}: recovery.replayed=true (settled verdict returned without a second charge)`);
  }
  return res;
}

/**
 * Run one paid MCP tool. The route is resolved from local tool configuration
 * (PAID_TOOL_ROUTES), recorded in the async context, and used for both the HTTP
 * request and the pre-sign expected-resource check, so the 402 challenge can
 * never redirect a tool to a different paid resource.
 */
export async function runPaidTool({ tool, client, body }) {
  if (!Object.hasOwn(PAID_TOOL_ROUTES, tool)) {
    throw new Error(`unknown paid tool: ${String(tool)}`);
  }
  if (!client) throw new Error(`paid client is not configured for tool ${tool}`);
  const route = PAID_TOOL_ROUTES[tool];
  return guardedPaidCall(tool, () => paidPost(client, route, body));
}

// ------------------------------------------------------------------ tools ---
const DESCRIPTIONS = {
  preflight_gate:
    "Call this BEFORE signing any crypto transaction or x402 payment request. " +
    "Returns PASS / CAUTION / BLOCK with typed reasons, the checks that actually ran, " +
    "the checks that did not, and a short-lived receipt bound to the exact intent + block. " +
    "If sign_allowed is false, DO NOT SIGN. If requires_ack is true, surface the reasons to the " +
    "operator before signing. The receipt expires (default 90s): call again rather than reuse it. " +
    "Free. Pass `from` (the wallet that will sign) to enable simulation and balance checks. For " +
    "kind=transaction, chainId is REQUIRED (400 missing_chain without it). For payment intents " +
    "with no `from` or no proof, the response is PASS with structural_only:true and names what was not checked. " +
    "Optional caller-supplied checks: policy.sellerPayoutWallets binds payTo to the seller's payout addresses; " +
    "policy.obligation checks a local settled-key ledger and cumulative spend against a grant. The gate does not persist either state.",
  verify_arbitrage:
    "Ask verify402 whether a cross-venue arbitrage opportunity is REAL, right now. " +
    "Quotes come from Uniswap's canonical QuoterV2 and each DEX router at one pinned block. " +
    "The honest answer is usually 'no_edge' - that IS the product. Costs $0.05 per call.",
  check_token_safety:
    "Ask verify402 for a quote-based sellability check on a token BEFORE the agent risks capital. " +
    "Returns TRUST/CAUTION/AVOID with evidence: live contract facts, market liquidity, " +
    "a USD-sized sell QUOTED through the configured venues' own routers (direct and WETH-routed), " +
    "round-trip cost at your intended size, and phantom-price detection. It does NOT execute or " +
    "simulate a transfer: transfer tax, blacklist, pause, and max-tx restrictions are listed in " +
    "notChecked, not tested. Unconfigured venues are also named in notChecked. Costs $0.10 per call.",
  get_best_route:
    "Ask verify402 what the chain would ACTUALLY pay for a swap: the full book from every " +
    "configured venue (direct and WETH-routed) at one pinned block, best first. Aggregators and " +
    "unconfigured DEXs are not included. Costs $0.03 per call.",
  verify_quote_fairness:
    "Audit a swap quote someone else gave you (aggregator, broker, bot) BEFORE signing. " +
    "Returns fair / overpaying / too_good_to_be_true with the configured-venue book as evidence. " +
    "Ask this before accepting ANY number you did not produce yourself. Costs $0.05 per call.",
  get_trade_depth:
    "Position sizing: measure how much of a token the chain ACTUALLY lets you trade - " +
    "entry and exit across every configured venue at a ladder of USD sizes, per-size impact and " +
    "round-trip cost, plus the largest size under your cost tolerance. Ask BEFORE choosing " +
    "a position size. Costs $0.05 per call.",
};

async function main() {
  const paidApi = PAID_ENABLED ? await createBridgePaidClient() : null;

  const server = new McpServer({ name: "verify402", version: VERSION });

  server.tool(
    "preflight_gate",
    DESCRIPTIONS.preflight_gate,
    {
      kind: z.enum(["payment", "transaction"]).describe("payment = an x402 402 challenge; transaction = a chain transaction"),
      chainId: z.number().optional().describe("EVM chain id: 1 Ethereum, 42161 Arbitrum, 8453 Base. For payment, cross-checks the network."),
      from: z.string().optional().describe("The wallet that will sign. Strongly recommended: enables simulation and balance checks."),
      payment: z.object({
        scheme: z.string().optional().describe('x402 scheme, normally "exact"'),
        network: z.string().describe('CAIP-2 network, e.g. "eip155:84532" for the public demo or "solana:..."'),
        asset: z.string().describe("Token address or mint, e.g. canonical USDC on that network"),
        amount: z.string().describe("RAW amount in the asset's smallest unit, as a string"),
        payTo: z.string().describe("Recipient address from the 402 challenge"),
        resource: z.string().optional().describe("The resource URL the payment is for"),
        idempotencyKey: z.string().max(256).optional().describe("Caller-local payment idempotency key (not the paid-route x-idempotency-key header); enables the policy.obligation replay check"),
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
        allowedResourceHosts: z.array(z.string()).optional().describe("Bare hostnames allowed in payment.resource; a foreign host is BLOCK"),
        sellerPayoutWallets: z.array(z.string()).optional().describe("Caller-supplied seller payout addresses; a payTo mismatch is BLOCK. This is a binding, not independent ownership proof"),
        obligation: z.object({
          settledKeys: z.array(z.string()).optional().describe("Payment idempotency keys already settled"),
          spentUsd: z.number().nonnegative().optional().describe("Already spent under the grant, in USD"),
          grantUsd: z.number().nonnegative().optional().describe("Total grant in USD; spentUsd and grantUsd must be supplied together"),
        }).optional().describe("Caller-supplied local obligation state. The public gate does not persist it"),
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
            text: `preflight failed${status ? ` (${status})` : ""}: ${JSON.stringify(body ?? e.message)}. ${
              status === 503
                ? "No receipt was issued; stop and retry later."
                : "Do not sign without a verifiable receipt."
            }`,
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
      chainId: z.number().int().describe("REQUIRED. 1 Ethereum, 42161 Arbitrum, 8453 Base. There is no default; omitting it returns 400 missing_chain."),
      base: z.string().optional().describe('Token to trade from, e.g. "USDC" (default USDC)'),
      size: z.number().optional().describe("Trade size in whole base units, e.g. 100000 (default 100000)"),
    },
    async (args) => {
      const res = await runPaidTool({
        tool: "verify_arbitrage",
        client: paidApi,
        body: {
          chainId: args.chainId,
          target: String(args.target ?? "WETH").toUpperCase(),
          base: String(args.base ?? "USDC").toUpperCase(),
          size: args.size ?? 100000,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  server.tool(
    "check_token_safety",
    DESCRIPTIONS.check_token_safety,
    {
      tokenAddress: z.string().describe("ERC-20 contract address, or a known symbol like WETH"),
      chainId: z.number().int().describe("REQUIRED. 1 Ethereum, 42161 Arbitrum, 8453 Base. There is no default; omitting it returns 400 missing_chain."),
      intendedUsd: z.number().optional().describe("Size the agent plans to buy, in USD (default 500)"),
      offeredPriceUsd: z.number().optional().describe("Optional price per token someone offered you"),
    },
    async (args) => {
      const res = await runPaidTool({
        tool: "check_token_safety",
        client: paidApi,
        body: {
          chainId: args.chainId,
          tokenAddress: String(args.tokenAddress ?? "").trim(),
          intendedUsd: args.intendedUsd ?? 500,
          offeredPriceUsd: args.offeredPriceUsd ?? null,
        },
      });
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
      chainId: z.number().int().describe("REQUIRED. 1 Ethereum, 42161 Arbitrum, 8453 Base. There is no default; omitting it returns 400 missing_chain."),
    },
    async (args) => {
      const res = await runPaidTool({
        tool: "get_best_route",
        client: paidApi,
        body: {
          chainId: args.chainId,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
        },
      });
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
      chainId: z.number().int().describe("REQUIRED. 1 Ethereum, 42161 Arbitrum, 8453 Base. There is no default; omitting it returns 400 missing_chain."),
    },
    async (args) => {
      const res = await runPaidTool({
        tool: "verify_quote_fairness",
        client: paidApi,
        body: {
          chainId: args.chainId,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
          quotedOut: args.quotedOut,
          venueClaimed: args.venueClaimed ?? null,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  server.tool(
    "get_trade_depth",
    DESCRIPTIONS.get_trade_depth,
    {
      tokenAddress: z.string().describe("Token you plan to buy (symbol or 0x address)"),
      chainId: z.number().int().describe("REQUIRED. 1 Ethereum, 42161 Arbitrum, 8453 Base. There is no default; omitting it returns 400 missing_chain."),
      baseSymbol: z.string().optional().describe("What you pay with (default USDC)"),
      sizesUsd: z.array(z.number()).optional().describe("Ladder of sizes in USD, max 6 (default 100, 1000, 10000, 100000)"),
      maxRoundTripPct: z.number().optional().describe("Your round-trip cost tolerance, default 1%"),
    },
    async (args) => {
      const res = await runPaidTool({
        tool: "get_trade_depth",
        client: paidApi,
        body: {
          chainId: args.chainId,
          tokenAddress: args.tokenAddress,
          baseSymbol: args.baseSymbol ?? "USDC",
          sizesUsd: args.sizesUsd ?? null,
          maxRoundTripPct: args.maxRoundTripPct ?? 1.0,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );
  } // end paid tools

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo(
    paidApi
      ? `verify402 MCP bridge connected -> ${SERVER_URL} (paid tools on, max payment $${MAX_PAYMENT_USD})`
      : `verify402 MCP bridge connected -> ${SERVER_URL} (free preflight_gate only; set EVM_PRIVATE_KEY for paid tools)`,
  );
}

// True only when this file is the process entry point. The published package
// is installed through a `bin` symlink, so both sides are compared by real
// path: Node resolves import.meta.url through the symlink but keeps the
// symlink path in process.argv[1].
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (IS_MAIN) {
  main().catch((e) => {
    logError("bridge failed", e);
    process.exit(1);
  });
}
