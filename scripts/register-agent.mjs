// ERC-8004 identity registration for verify402.
//
// Mints the agent NFT on the canonical Identity Registry (Base Sepolia by
// default) with an agentURI that is a base64 data: URI - the ENTIRE
// registration file lives on-chain, no IPFS pinning, no external hosting to
// rot.
//
// The private key that signs this is the OWNER's; it is read from .env only
// and never logged or shipped anywhere else.
//
//   PRIVATE_KEY=0x...            # wallet paying gas (Base Sepolia ETH)
//   AGENT_URL=https://...        # public URL of the deployed service
//   CHAIN=base-sepolia|base      # default base-sepolia
//   npm run register
//
// Registries (from github.com/erc-8004/erc-8004-contracts, the curated
// deployments; verify against the explorer link after running):
//   base-sepolia Identity: 0x8004A818BFB912233c491871b3d84c89A494BD9e
//   base        Identity: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432

import { config } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const REGISTRIES = {
  "base-sepolia": {
    chain: baseSepolia,
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    explorer: "https://sepolia.basescan.org",
  },
  base: {
    chain: base,
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    explorer: "https://basescan.org",
  },
};

const CHAIN = process.env.CHAIN || "base-sepolia";
const r = REGISTRIES[CHAIN];
if (!r) {
  console.error(`unknown CHAIN ${CHAIN}; use ${Object.keys(REGISTRIES).join(" or ")}`);
  process.exit(1);
}

const KEY = process.env.PRIVATE_KEY;
if (!KEY) {
  console.error("PRIVATE_KEY is required (the owner's wallet, in .env - never paste into chat)");
  process.exit(1);
}
const AGENT_URL = process.env.AGENT_URL;
if (!AGENT_URL) {
  console.error("AGENT_URL is required - the public https:// URL of the deployed service");
  process.exit(1);
}
if (!/^https:\/\//.test(AGENT_URL)) {
  console.error("AGENT_URL must be https - this URI goes on-chain permanently");
  process.exit(1);
}

const account = privateKeyToAccount(KEY);
const client = createPublicClient({ chain: r.chain, transport: http() });
const wallet = createWalletClient({ chain: r.chain, transport: http(), account });

const registration = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "verify402",
  description:
    "Machine-payable truth service for AI agents. POST /verify measures whether a claimed " +
    "cross-venue arbitrage is real (pinned-block quotes from Uniswap QuoterV2 and each " +
    "router's own math; the honest answer is usually no_edge). POST /safety is a pre-trade " +
    "gate: contract facts, market liquidity and scam signals, and a quote-based sellability " +
    "check across the configured venues (it asks quoters for a price; it does not execute a " +
    "transfer). It does not check unconfigured venues, transfer tax, blacklist, pause, or " +
    "max-transaction restrictions. TRUST / CAUTION / AVOID with evidence. " +
    "Payment per call via x402 (USDC, Base or Solana). No profitability is ever promised; " +
    "the service reports what it measured.",
  image: `${AGENT_URL}/agent-icon.svg`,
  services: [
    { name: "web", endpoint: AGENT_URL },
    { name: "x402", endpoint: `${AGENT_URL}/verify`, version: "x402" },
    { name: "x402", endpoint: `${AGENT_URL}/safety`, version: "x402" },
    { name: "MCP", endpoint: "https://github.com/your-repo/tree/main/mcp-bridge", version: "stdio" },
  ],
  x402Support: true,
  active: true,
  supportedTrust: ["reputation"],
};

const dataUri =
  "data:application/json;base64," +
  Buffer.from(JSON.stringify(registration, null, 2)).toString("base64");

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) external returns (uint256 agentId)",
  "function nextTokenId() external view returns (uint256)",
]);

// Human confirmation before an irreversible on-chain write.
console.log(`\nchain      : ${CHAIN}`);
console.log(`registry   : ${r.identity}`);
console.log(`pay from   : ${account.address}`);
console.log(`agent url  : ${AGENT_URL}`);
console.log(`uri size   : ${dataUri.length} bytes (data URI, fully on-chain)`);

const balance = await client.getBalance({ address: account.address });
console.log(`gas balance: ${Number(balance) / 1e18} ETH`);
if (balance === 0n) {
  console.error("\nwallet has no gas. Fund it with testnet ETH first:");
  console.error(`  ${r.explorer} - use a Base Sepolia faucet, e.g. https://www.coinbase.com/faucets/base-eth-sepolia`);
  process.exit(1);
}

if (process.env.CONFIRM !== "yes") {
  console.error("\nThis mints an NFT permanently on-chain. Re-run with CONFIRM=yes to proceed.");
  process.exit(1);
}

const hash = await wallet.sendTransaction({
  to: r.identity,
  data: encodeFunctionData({ abi: IDENTITY_ABI, functionName: "register", args: [dataUri] }),
});

console.log(`\ntx sent: ${hash}`);
console.log(`track it: ${r.explorer}/tx/${hash}`);
console.log("\nAfter 1 confirmation, the agent is discoverable via ERC-8004.");
console.log("Register on-chain reputation later via the ReputationRegistry once buyers exist.");
