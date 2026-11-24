// Payment token registry.
//
// The gate's reference used to be "canonical USDC on a chain we know". That
// flagged legitimate dollar stables (USDT, DAI, USDG) as non-canonical and
// left a USD cap unenforceable for them, which reads as a false alarm on a
// real endpoint.
//
// This registry lists the tokens the gate recognizes per chain, with decimals.
// It covers the chains the gate already supports — it does not add chains.
//
// kind:
//   stable   — assumed $1 parity. The parity is ASSUMED, never verified here.
//   volatile — no parity. Only raw-unit facts are usable.
//
// Addresses were cross-checked against CoinGecko's per-chain token lists
// (https://tokens.coingecko.com/<chain>/all.json) on 2026-11-12, and the
// canonical USDC entries were cross-checked against the addresses already in
// config.mjs. On Solana the canonical USDC is the Circle-issued mint
// EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, not the bridged variants.
//
// Recognizing an address is not the same as trusting it: this file says "this
// address is the token it claims to be on this chain". The gate still reads
// nothing from the token contract, and the receipt still says so.

export const STABLE = "stable";
export const VOLATILE = "volatile";

const EVM_CHAINS = {
  "eip155:1": {
    name: "ethereum",
    tokens: {
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, kind: STABLE },
      "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18, kind: STABLE },
      "0xe343167631d89b6ffc58b88d6b7fb0228795491d": { symbol: "USDG", decimals: 6, kind: STABLE },
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:42161": {
    name: "arbitrum",
    tokens: {
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC.e", decimals: 6, kind: STABLE },
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6, kind: STABLE },
      "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18, kind: STABLE },
      "0x004b506865409877c9fa29bfb1eba929984b9bbc": { symbol: "USDG", decimals: 6, kind: STABLE },
      "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:8453": {
    name: "base",
    tokens: {
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": { symbol: "USDT", decimals: 6, kind: STABLE },
      "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", decimals: 18, kind: STABLE },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:84532": {
    name: "base-sepolia",
    tokens: {
      "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6, kind: STABLE },
    },
  },
  "eip155:11155111": {
    name: "ethereum-sepolia",
    tokens: {
      "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { symbol: "USDC", decimals: 6, kind: STABLE },
    },
  },
};

const SVM_CHAINS = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
    name: "solana-mainnet",
    tokens: {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6, kind: STABLE },
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6, kind: STABLE },
      "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": { symbol: "USDG", decimals: 6, kind: STABLE },
    },
  },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
    name: "solana-devnet",
    tokens: {
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { symbol: "USDC", decimals: 6, kind: STABLE },
    },
  },
};

export const TOKEN_REGISTRY = { ...EVM_CHAINS, ...SVM_CHAINS };

// The network id a parsed network maps to ("eip155:8453", "solana:<genesis>").
export function networkIdOf(net) {
  if (!net) return null;
  if (net.family === "evm" && net.chainId) return `eip155:${net.chainId}`;
  if (net.family === "svm" && net.genesis) return `solana:${net.genesis}`;
  return null;
}

export function registryFor(net) {
  const id = networkIdOf(net);
  if (!id) return null;
  return TOKEN_REGISTRY[id] || null;
}

// EVM addresses are compared case-insensitively; Solana mints are exact.
function assetKey(net, asset) {
  const value = String(asset ?? "").trim();
  if (!value) return null;
  if (net?.family === "evm") return value.toLowerCase();
  return value;
}

export function findToken(net, asset) {
  const entry = registryFor(net);
  if (!entry) return null;
  const key = assetKey(net, asset);
  if (!key) return null;
  const token = entry.tokens[key];
  if (!token) return null;
  return { symbol: token.symbol, decimals: token.decimals, kind: token.kind, address: key };
}

// The amount in dollars, for known dollar stables only. The parity is an
// assumption, so callers must say so.
export function assumedUsd(net, asset, rawAmount) {
  const token = findToken(net, asset);
  if (!token || token.kind !== STABLE) return null;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount)) return null;
  return amount / 10 ** token.decimals;
}

export function tokenLabel(net, asset) {
  const token = findToken(net, asset);
  if (token) return token.symbol;
  const value = String(asset ?? "");
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

// Every chain the registry knows about, for docs and the directory page.
export function knownNetworks() {
  return Object.entries(TOKEN_REGISTRY).map(([id, entry]) => ({
    id,
    name: entry.name,
    tokens: Object.values(entry.tokens).map((token) => token.symbol),
  }));
}
