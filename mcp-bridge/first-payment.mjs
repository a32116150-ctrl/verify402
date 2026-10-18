// first-payment.mjs — the "does the whole pipe actually move money?" script.
//
// Usage (from the mcp-bridge directory):
//   node first-payment.mjs
//
// Reads from .env (NEVER paste these into any chat):
//   EVM_PRIVATE_KEY   wallet key of the BUYER (must hold USDC on the network
//                     the service asks for — Base Sepolia for testnet mode,
//                     Base for mainnet mode)
//   VERIFY402_URL     default https://verify402.onrender.com
//   MAX_PAYMENT_USD   spend cap, default 0.25
//
// What it does: buys the answer to ONE /route question ($0.03), paying the
// exact-x402 price from the wallet above to the seller's payTo address,
// settled on-chain by the facilitator. It works identically in testnet and
// mainnet mode because the x402 client reads the network from the server's
// own 402 response.
//
// After a successful run: check the buyer wallet went down by $0.03 and the
// seller's payTo wallet went up — on basescan.org (Base Sepolia testnet or
// Base mainnet, per the settle response's network field).

import "dotenv/config";
import axios from "axios";
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.env.VERIFY402_URL || "https://verify402.onrender.com";
const MAX_PAYMENT_USD = Number(process.env.MAX_PAYMENT_USD || 0.25);

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("EVM_PRIVATE_KEY required in .env — the BUYER's wallet. Never paste it anywhere else.");
  process.exit(1);
}

const client = x402Client.fromConfig({
  schemes: [], // registered below — the 402 itself decides the network
  spendControls: { maxAmountPerPayment: `$${MAX_PAYMENT_USD}` },
});
client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY)));

const paid = wrapAxiosWithPayment(
  axios.create({ timeout: 180_000 }),
  client,
);

console.log(`asking ${SERVER_URL}/route — "what would the chain pay for \$1 of USDC→WETH?"\n`);

const res = await paid.post(`${SERVER_URL}/route`, {
  chainId: 1,
  tokenIn: "USDC",
  tokenOut: "WETH",
  amountIn: "1000000",
});

const body = res.data ?? {};
console.log("status:", res.status);
console.log("best route:", body.best?.venue ?? JSON.stringify(body).slice(0, 160));
const settle = res.headers["payment-response"];
if (settle) {
  try {
    const s = JSON.parse(Buffer.from(String(settle), "base64").toString());
    console.log("\n=== SETTLEMENT RECEIPT (full) ===");
    console.log(JSON.stringify(s, null, 2));
  } catch {
    console.log("\nraw payment-response header (base64):", String(settle).slice(0, 120));
  }
} else {
  console.log("\n(no payment-response header — check the body above)");
}
console.log("\nNow verify on the explorer: buyer wallet -$0.03, seller wallet +$0.03.");
process.exit(0);
