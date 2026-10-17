// Depth / capacity: "how much can I actually trade at this venue pair
// before the round trip eats me?"
//
// This is the question an agent must answer BEFORE it picks a size, and
// nothing on-chain exposes it. Most "liquidity" figures agents see are pool
// reserves in dollars - which is not the same as what a real block will
// give you for $10,000. The difference between the two is exactly the cost
// agents discover too late, on-chain, as realized losses.
//
// Method (same discipline as the rest of this service):
//   * for each size in the ladder, buy target with the chain's best route
//     (every venue, direct + WETH-routed, one pinned block)
//   * immediately sell the exact position back on the best route
//   * report the round-trip cost in percent and the effective price
//   * impact % is measured against the SMALLEST size's effective price -
//     stated, not hidden: it is the honest reference available from the
//     same block, and it is the venue's own math, not ours.
//
// The verdict an agent actually needs: the largest size on the ladder that
// still trades under the caller's round-trip tolerance (default 1%).

import { chain, resolveToken } from "./config.mjs";
import { clientFor, quoteAllVenues } from "./measure.mjs";
import { tokenFacts } from "./safety.mjs";
import { dexscreenerPair } from "./dexscreener.mjs";

// Local helper so the human "gotTokens / impliedPriceUsd" figures are right
// without duplicating the chain config here.
function chainTokenDecimals(chainId, address) {
  try {
    const c = chain(chainId);
    const hit = Object.values(c.tokens).find((t) => t.address.toLowerCase() === address.toLowerCase());
    return hit ? hit.decimals : null;
  } catch {
    return null;
  }
}

const DEFAULT_SIZES_USD = [100, 1_000, 10_000, 100_000];
const DEFAULT_TOLERANCE_PCT = 1.0;

function resolveTokenArg(chainId, arg) {
  const raw = String(arg).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw;
  return resolveToken(chainId, raw.toUpperCase()).address;
}

export async function depthProfile(chainId, {
  tokenAddress,      // target: symbol or 0x address
  baseSymbol = "USDC",
  sizesUsd = null,   // ladder in USD of base
  maxRoundTripPct = DEFAULT_TOLERANCE_PCT,
} = {}) {
  const started = Date.now();
  const notes = [];
  const checked = [];

  let target;
  let base;
  try {
    target = resolveTokenArg(chainId, tokenAddress);
    base = resolveToken(chainId, String(baseSymbol).toUpperCase());
  } catch (e) {
    return { ok: false, error: e.message, checked, notes };
  }
  if (target.toLowerCase() === base.address.toLowerCase()) {
    return { ok: false, error: "target and base are the same token", checked, notes };
  }

  // The target must BE a token. Without this guard a non-token address could
  // produce "rungs" - the tests caught exactly that with the Aave pool address.
  checked.push("contract");
  const facts = await tokenFacts(chainId, target);
  if (!facts.ok) {
    return { ok: false, error: facts.reason, checked, notes };
  }

  const sizes = (sizesUsd && sizesUsd.length ? sizesUsd : DEFAULT_SIZES_USD)
    .map(Number)
    .filter((s) => Number.isFinite(s) && s > 0 && s <= 1_000_000)
    .sort((a, b) => a - b)
    .slice(0, 6);
  if (!sizes.length) {
    return { ok: false, error: "sizes must be an array of positive numbers, each <= 1,000,000 USD", checked, notes };
  }
  checked.push("size-ladder");

  // External reference for human-readable context (not used for measurement -
  // all impact math is effective-price against the smallest size, same block).
  const ds = await dexscreenerPair(chainId, target);
  checked.push("market");

  const client = clientFor(chainId);
  const blockNumber = await client.getBlockNumber();
  checked.push("book-sweeps");

  const ladder = [];
  let smallestEffective = null;

  for (const sizeUsd of sizes) {
    const sizeRaw = BigInt(Math.max(1, Math.round(sizeUsd * 10 ** base.decimals)));

    const buy = await quoteAllVenues(client, chainId, {
      tokenIn: base.address, tokenOut: target, amountIn: sizeRaw, blockNumber,
      intermediates: ["WETH"],
    });

    if (!buy.quoted.length) {
      ladder.push({ sizeUsd, fillable: false, note: "no venue fills this size for this token" });
      notes.push(`$${sizeUsd}: no venue could fill the entry - the pair is effectively illiquid at this size`);
      continue;
    }
    const bestBuy = buy.quoted[0];
    const got = bestBuy.amountOut;

    const sellBack = await quoteAllVenues(client, chainId, {
      tokenIn: target, tokenOut: base.address, amountIn: got, blockNumber,
      intermediates: ["WETH"],
    });

    if (!sellBack.quoted.length) {
      ladder.push({
        sizeUsd, fillable: false,
        buyVenue: bestBuy.venue,
        note: "entry exists but no venue would buy the position back - cannot exit",
      });
      notes.push(`$${sizeUsd}: entry fills (${bestBuy.venue}) but no venue would buy the exact position back - asymmetric liquidity, treat as unexitable`);
      continue;
    }
    const bestSell = sellBack.quoted[0];
    const exitRaw = bestSell.amountOut;

    // Effective reference price: tokens bought per 1 unit of base.
    const effective = Number(got) / Number(sizeRaw);
    if (smallestEffective === null) smallestEffective = effective;

    const entryHuman = Number(sizeRaw) / 10 ** base.decimals;
    const exitHuman = Number(exitRaw) / 10 ** base.decimals;
    const roundTripCostPct = ((entryHuman - exitHuman) / entryHuman) * 100;
    const impactPct = smallestEffective > 0 ? Math.max(0, (1 - effective / smallestEffective) * 100) : null;

    ladder.push({
      sizeUsd,
      fillable: true,
      buyVenue: bestBuy.venue,
      sellVenue: bestSell.venue,
      gotTokens: Number(got) / 10 ** (chainTokenDecimals(chainId, target) ?? 18),
      impliedPriceUsd: base.decimals >= 0
        ? (sizeUsd) / (Number(got) / 10 ** (chainTokenDecimals(chainId, target) ?? 18))
        : null,
      impactPct,
      roundTripCostPct,
      underTolerance: roundTripCostPct <= maxRoundTripPct,
    });
  }

  // Cap: largest fillable rung under the round-trip tolerance.
  const usable = ladder.filter((r) => r.fillable && r.underTolerance);
  const capacity = usable.length ? usable[usable.length - 1].sizeUsd : 0;
  notes.push(
    capacity > 0
      ? `largest size with round-trip cost <= ${maxRoundTripPct}%: $${capacity.toLocaleString()}`
      : `NOT EVEN THE SMALLEST RUNG stays under a ${maxRoundTripPct}% round trip - this pair is effectively untradeable for a cost-aware agent`
  );
  if (ds) {
    notes.push(`market context: $${Math.round(ds.liquidityUsd ?? 0)} liquidity, $${Math.round(ds.volume24hUsd ?? 0)} 24h volume (dexscreener)`);
  }

  return {
    ok: true,
    token: { address: target, base: baseSymbol, chainId },
    blockNumber: Number(blockNumber),
    maxRoundTripPct,
    capacityUsd: capacity,
    ladder,
    checked,
    notes,
    elapsedMs: Date.now() - started,
  };
}

