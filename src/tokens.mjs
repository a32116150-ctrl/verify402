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
  // OP Mainnet: transaction gate only (no x402 payment rail, no paid routes).
  "eip155:10": {
    name: "optimism",
    gateOnly: true,
    tokens: {
      "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x7f5c764cbc14f9669b88837ca1490cca17c31607": { symbol: "USDC.e", decimals: 6, kind: STABLE },
      "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { symbol: "USDT", decimals: 6, kind: STABLE },
      "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18, kind: STABLE },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  // Gate-only chains added 2026-11-27. Every address was read on-chain
  // (symbol and decimals). Stable means a dollar coin; the $1 parity is an
  // assumption, as for every stable here.
  "eip155:25": {
    name: "cronos",
    gateOnly: true,
    tokens: {
      "0xc21223249ca28397b4b6541dffaecc539bff0c59": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x66e428c3f67a68878562e79a0234c1f83c208770": { symbol: "USDT", decimals: 6, kind: STABLE },
      "0x5c7f8a570d578ed84e63fdfa7b1ee72deae1ae23": { symbol: "WCRO", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:56": {
    name: "bnb",
    gateOnly: true,
    tokens: {
      "0x55d398326f99059ff775485246999027b3197955": { symbol: "USDT", decimals: 18, kind: STABLE },
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { symbol: "USDC", decimals: 18, kind: STABLE },
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": { symbol: "WBNB", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:100": {
    name: "gnosis",
    gateOnly: true,
    tokens: {
      "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d": { symbol: "WXDAI", decimals: 18, kind: STABLE },
      "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0": { symbol: "USDC.e", decimals: 6, kind: STABLE },
      "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x4ecaba5870353805a9f068101a40e0f32ed605c6": { symbol: "USDT", decimals: 6, kind: STABLE },
    },
  },
  "eip155:130": {
    name: "unichain",
    gateOnly: true,
    tokens: {
      "0x078d782b760474a361dda0af3839290b0ef57ad6": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:137": {
    name: "polygon",
    gateOnly: true,
    tokens: {
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC.e", decimals: 6, kind: STABLE },
      "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT0", decimals: 6, kind: STABLE },
      "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { symbol: "WPOL", decimals: 18, kind: VOLATILE },
      "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:143": {
    name: "monad",
    gateOnly: true,
    tokens: {
      "0x754704bc059f8c67012fed69bc8a327a5aafb603": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": { symbol: "WMON", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:146": {
    name: "sonic",
    gateOnly: true,
    tokens: {
      "0x29219dd400f2bf60e5a23d13be72b486d4038894": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38": { symbol: "wS", decimals: 18, kind: VOLATILE },
      "0x50c42deacd8fc9773493ed674b675be577f2634b": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:324": {
    name: "zksync",
    gateOnly: true,
    tokens: {
      "0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4": { symbol: "USDC.e", decimals: 6, kind: STABLE },
      "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x493257fd37edb34451f62edf8d2a0c418852ba4c": { symbol: "USDT", decimals: 6, kind: STABLE },
      "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:480": {
    name: "worldchain",
    gateOnly: true,
    tokens: {
      "0x79a02482a880bce3f13e09da970dc34db4cd24d1": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:999": {
    name: "hyperevm",
    gateOnly: true,
    tokens: {
      "0xb88339cb7199b77e23db6e890353e22632ba630f": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": { symbol: "USDT0", decimals: 6, kind: STABLE },
      "0x5555555555555555555555555555555555555555": { symbol: "WHYPE", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:1868": {
    name: "soneium",
    gateOnly: true,
    tokens: {
      "0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369": { symbol: "USDC.e", decimals: 6, kind: STABLE },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:4326": {
    name: "megaeth",
    gateOnly: true,
    tokens: {
      "0xfafddbb3fc7688494971a79cc65dca3ef82079e7": { symbol: "USDm", decimals: 18, kind: STABLE },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:4663": {
    name: "robinhood",
    gateOnly: true,
    tokens: {
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { symbol: "USDG", decimals: 6, kind: STABLE },
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:5042": {
    name: "arc",
    gateOnly: true,
    tokens: {
      "0x3600000000000000000000000000000000000000": { symbol: "USDC", decimals: 6, kind: STABLE },
    },
  },
  "eip155:9745": {
    name: "plasma",
    gateOnly: true,
    tokens: {
      "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": { symbol: "USDT0", decimals: 6, kind: STABLE },
      "0x6100e367285b01f48d07953803a2d8dca5d19873": { symbol: "WXPL", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:43114": {
    name: "avalanche",
    gateOnly: true,
    tokens: {
      "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": { symbol: "USDt", decimals: 6, kind: STABLE },
      "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7": { symbol: "WAVAX", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:57073": {
    name: "ink",
    gateOnly: true,
    tokens: {
      "0x2d270e6886d130d724215a266106e6832161eaed": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0x0200c29006150606b650577bbe7b6248f58470c1": { symbol: "USDT0", decimals: 6, kind: STABLE },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, kind: VOLATILE },
    },
  },
  "eip155:59144": {
    name: "linea",
    gateOnly: true,
    tokens: {
      "0x176211869ca2b568f2a7d4ee941e073a821ee1ff": { symbol: "USDC", decimals: 6, kind: STABLE },
      "0xa219439258ca9da29e9cc4ce5596924745e12b93": { symbol: "USDT", decimals: 6, kind: STABLE },
      "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f": { symbol: "WETH", decimals: 18, kind: VOLATILE },
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

// Every payment network the registry knows about, for docs and the directory
// page. Gate-only chains (tokens named in transaction previews, but no 402
// payment rail) are left out so they are not advertised as payment networks.
export function knownNetworks() {
  return Object.entries(TOKEN_REGISTRY).filter(([, entry]) => !entry.gateOnly).map(([id, entry]) => ({
    id,
    name: entry.name,
    tokens: Object.values(entry.tokens).map((token) => token.symbol),
  }));
}
