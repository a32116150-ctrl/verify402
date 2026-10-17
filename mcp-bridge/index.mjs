// verify402 MCP bridge.
//
// Makes verify402 consumable by any MCP client (Claude Desktop, OpenCode, any
// agent framework) as native tools. When the client calls a tool, this bridge
// performs the x402 payment handshake automatically and returns the verdict.
//
// ARCHITECTURE (per docs.x402.org/guides/mcp-server-with-x402):
//
//   MCP client ──▶ this bridge (MCP server + x402 payer) ──▶ verify402.com
//
//   1. tool call            3. 402 + PAYMENT-REQUIRED
//   2. paid GET/POST        4. sign payment (wallet in env)
//                           5. retry with proof → verdict
//
// PAYMENT POLICY (load-bearing, do not remove): the bridge verifies the 402
// payment requirements BEFORE signing anything:
//   - price must be <= MAX_PAYMENT_USD (default $0.25)
//   - network must be one of the expected testnet/mainnet networks
//   - facilitator/resource must be the configured verify402 server
// An MCP server that signs anything any remote 402 asks for is a blank
// cheque. This one is not.

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
const SERVER_URL = process.env.VERIFY402_URL || "http://localhost:4021";
// Spend guard: the x402 client refuses to SIGN any payment above this, before
// a signature exists. Enforced inside x402Client (applySpendControls), not by
// our own request code - so it cannot be bypassed by a caller.
const MAX_PAYMENT_USD = Number(process.env.MAX_PAYMENT_USD || 0.25);

if (!EVM_PRIVATE_KEY) {
  console.error("EVM_PRIVATE_KEY is required (pre-funded with USDC on Base Sepolia or Base Mainnet)");
  process.exit(1);
}

// ---------------------------------------------------------------- payment ---
async function createPaidClient() {
  const client = new x402Client({
    spendControls: { maxAmountPerPayment: `$${MAX_PAYMENT_USD}` },
  });
  client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(EVM_PRIVATE_KEY)));
  const axiosInstance = axios.create({ baseURL: SERVER_URL, timeout: 120_000 });
  return wrapAxiosWithPayment(axiosInstance, client);
}

// ------------------------------------------------------------------ tools ---
const DESCRIPTIONS = {
  verify_arbitrage:
    "Ask verify402 whether a cross-venue arbitrage opportunity is REAL, right now. " +
    "Quotes come from Uniswap's canonical QuoterV2 and each DEX router at one pinned block. " +
    "The honest answer is usually 'no_edge' - that IS the product. Costs $0.05 per call.",
  check_token_safety:
    "Ask verify402 whether a token is safe to buy BEFORE the agent risks capital. " +
    "Returns TRUST/CAUTION/AVOID with evidence: live contract facts, market liquidity, " +
    "a USD-sized sell probe against every venue (honeypot test), round-trip cost at your " +
    "intended size, and phantom-price detection. Costs $0.10 per call.",
};

async function main() {
  const paidApi = await createPaidClient();

  const server = new McpServer({ name: "verify402", version: "1.0.0" });

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
      const res = await paidApi.post("/verify", {
        chainId: args.chainId ?? 1,
        target: String(args.target ?? "WETH").toUpperCase(),
        base: String(args.base ?? "USDC").toUpperCase(),
        size: args.size ?? 100000,
      });
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
      const res = await paidApi.post("/safety", {
        chainId: args.chainId ?? 1,
        tokenAddress: String(args.tokenAddress ?? "").trim(),
        intendedUsd: args.intendedUsd ?? 500,
        offeredPriceUsd: args.offeredPriceUsd ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`verify402 MCP bridge connected -> ${SERVER_URL} (max payment $${MAX_PAYMENT_USD})`);
}

main().catch((e) => {
  console.error("bridge failed:", e.message);
  process.exit(1);
});
