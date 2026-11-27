// Chain, venue and token registry.
//
// Every address here is checked against live chain state by `npm test` (the
// engine refuses to report a venue it could not actually quote), because a
// hardcoded address that has drifted is the quietest way for a service like
// this to start lying.

import { HttpError } from "./errors.mjs";

export const CHAINS = {
  // ---------------------------------------------------------------- mainnet
  1: {
    name: "ethereum",
    viemChain: "mainnet",
    rpcEnv: "ETH_RPC_URL",
    rpcDefault: "https://ethereum-rpc.publicnode.com",
    // Tried in order when no paid endpoint is configured. Failover is cheap on
    // purpose: a throttled first provider must not eat the whole pair budget.
    rpcFallbacks: [
      "https://eth.drpc.org",
      "https://eth.merkle.io",
    ],
    // Canonical Uniswap V3 QuoterV2 on mainnet. An earlier edit swapped this
    // for 0x59b670e9... believing it was V2 - the all-venues-exist test then
    // showed THAT address has no bytecode and this one does. Verified live:
    // this is the deployed QuoterV2; do not "correct" it without on-chain
    // bytecode evidence.
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    // V2-style routers: getAmountsOut is exact and needs no reimplementation.
    v2Routers: [
      { label: "uniswap-v2", address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", feeBps: 30 },
      { label: "sushiswap", address: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", feeBps: 30 },
    ],
    v3Fees: [100, 500, 3000, 10000],
    tokens: {
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
      WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
      DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
      USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    },
    // Token used to price gas, and the venue that prices it.
    gasToken: "WETH",
    gasPricePool: { fee: 500 },
    flashLoanPremiumBps: 5, // Aave V3, 0.05%
  },

  // --------------------------------------------------------------- arbitrum
  42161: {
    name: "arbitrum",
    viemChain: "arbitrum",
    rpcEnv: "ARB_RPC_URL",
    rpcDefault: "https://arb1.arbitrum.io/rpc",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v2Routers: [
      { label: "uniswap-v2", address: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", feeBps: 30 },
      { label: "sushiswap", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", feeBps: 30 },
    ],
    v3Fees: [100, 500, 3000, 10000],
    tokens: {
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
      WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
      USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
      ARB: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
    },
    gasToken: "WETH",
    gasPricePool: { fee: 500 },
    flashLoanPremiumBps: 5,
  },

  // ------------------------------------------------------------------- base
  8453: {
    name: "base",
    viemChain: "base",
    rpcEnv: "BASE_RPC_URL",
    rpcDefault: "https://mainnet.base.org",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    v2Routers: [],
    v3Fees: [100, 500, 3000, 10000],
    tokens: {
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
      DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
    },
    gasToken: "WETH",
    gasPricePool: { fee: 500 },
    flashLoanPremiumBps: 5,
  },

  // ------------------------------------------- op, bnb, polygon, avalanche
  // Paid checks since 3.5.0 (before that, free gate only). Venue addresses
  // live in the private engine; these entries carry what the public server
  // validates: tokens, decimals and RPCs.
  10: {
    name: "optimism",
    viemChain: "optimism",
    rpcEnv: "OP_RPC_URL",
    rpcDefault: "https://mainnet.optimism.io",
    rpcFallbacks: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
    nativeSymbol: "ETH",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v2Routers: [],
    v3Fees: [100, 500, 3000, 10000],
    tokens: {
      USDC: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      OP: { address: "0x4200000000000000000000000000000000000042", decimals: 18 },
      USDT: { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
      WBTC: { address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8 },
    },
    gasToken: "WETH",
    gasPricePool: { fee: 500 },
    flashLoanPremiumBps: 5,
  },
  56: {
    name: "bnb",
    viemChain: "bsc",
    rpcEnv: "BSC_RPC_URL",
    rpcDefault: "https://bsc-dataseed.bnbchain.org",
    rpcFallbacks: ["https://56.rpc.thirdweb.com", "https://bsc.drpc.org"],
    nativeSymbol: "BNB",
    quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    v2Routers: [{ label: "pancake-v2", address: "0x10ED43C718714eb63d5aA57B78B54704E256024E", feeBps: 25 }],
    v3Fees: [100, 500, 3000, 10000],
    tokens: {
      // BNB Chain's USDC and USDT use 18 decimals.
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      WBNB: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
      BTCB: { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18 },
      ETH: { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 },
      CAKE: { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18 },
    },
    gasToken: "WBNB",
    gasPricePool: { fee: 500 },
    flashLoanPremiumBps: 5,
  },
  137: {
    name: "polygon",
    viemChain: "polygon",
    rpcEnv: "POLYGON_RPC_URL",
    rpcDefault: "https://polygon.drpc.org",
    rpcFallbacks: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
    nativeSymbol: "POL",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v2Routers: [{ label: "quickswap-v2", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", feeBps: 30 }],
    v3Fees: [100, 500, 3000, 10000],
    tokens: {
      USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      WPOL: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
      WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
      USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
      WBTC: { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8 },
    },
    gasToken: "WPOL",
    gasPricePool: { fee: 500 },
    flashLoanPremiumBps: 5,
  },
  43114: {
    name: "avalanche",
    viemChain: "avalanche",
    rpcEnv: "AVAX_RPC_URL",
    rpcDefault: "https://avalanche-c-chain-rpc.publicnode.com",
    rpcFallbacks: ["https://avalanche.drpc.org", "https://api.avax.network/ext/bc/C/rpc"],
    nativeSymbol: "AVAX",
    quoterV2: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
    v2Routers: [],
    v3Fees: [100, 500, 3000, 10000],
    tokens: {
      USDC: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
      WAVAX: { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", decimals: 18 },
      USDT: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
      "WETH.e": { address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", decimals: 18 },
      "BTC.b": { address: "0x152b9d0FdC40C096757F570A51E494bd4b943E50", decimals: 8 },
    },
    gasToken: "WAVAX",
    gasPricePool: { fee: 500 },
    flashLoanPremiumBps: 5,
  },
};

// Readiness-only chains. This is deliberately separate from CHAINS: /ready
// must be able to check the payment rail's chain (Base Sepolia) without making
// that chain a paid-route measurement venue. Adding a chain here does not
// grant it a quoter, tokens, or a route.
export const READINESS_CHAINS = Object.freeze({
  1: { name: "ethereum", viemChain: "mainnet", rpcEnv: "ETH_RPC_URL", rpcDefault: CHAINS[1].rpcDefault },
  42161: { name: "arbitrum", viemChain: "arbitrum", rpcEnv: "ARB_RPC_URL", rpcDefault: CHAINS[42161].rpcDefault },
  8453: { name: "base", viemChain: "base", rpcEnv: "BASE_RPC_URL", rpcDefault: CHAINS[8453].rpcDefault },
  84532: {
    name: "base-sepolia",
    viemChain: "baseSepolia",
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    rpcDefault: "https://sepolia.base.org",
  },
});

export function readinessChain(chainId) {
  const c = READINESS_CHAINS[chainId];
  if (!c) {
    throw new Error(
      `READY_CHAIN_ID ${chainId} is not a supported readiness chain; supported: ${Object.keys(READINESS_CHAINS).join(", ")}`,
    );
  }
  return c;
}

// Default trade size, in whole units of the base token.
export const DEFAULT_SIZE = 100_000;

// Gas a flash-loan two-leg arb actually burns. Deliberately generous: it is
// better to overstate cost and call a marginal opportunity dead than to call a
// dead one alive.
export const DEFAULT_GAS_UNITS = 320_000n;

// A round trip has to clear this (in base-token units) after costs to be
// reported as an edge. Zero means "must be profitable at all".
export const DEFAULT_MIN_NET = 0;

// Free-gate-only chains. The transaction preflight can read these (block,
// contract code, simulation), but they are NOT measurement venues: no quoter,
// no venues, no paid route accepts them. Kept apart from CHAINS on purpose,
// like READINESS_CHAINS, so adding a chain here never makes a paid route
// pretend to quote on it. RPCs and token addresses were checked by hand
// against live chain state when added (OP Mainnet 2026-11-26, the rest
// 2026-11-27).
export const GATE_CHAINS = Object.freeze({
  // More EVM chains the free gate reads. Checked by hand on 2026-11-27: each
  // RPC answered a block read,
  // a code read and an eth_call; failing public endpoints were left out.
  25: {
    name: "cronos", // Cronos
    viemChain: "cronos",
    rpcEnv: "CRONOS_RPC_URL",
    rpcDefault: "https://evm.cronos.org",
    rpcFallbacks: [
      "https://cronos.drpc.org",
      "https://cronos-evm-rpc.publicnode.com",
    ],
    nativeSymbol: "CRO",
  },
  100: {
    name: "gnosis", // Gnosis
    viemChain: "gnosis",
    rpcEnv: "GNOSIS_RPC_URL",
    rpcDefault: "https://gnosis-rpc.publicnode.com",
    rpcFallbacks: [
      "https://gnosis.drpc.org",
      "https://rpc.gnosischain.com",
    ],
    nativeSymbol: "XDAI",
  },
  130: {
    name: "unichain", // Unichain
    viemChain: "unichain",
    rpcEnv: "UNICHAIN_RPC_URL",
    rpcDefault: "https://unichain.drpc.org",
    rpcFallbacks: [
      "https://unichain-rpc.publicnode.com",
      "https://mainnet.unichain.org",
    ],
    nativeSymbol: "ETH",
  },
  143: {
    name: "monad", // Monad
    viemChain: "monad",
    rpcEnv: "MONAD_RPC_URL",
    rpcDefault: "https://rpc.monad.xyz",
    rpcFallbacks: [
      "https://monad-mainnet.drpc.org",
      "https://rpc1.monad.xyz",
    ],
    nativeSymbol: "MON",
  },
  146: {
    name: "sonic", // Sonic
    viemChain: "sonic",
    rpcEnv: "SONIC_RPC_URL",
    rpcDefault: "https://rpc.soniclabs.com",
    rpcFallbacks: [
      "https://sonic.drpc.org",
      "https://sonic-rpc.publicnode.com",
    ],
    nativeSymbol: "S",
  },
  324: {
    name: "zksync", // ZKsync Era
    viemChain: "zksync",
    rpcEnv: "ZKSYNC_RPC_URL",
    rpcDefault: "https://zksync.drpc.org",
    rpcFallbacks: [
      "https://mainnet.era.zksync.io",
    ],
    nativeSymbol: "ETH",
  },
  480: {
    name: "worldchain", // World Chain
    viemChain: "worldchain",
    rpcEnv: "WORLDCHAIN_RPC_URL",
    rpcDefault: "https://worldchain-mainnet.g.alchemy.com/public",
    rpcFallbacks: [],
    nativeSymbol: "ETH",
  },
  999: {
    name: "hyperevm", // HyperEVM
    viemChain: "hyperEvm",
    rpcEnv: "HYPEREVM_RPC_URL",
    rpcDefault: "https://hyperliquid.drpc.org",
    rpcFallbacks: [
      "https://rpc.hyperliquid.xyz/evm",
    ],
    nativeSymbol: "HYPE",
  },
  1868: {
    name: "soneium", // Soneium
    viemChain: "soneium",
    rpcEnv: "SONEIUM_RPC_URL",
    rpcDefault: "https://soneium.drpc.org",
    rpcFallbacks: [
      "https://soneium-rpc.publicnode.com",
      "https://rpc.soneium.org",
    ],
    nativeSymbol: "ETH",
  },
  4326: {
    name: "megaeth", // MegaETH
    viemChain: "megaeth",
    rpcEnv: "MEGAETH_RPC_URL",
    rpcDefault: "https://mainnet.megaeth.com/rpc",
    rpcFallbacks: [],
    nativeSymbol: "ETH",
  },
  4663: {
    name: "robinhood", // Robinhood Chain
    viemChain: "robinhood",
    rpcEnv: "ROBINHOOD_RPC_URL",
    rpcDefault: "https://rpc.mainnet.chain.robinhood.com",
    rpcFallbacks: [],
    nativeSymbol: "ETH",
  },
  5042: {
    name: "arc", // Arc
    viemChain: "arc",
    rpcEnv: "ARC_RPC_URL",
    rpcDefault: "https://rpc.quicknode.mainnet.arc.io",
    rpcFallbacks: [
      "https://rpc.blockdaemon.mainnet.arc.io",
      "https://rpc.drpc.mainnet.arc.io",
    ],
    nativeSymbol: "USDC",
  },
  9745: {
    name: "plasma", // Plasma
    viemChain: "plasma",
    rpcEnv: "PLASMA_RPC_URL",
    rpcDefault: "https://rpc.plasma.to",
    rpcFallbacks: [],
    nativeSymbol: "XPL",
  },
  57073: {
    name: "ink", // Ink
    viemChain: "ink",
    rpcEnv: "INK_RPC_URL",
    rpcDefault: "https://ink.drpc.org",
    rpcFallbacks: [
      "https://rpc-qnd.inkonchain.com",
      "https://rpc-gel.inkonchain.com",
    ],
    nativeSymbol: "ETH",
  },
  59144: {
    name: "linea", // Linea
    viemChain: "linea",
    rpcEnv: "LINEA_RPC_URL",
    rpcDefault: "https://linea-rpc.publicnode.com",
    rpcFallbacks: [
      "https://linea.drpc.org",
      "https://rpc.linea.build",
    ],
    nativeSymbol: "ETH",
  },
});

/** A chain the free transaction gate can read (measurement or gate-only), or null. */
export function gateChain(chainId) {
  return CHAINS[chainId] ?? GATE_CHAINS[chainId] ?? null;
}

/** Chain ids the free transaction gate accepts. */
export function gateChainIds() {
  return [...Object.keys(CHAINS), ...Object.keys(GATE_CHAINS)].map(Number);
}

export function chain(chainId) {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`unsupported chainId ${chainId}; supported: ${Object.keys(CHAINS).join(", ")}`);
  return c;
}

/**
 * Paid routes must name their chain. There is no silent Ethereum default: an
 * agent on Base or Arbitrum that omits chainId used to get an Ethereum answer.
 * Returns the numeric chain id or throws a typed 400.
 */
export function requireChainId(body) {
  const value = body?.chainId;
  if (value === undefined || value === null || value === "") {
    throw new HttpError(
      400,
      "missing_chain",
      `chainId is required; supported: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_chain", "chainId must be an integer JSON number");
  }
  if (!CHAINS[value]) {
    throw new HttpError(
      400,
      "unsupported_chain",
      `unsupported chainId ${value}; supported: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return value;
}

export function resolveToken(chainId, symbol) {
  const c = chain(chainId);
  const t = c.tokens[symbol];
  if (!t) throw new Error(`unknown token ${symbol} on ${c.name}; known: ${Object.keys(c.tokens).join(", ")}`);
  return t;
}
