// Long-tail pair intel from Dexscreener's free, keyless API.
//
// This layer makes the pre-trade gate work for ARBITRARY tokens - not just the
// six in our registry. Dexscreener indexes every DEX pair on every chain and
// returns liquidity, volume and pair metadata with no key. The long tail lives
// here, and the long tail is where honeypots live.
//
// Division of labour with the rest of the service:
//   * on-chain probes (safety.mjs) say what the CHAIN will actually do
//   * dexscreener.mjs says what the MARKET looks like from the outside

const DS = "https://api.dexscreener.com";

// Dexscreener uses chain-id strings; ours are numeric CAIP ids.
const DS_CHAIN = { 1: "ethereum", 42161: "arbitrum", 8453: "base" };

async function j(url, timeoutMs = 12_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Dexscreener's view of this token on this chain: deepest pair, every DEX. */
export async function dexscreenerPair(chainId, tokenAddress) {
  if (!DS_CHAIN[chainId]) return null;
  const data = await j(`${DS}/latest/dex/tokens/${tokenAddress}`);
  if (!data?.pairs?.length) return null;

  const pairs = data.pairs.filter((p) => p.chainId === DS_CHAIN[chainId]);
  if (!pairs.length) return null;

  // Deepest pair wins - it is where an agent would actually trade.
  const best = [...pairs].sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  )[0];

  return {
    dex: best.dexId,
    pairAddress: best.pairAddress,
    priceUsd: best.priceUsd != null ? Number(best.priceUsd) : null,
    liquidityUsd: best.liquidity?.usd ?? null,
    volume24hUsd: best.volume?.h24 ?? null,
    buys24h: best.txns?.h24?.buys ?? null,
    sells24h: best.txns?.h24?.sells ?? null,
    priceChange24hPct: best.priceChange?.h24 ?? null,
    fdvUsd: best.fdv ?? null,
    pairCreatedAt: best.pairCreatedAt ?? null,
  };
}

/**
 * THE SCAM SIGNALS visible from one free call.
 *
 * These are properties honeypots share, measured rather than guessed:
 *   * tiny liquidity -> the "price" can be anything and exit slips enormously
 *   * almost no sells -> price is manufactured; sells may be disabled
 *
 * What is deliberately NOT here: a contract audit or a paid "safety score".
 * This is the free external half of the story. The sellability probe in
 * safety.mjs covers the part no external API can see - whether the chain
 * itself will let the position be exited.
 */
export function scamSignals(pair) {
  if (!pair) return ["token is not listed on any tracked DEX - zero market discovery"];
  const s = [];

  if (pair.liquidityUsd != null) {
    if (pair.liquidityUsd < 5_000) s.push(`only $${Math.round(pair.liquidityUsd)} of liquidity - exit will slip enormously`);
    else if (pair.liquidityUsd < 50_000) s.push(`thin pool: $${Math.round(pair.liquidityUsd)} total liquidity`);
  } else {
    s.push("no pool liquidity reported - unpriceable");
  }

  if (pair.buys24h != null && pair.sells24h != null) {
    const total = pair.buys24h + pair.sells24h;
    if (total === 0) s.push("zero transactions in 24h - dead market");
    else {
      const sellShare = pair.sells24h / total;
      if (sellShare < 0.05 && total > 20) {
        s.push(`only ${Math.round(sellShare * 100)}% of 24h transactions are sells - classic honeypot pattern (buyable, not sellable)`);
      }
      if (total < 5) s.push(`only ${total} transactions in 24h - no real market`);
    }
  }

  if (pair.priceChange24hPct != null && pair.priceChange24hPct > 500) {
    s.push(`+${Math.round(pair.priceChange24hPct)}% in 24h - price is being manufactured, not discovered`);
  }

  if (pair.pairCreatedAt) {
    const ageH = (Date.now() - new Date(pair.pairCreatedAt).getTime()) / 3_600_000;
    if (ageH < 24) s.push(`pair created ${ageH.toFixed(1)}h ago - brand new, no history to trust`);
  }

  return s;
}

/** Summarise the token for agents: one pair, one paragraph of facts. */
export async function tokenProfile(chainId, tokenAddress) {
  const pair = await dexscreenerPair(chainId, tokenAddress);
  return {
    pair,
    signals: scamSignals(pair),
    listed: pair !== null,
  };
}
