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
//     (every configured venue, direct + WETH-routed, one pinned block)
//   * immediately sell the exact position back on the best route
//   * report the round-trip cost in percent and the effective price
//   * impact % is measured against the SMALLEST size's effective price -
//     stated, not hidden: it is the honest reference available from the
//     same block, and it is the venue's own math, not ours.
//
// The verdict an agent actually needs: the largest size on the ladder that
// still trades under the caller's round-trip tolerance (default 1%).
//
// Failure classification is shared with measure.mjs: a transport/decode
// failure aborts with ok:false and a 503; only no_pool/revert may produce an
// "unfillable / illiquid" rung.

import { chain, resolveToken } from "./config.mjs";
import { clientFor, quoteAllVenues, classifyQuoteError } from "./measure.mjs";
import { tokenFacts } from "./safety.mjs";
import { dexscreenerPair as realDexscreenerPair } from "./dexscreener.mjs";
import { paidHonesty, unconfiguredVenues } from "./honesty.mjs";

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

function failure(chainId, started, kind, checked, notes = []) {
  const honesty = paidHonesty("/depth", {
    checked: ["request validation", ...checked],
    notChecked: [
      kind === "transport"
        ? "market measurement did not run: the chain/provider could not be read"
        : "market measurement did not run: the provider returned undecodable data",
      unconfiguredVenues(chainId),
    ],
  });
  return {
    ok: false,
    kind,
    quote_status: "failed",
    unavailable_reason: kind,
    error: kind === "transport"
      ? "the chain could not be read, so no depth was measured"
      : "the provider returned data this service could not decode, so no depth was measured",
    token: { chainId },
    ladder: [],
    checked: honesty.checked,
    notChecked: honesty.notChecked,
    notes,
    elapsedMs: Date.now() - started,
  };
}

export async function depthProfile(chainId, {
  tokenAddress,      // target: symbol or 0x address
  baseSymbol = "USDC",
  sizesUsd = null,   // ladder in USD of base
  maxRoundTripPct = DEFAULT_TOLERANCE_PCT,
} = {}, { clientFactory = clientFor, dexscreenerPair = realDexscreenerPair } = {}) {
  const started = Date.now();
  const notes = [];
  const checked = [];

  let target;
  let base;
  try {
    target = resolveTokenArg(chainId, tokenAddress);
    base = resolveToken(chainId, String(baseSymbol).toUpperCase());
  } catch (e) {
    return {
      ok: false, kind: "bad_request", error: e.message, checked,
      notChecked: paidHonesty("/depth", { checked: ["request validation"] }).notChecked,
      notes,
    };
  }
  if (target.toLowerCase() === base.address.toLowerCase()) {
    return {
      ok: false, kind: "bad_request", error: "target and base are the same token", checked,
      notChecked: paidHonesty("/depth", { checked: ["request validation"] }).notChecked,
      notes,
    };
  }

  // The target must BE a token. Without this guard a non-token address could
  // produce "rungs" - the tests caught exactly that with the Aave pool address.
  checked.push("contract");
  const facts = await tokenFacts(chainId, target, { clientFactory });
  if (facts.ok === false && (facts.kind === "transport" || facts.kind === "decode")) {
    return failure(chainId, started, facts.kind, checked, notes);
  }
  if (!facts.ok) {
    return {
      ok: false, kind: facts.kind === "no_contract" ? "bad_request" : "no_pool",
      quote_status: facts.kind === "no_contract" ? null : "no_pool",
      unavailable_reason: facts.kind,
      error: facts.reason, checked,
      notChecked: paidHonesty("/depth", { checked }).notChecked,
      notes,
    };
  }

  const sizes = (sizesUsd && sizesUsd.length ? sizesUsd : DEFAULT_SIZES_USD)
    .map(Number)
    .filter((s) => Number.isFinite(s) && s > 0 && s <= 1_000_000)
    .sort((a, b) => a - b)
    .slice(0, 6);
  if (!sizes.length) {
    return {
      ok: false, kind: "bad_request",
      error: "sizes must be an array of positive numbers, each <= 1,000,000 USD",
      checked,
      notChecked: paidHonesty("/depth", { checked: ["request validation"] }).notChecked,
      notes,
    };
  }
  checked.push("size-ladder");

  // External reference for human-readable context (not used for measurement -
  // all impact math is effective-price against the smallest size, same block).
  let ds = null;
  try {
    ds = await dexscreenerPair(chainId, target);
  } catch {
    notes.push("external market context was unavailable; on-chain depth below still ran");
  }
  checked.push("market");

  const client = clientFactory(chainId);
  let blockNumber;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (e) {
    const c = classifyQuoteError(e);
    return failure(chainId, started, c.kind, checked, notes);
  }
  checked.push("book-sweeps");

  const ladder = [];
  let smallestEffective = null;
  let noPoolSeen = false;

  for (const sizeUsd of sizes) {
    const sizeRaw = BigInt(Math.max(1, Math.round(sizeUsd * 10 ** base.decimals)));

    const buy = await quoteAllVenues(client, chainId, {
      tokenIn: base.address, tokenOut: target, amountIn: sizeRaw, blockNumber,
      intermediates: ["WETH"],
    });
    if (buy.hard_failure) return failure(chainId, started, buy.hard_failure.kind, checked, notes);

    if (!buy.quoted.length) {
      noPoolSeen = true;
      ladder.push({
        sizeUsd, fillable: false,
        quote_status: "no_pool",
        unavailable_reason: "no_pool",
        note: "no configured venue fills this size for this token",
      });
      notes.push(`$${sizeUsd}: no configured venue could fill the entry - the pair is effectively illiquid at this size`);
      continue;
    }
    const bestBuy = buy.quoted[0];
    const got = bestBuy.amountOut;

    const sellBack = await quoteAllVenues(client, chainId, {
      tokenIn: target, tokenOut: base.address, amountIn: got, blockNumber,
      intermediates: ["WETH"],
    });
    if (sellBack.hard_failure) return failure(chainId, started, sellBack.hard_failure.kind, checked, notes);

    if (!sellBack.quoted.length) {
      noPoolSeen = true;
      ladder.push({
        sizeUsd, fillable: false,
        buyVenue: bestBuy.venue,
        quote_status: "no_pool",
        unavailable_reason: "no_pool",
        note: "entry exists but no configured venue would buy the position back - cannot exit",
      });
      notes.push(`$${sizeUsd}: entry fills (${bestBuy.venue}) but no configured venue would buy the exact position back - asymmetric liquidity, treat as unexitable`);
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
      quote_status: (buy.unavailable.length || sellBack.unavailable.length) ? "partial" : "ok",
      unavailable_reason: (buy.unavailable.length || sellBack.unavailable.length) ? "some_venues_no_pool" : null,
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

  const fillable = ladder.filter((r) => r.fillable).length;
  const quoteStatus = !fillable ? "no_pool" : noPoolSeen ? "partial" : "ok";
  const honesty = paidHonesty("/depth", {
    checked,
    notChecked: [unconfiguredVenues(chainId)],
  });

  return {
    ok: true,
    quote_status: quoteStatus,
    unavailable_reason: quoteStatus === "no_pool" ? "no_pool" : quoteStatus === "partial" ? "some_venues_no_pool" : null,
    token: { address: target, base: baseSymbol, chainId },
    blockNumber: Number(blockNumber),
    maxRoundTripPct,
    capacityUsd: capacity,
    ladder,
    checked: honesty.checked,
    notChecked: honesty.notChecked,
    notes,
    elapsedMs: Date.now() - started,
  };
}
