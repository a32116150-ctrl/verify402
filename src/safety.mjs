// Judgement over measurement.
//
// measure.mjs answers "is there an edge". This file answers the question an
// agent actually asks before deploying capital: "should I trade this or not?"
//
// The unit of value is not a number - it is a verdict plus the evidence for it:
//
//   AVOID  : positively dangerous (cannot be exited, phantom price)
//   CAUTION: tradable, with a real stated cost or problem
//   TRUST  : every check passed
//
// Checks, in order, each one an on-chain call or a free external lookup:
//   1. contract exists and is an ERC-20          (tokenFacts)
//   2. the market exists at all                  (dexscreener)
//   3. a USD-sized sell can be quoted            (sellabilityProbe)  <- honeypot
//   4. the full position can be entered/exited   (round-trip haircut)
//   5. the price you were offered is the price
//      the chain actually pays                   (phantom price)

import { encodeFunctionData, decodeFunctionResult } from "viem";
import { chain, resolveToken } from "./config.mjs";
import { clientFor, quoteAllVenues } from "./measure.mjs";
import { dexscreenerPair, scamSignals } from "./dexscreener.mjs";

const ERC20_ABI = [
  {
    inputs: [], outputs: [{ type: "string" }], name: "symbol", stateMutability: "view", type: "function",
  },
  {
    inputs: [], outputs: [{ type: "string" }], name: "name", stateMutability: "view", type: "function",
  },
  {
    inputs: [], outputs: [{ type: "uint8" }], name: "decimals", stateMutability: "view", type: "function",
  },
  {
    inputs: [], outputs: [{ type: "uint256" }], name: "totalSupply", stateMutability: "view", type: "function",
  },
];

async function safeERC20Call(client, address, functionName, args = []) {
  try {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName, args });
    const raw = await client.call({ to: address, data });
    if (!raw?.data) return null;
    return decodeFunctionResult({ abi: ERC20_ABI, functionName, data: raw.data });
  } catch {
    return null;
  }
}

/** Everything the verdict needs from the token contract itself. */
export async function tokenFacts(chainId, tokenAddress) {
  const client = clientFor(chainId);

  const code = await client.getCode({ address: tokenAddress });
  if (!code || code === "0x") {
    return { ok: false, reason: `no contract code at ${tokenAddress} on chain ${chainId}` };
  }

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    safeERC20Call(client, tokenAddress, "name"),
    safeERC20Call(client, tokenAddress, "symbol"),
    safeERC20Call(client, tokenAddress, "decimals"),
    safeERC20Call(client, tokenAddress, "totalSupply"),
  ]);

  if (decimals === null || decimals === undefined) {
    return {
      ok: false,
      reason: "contract does not expose decimals() - not a compliant ERC-20, or not an ERC-20 at all",
    };
  }

  return {
    ok: true,
    address: tokenAddress,
    name: name ?? null,
    symbol: symbol ?? null,
    decimals: Number(decimals),
    totalSupply: totalSupply ? totalSupply.toString() : null,
  };
}

/**
 * THE HONEYPOT QUESTION, answered by doing the thing rather than asking a flag.
 *
 * If no venue can quote a sell of this token, it cannot be exited - which is
 * what "honeypot" means in practice, whatever the contract source claims.
 */
export async function sellabilityProbe(chainId, tokenAddress, probeUnits) {
  const client = clientFor(chainId);
  const c = chain(chainId);

  let decimals = null;
  if (probeUnits === null || probeUnits === undefined) {
    const d = await safeERC20Call(client, tokenAddress, "decimals");
    if (d === null || d === undefined) {
      return { ok: false, canSell: false, reason: "no decimals() - cannot size a probe; treat as untradeable" };
    }
    decimals = Number(d);
    // Fallback for direct callers: 0.5 of one whole token. USD-sized callers
    // pass `probeUnits` themselves, which is the honest way to probe.
    probeUnits = 10n ** BigInt(Math.max(0, decimals - 1));
  }

  const usdc = c.tokens.USDC;
  if (!usdc) return { ok: false, reason: "chain has no USDC configured" };

  const probe = await quoteAllVenues(client, chainId, {
    tokenIn: tokenAddress,
    tokenOut: usdc.address,
    amountIn: probeUnits,
    // Deep pairs are usually vs WETH; a direct-only probe would falsely call
    // well-behaved tokens "unexitable" (this happened with SHIB).
    intermediates: ["WETH"],
  });

  const quoted = probe.quoted.length > 0;
  return {
    ok: true,
    canSell: quoted,
    probedUnits: probeUnits.toString(),
    venuesThatQuote: probe.quoted.map((q) => q.venue),
    probeRealizedUsd: quoted ? Number(probe.quoted[0].amountOut) / 10 ** usdc.decimals : null,
    unavailable: probe.unavailable,
  };
}

/**
 * THE PRE-TRADE GATE. One paid call, made before an agent deploys capital.
 */
export async function preTradeCheck(chainId, {
  tokenAddress,
  intendedUsd = 500,
  offeredPriceUsd = null,
  baseSymbol = "USDC",
  probeUsd = 25,
} = {}) {
  const c = chain(chainId);
  const started = Date.now();

  const notes = [];
  const problems = [];
  const evidence = {};
  const checked = [];

  // --- 0. resolve the token: registry symbol or raw address ----------------
  let address = tokenAddress;
  let resolvedSymbol = null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(tokenAddress))) {
    try {
      const known = resolveToken(chainId, String(tokenAddress).toUpperCase());
      address = known.address;
      resolvedSymbol = String(tokenAddress).toUpperCase();
    } catch (e) {
      return {
        ok: false, verdict: "AVOID",
        token: { input: tokenAddress, chainId, chainName: c.name },
        reasons: [e.message], notes: [], checked, evidence, elapsedMs: Date.now() - started,
      };
    }
  }

  // --- 1. the token contract -------------------------------------------------
  const facts = await tokenFacts(chainId, address);
  checked.push("contract");

  if (!facts.ok) {
    return {
      ok: true, verdict: "AVOID",
      token: { input: tokenAddress, address, chainId, chainName: c.name },
      reasons: [facts.reason], notes, checked, evidence,
      elapsedMs: Date.now() - started,
    };
  }

  evidence.contract = {
    address, name: facts.name, symbol: facts.symbol,
    decimals: facts.decimals, totalSupply: facts.totalSupply,
  };

  // --- 2. does the market exist ----------------------------------------------
  const ds = await dexscreenerPair(chainId, address);
  checked.push("market");
  const priceUsd = ds?.priceUsd ?? null;
  evidence.market = ds;
  if (priceUsd != null) {
    notes.push(`market liquidity: $${Math.round(ds.liquidityUsd ?? 0)}, 24h volume: $${Math.round(ds.volume24hUsd ?? 0)}`);
  } else {
    notes.push("market: no dexscreener pair for this token on this chain");
  }

  // --- 3. sellability: honeypot question with USD-sized probes ----------------
  // "Prove half a token is sellable" was a bug that flagged SHIB - a $1B token
  // - as a honeypot. Half a SHIB is four thousandths of a cent, and every pool
  // correctly refuses to quote dust. Probes are USD-sized instead: the same
  // $25 question asked of a token at $0.00001 and a token at $4000.
  let sell;
  if (priceUsd != null && priceUsd > 0) {
    const units = BigInt(Math.max(1, Math.round((probeUsd / priceUsd) * 10 ** facts.decimals)));
    sell = await sellabilityProbe(chainId, address, units);
  } else {
    // No external price: fall back to a token-unit probe and say so.
    sell = await sellabilityProbe(chainId, address, null);
    sell.reason = "no external price to size a USD probe; probed 0.5 whole token instead";
  }
  checked.push("sellability");

  evidence.sellability = {
    canSell: sell.canSell,
    probedInUsd: priceUsd != null ? probeUsd : null,
    probedUnits: sell.probedUnits ?? null,
    venuesThatQuote: sell.venuesThatQuote ?? [],
    probeRealizedUsd: sell.probeRealizedUsd ?? null,
  };

  if (!sell.canSell) {
    problems.push(
      sell.reason
        ?? `even a $${probeUsd} sell could not be quoted by any venue on this chain - cannot be exited`
    );
  } else if (sell.probeRealizedUsd !== null && sell.probeRealizedUsd <= 0.000001) {
    problems.push(`a $${probeUsd} sell returned ~$${sell.probeRealizedUsd} - exit is effectively worthless`);
  } else {
    notes.push(`sellable via ${sell.venuesThatQuote.join(", ")}`);
  }

  // --- 4. the position itself: enter and exit at the intended size ------------
  if (sell.canSell) {
    const base = resolveToken(chainId, baseSymbol);
    const size = BigInt(Math.max(1, Math.round(intendedUsd * 10 ** base.decimals)));
    const client = clientFor(chainId);

    const buy = await quoteAllVenues(client, chainId, {
      tokenIn: base.address, tokenOut: address, amountIn: size, intermediates: ["WETH"],
    });

    if (!buy.quoted.length) {
      problems.push(`no venue could fill a $${intendedUsd} ${baseSymbol} entry - the pair is too thin to trade`);
    } else {
      const got = buy.quoted[0];
      const sellBack = await quoteAllVenues(client, chainId, {
        tokenIn: address, tokenOut: base.address, amountIn: got.amountOut, intermediates: ["WETH"],
      });

      if (!sellBack.quoted.length) {
        problems.push(`entered at the best venue but no venue would buy the exact position back at $${intendedUsd}`);
      } else {
        const out = sellBack.quoted[0].amountOut;
        const haircutPct = (Number(size - out) / Number(size)) * 100;
        evidence.liquidity = {
          intendedUsd,
          buyVenue: buy.quoted[0].venue,
          sellVenue: sellBack.quoted[0].venue,
          roundTripCostPct: haircutPct,
        };
        checked.push("liquidity");
        if (haircutPct > 10) {
          problems.push(`getting in and out of $${intendedUsd} costs ${haircutPct.toFixed(1)}% - the pool is too thin for this size`);
        } else {
          notes.push(`round trip in and out of $${intendedUsd} costs ${haircutPct.toFixed(2)}%`);
        }
      }
    }
  }

  // --- 5. price sanity: offered vs chain consensus ------------------------------
  if (offeredPriceUsd != null) {
    if (priceUsd == null) {
      notes.push("price offered but no chain-side price could be established - cannot sanity-check it");
    } else {
      evidence.price = { offered: offeredPriceUsd, chainConsensusPerToken: priceUsd };
      checked.push("price-sanity");

      if (offeredPriceUsd > priceUsd * 1.5) {
        problems.push(
          `offered $${offeredPriceUsd} per token is >50% above the chain's consensus ($${priceUsd.toPrecision(6)}) - a phantom price`
        );
      } else {
        notes.push(`offered price is within 50% of chain consensus ($${priceUsd.toPrecision(6)}/token)`);
      }
    }
  }

  // --- 6. scam signals from the market data ------------------------------------
  // Liquidity, volume, and sell-share: the properties honeypots share that an
  // honest contract plus a manufactured price cannot hide.
  const signals = scamSignals(ds);
  if (signals.length) {
    problems.push(...signals.map((s) => `market signal: ${s}`));
  } else {
    notes.push("no scam signals in the market data");
  }

  return {
    ok: true,
    verdict: !sell.canSell ? "AVOID" : problems.length > 0 ? "CAUTION" : "TRUST",
    token: {
      input: tokenAddress,
      address,
      chainId,
      chainName: c.name,
      name: facts.name,
      symbol: facts.symbol,
      decimals: facts.decimals,
    },
    reasons: problems,
    notes,
    checked,
    evidence,
    elapsedMs: Date.now() - started,
  };
}
