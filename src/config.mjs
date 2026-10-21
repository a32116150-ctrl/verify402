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
    rpcDefault: "https://eth.llamarpc.com",
    // Tried in order when no paid endpoint is configured. Failover is cheap on
    // purpose: a throttled first provider must not eat the whole pair budget.
    rpcFallbacks: [
      "https://eth.drpc.org",
      "https://eth.merkle.io",
      "https://ethereum-rpc.publicnode.com",
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
};

// Default trade size, in whole units of the base token.
export const DEFAULT_SIZE = 100_000;

// Gas a flash-loan two-leg arb actually burns. Deliberately generous: it is
// better to overstate cost and call a marginal opportunity dead than to call a
// dead one alive.
export const DEFAULT_GAS_UNITS = 320_000n;

// A round trip has to clear this (in base-token units) after costs to be
// reported as an edge. Zero means "must be profitable at all".
export const DEFAULT_MIN_NET = 0;

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
