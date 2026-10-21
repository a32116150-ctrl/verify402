// Judgement over measurement.
//
// measure.mjs answers "is there an edge". This file answers the question an
// agent actually asks before deploying capital: "should I trade this or not?"
//
// The unit of value is not a number - it is a verdict plus the evidence for it:
//
//   AVOID  : positively dangerous (no configured venue can quote an exit,
//            phantom price, or the contract is not a token)
//   CAUTION: tradable, with a real stated cost or problem
//   TRUST  : every check that ran passed
//
// Checks, in order, each one an on-chain call or a free external lookup:
//   1. contract exists and is an ERC-20          (tokenFacts)
//   2. the market exists at all                  (dexscreener)
//   3. a USD-sized sell can be QUOTED            (quote-based sellability)
//   4. the full position can be entered/exited   (round-trip haircut)
//   5. the price you were offered is the price
//      the chain actually pays                   (phantom price)
//
// IMPORTANT, and stated in every response: step 3 asks quoters for a price. It
// does not execute or simulate a transfer. A token that quotes but reverts on
// transfer is still reported as quoteable, and `notChecked` says so. This is a
// quote-based sellability check, not a honeypot proof.

import { encodeFunctionData, decodeFunctionResult } from "viem";
import { chain, resolveToken } from "./config.mjs";
import { clientFor, quoteAllVenues, classifyQuoteError, isHardQuoteFailure } from "./measure.mjs";
import { dexscreenerPair as realDexscreenerPair, scamSignals } from "./dexscreener.mjs";
import { paidHonesty, unconfiguredVenues } from "./honesty.mjs";

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
    if (!raw?.data || raw.data === "0x") {
      return { ok: false, kind: "malformed_metadata", detail: "empty data" };
    }
    try {
      return { ok: true, value: decodeFunctionResult({ abi: ERC20_ABI, functionName, data: raw.data }) };
    } catch (e) {
      return { ok: false, kind: "malformed_metadata", detail: e?.message || String(e) };
    }
  } catch (e) {
    const c = classifyQuoteError(e);
    // A revert on a metadata getter means the contract does not implement the
    // ERC-20 method. It is not a chain outage. A transport/decode failure is.
    return {
      ok: false,
      kind: c.kind === "revert" ? "malformed_metadata" : c.kind,
      detail: c.detail,
      reason: c.reason ?? null,
    };
  }
}

/** Everything the verdict needs from the token contract itself. */
export async function tokenFacts(chainId, tokenAddress, { clientFactory = clientFor } = {}) {
  const client = clientFactory(chainId);

  let code;
  try {
    code = await client.getCode({ address: tokenAddress });
  } catch (e) {
    const c = classifyQuoteError(e);
    return { ok: false, kind: c.kind, reason: "the chain could not be read" };
  }
  if (!code || code === "0x") {
    return { ok: false, kind: "no_contract", reason: `no contract code at ${tokenAddress} on chain ${chainId}` };
  }

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    safeERC20Call(client, tokenAddress, "name"),
    safeERC20Call(client, tokenAddress, "symbol"),
    safeERC20Call(client, tokenAddress, "decimals"),
    safeERC20Call(client, tokenAddress, "totalSupply"),
  ]);

  const hard = [name, symbol, decimals, totalSupply].find(isHardQuoteFailure);
  if (hard) return { ok: false, kind: hard.kind, reason: "the token metadata could not be read" };

  if (!decimals.ok) {
    return {
      ok: false,
      kind: "malformed_metadata",
      reason: "contract does not expose a decodable decimals() - not a compliant ERC-20, or not an ERC-20 at all",
    };
  }

  return {
    ok: true,
    address: tokenAddress,
    name: name.ok ? name.value : null,
    symbol: symbol.ok ? symbol.value : null,
    decimals: Number(decimals.value),
    totalSupply: totalSupply.ok && totalSupply.value != null ? totalSupply.value.toString() : null,
  };
}

/**
 * THE QUOTE-BASED SELLABILITY QUESTION.
 *
 * If no configured venue can quote a sell of this token, it cannot be exited
 * through the venues this service knows about. That is a quote, not a transfer:
 * blacklist, pause, transfer tax and max-tx restrictions are NOT tested here.
 */
export async function sellabilityProbe(chainId, tokenAddress, probeUnits, { clientFactory = clientFor } = {}) {
  const client = clientFactory(chainId);
  const c = chain(chainId);

  let decimals = null;
  if (probeUnits === null || probeUnits === undefined) {
    const d = await safeERC20Call(client, tokenAddress, "decimals");
    if (isHardQuoteFailure(d)) {
      return { ok: false, kind: d.kind, canSell: null, quote_status: "failed", unavailable_reason: d.kind };
    }
    if (!d.ok) {
      return {
        ok: false, kind: "malformed_metadata", canSell: false, quote_status: "no_pool",
        unavailable_reason: "malformed_metadata",
        reason: "no decodable decimals() - cannot size a probe; treat as untradeable",
      };
    }
    decimals = Number(d.value);
    // Fallback for direct callers: 0.5 of one whole token. USD-sized callers
    // pass `probeUnits` themselves, which is the honest way to probe.
    probeUnits = 10n ** BigInt(Math.max(0, decimals - 1));
  }

  const usdc = c.tokens.USDC;
  if (!usdc) {
    return { ok: false, kind: "no_pool", canSell: false, quote_status: "no_pool", unavailable_reason: "no_pool", reason: "chain has no USDC configured" };
  }

  const probe = await quoteAllVenues(client, chainId, {
    tokenIn: tokenAddress,
    tokenOut: usdc.address,
    amountIn: probeUnits,
    // Deep pairs are usually vs WETH; a direct-only probe would falsely call
    // well-behaved tokens "unexitable" (this happened with SHIB).
    intermediates: ["WETH"],
  });

  if (probe.hard_failure) {
    return {
      ok: false,
      kind: probe.hard_failure.kind,
      canSell: null,
      quote_status: "failed",
      unavailable_reason: probe.hard_failure.kind,
    };
  }

  const quoted = probe.quoted.length > 0;
  return {
    ok: true,
    canSell: quoted,
    quote_status: quoted ? (probe.unavailable.length ? "partial" : "ok") : "no_pool",
    unavailable_reason: quoted ? (probe.unavailable.length ? "some_venues_no_pool" : null) : "no_pool",
    probedUnits: probeUnits.toString(),
    venuesThatQuote: probe.quoted.map((q) => q.venue),
    probeRealizedUsd: quoted ? Number(probe.quoted[0].amountOut) / 10 ** usdc.decimals : null,
    unavailable: probe.unavailable,
  };
}

function failure(chainId, started, kind, checked, extraNotChecked = []) {
  const honesty = paidHonesty("/safety", {
    checked: ["request validation", ...checked],
    notChecked: [
      kind === "transport"
        ? "market measurement did not run: the chain/provider could not be read"
        : "market measurement did not run: the provider returned undecodable data",
      ...extraNotChecked,
    ],
  });
  return {
    ok: false,
    kind,
    quote_status: "failed",
    unavailable_reason: kind,
    token: { chainId },
    reasons: [],
    notes: [],
    checked: honesty.checked,
    notChecked: honesty.notChecked,
    evidence: {},
    elapsedMs: Date.now() - started,
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
} = {}, { clientFactory = clientFor, dexscreenerPair = realDexscreenerPair } = {}) {
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
        ok: false, kind: "bad_request", verdict: null,
        token: { input: tokenAddress, chainId, chainName: c.name },
        reasons: [e.message], notes: [], checked, evidence, elapsedMs: Date.now() - started,
      };
    }
  }

  // --- 1. the token contract -------------------------------------------------
  const facts = await tokenFacts(chainId, address, { clientFactory });
  checked.push("contract");

  if (facts.ok === false && isHardQuoteFailure(facts)) {
    return failure(chainId, started, facts.kind, checked);
  }

  if (!facts.ok) {
    const honesty = paidHonesty("/safety", {
      checked,
      notChecked: [
        "market data, sellability quote, and round trip did not run because the token contract is not a usable ERC-20",
        unconfiguredVenues(chainId),
      ],
    });
    return {
      ok: true, verdict: "AVOID", quote_status: "no_pool", unavailable_reason: "no_contract",
      token: { input: tokenAddress, address, chainId, chainName: c.name },
      reasons: [facts.reason], notes, checked: honesty.checked, notChecked: honesty.notChecked,
      evidence, elapsedMs: Date.now() - started,
    };
  }

  evidence.contract = {
    address, name: facts.name, symbol: facts.symbol,
    decimals: facts.decimals, totalSupply: facts.totalSupply,
  };

  // --- 2. does the market exist ----------------------------------------------
  let ds = null;
  try {
    ds = await dexscreenerPair(chainId, address);
  } catch {
    notes.push("external market data was unavailable; on-chain quotes below still ran");
  }
  checked.push("market");
  const priceUsd = ds?.priceUsd ?? null;
  evidence.market = ds;
  if (priceUsd != null) {
    notes.push(`market liquidity: $${Math.round(ds.liquidityUsd ?? 0)}, 24h volume: $${Math.round(ds.volume24hUsd ?? 0)}`);
  } else {
    notes.push("market: no dexscreener pair for this token on this chain");
  }

  // --- 3. quote-based sellability: USD-sized probes --------------------------
  // "Prove half a token is sellable" was a bug that flagged SHIB - a $1B token
  // - as unexitable. Half a SHIB is four thousandths of a cent, and every pool
  // correctly refuses to quote dust. Probes are USD-sized instead: the same
  // $25 question asked of a token at $0.00001 and a token at $4000.
  let sell;
  if (priceUsd != null && priceUsd > 0) {
    const units = BigInt(Math.max(1, Math.round((probeUsd / priceUsd) * 10 ** facts.decimals)));
    sell = await sellabilityProbe(chainId, address, units, { clientFactory });
  } else {
    // No external price: fall back to a token-unit probe and say so.
    sell = await sellabilityProbe(chainId, address, null, { clientFactory });
    if (sell.ok) {
      sell.reason = "no external price to size a USD probe; probed 0.5 whole token instead";
      notes.push("no external price to size a USD probe; probed 0.5 whole token instead - the probe size is stated, not hidden");
    }
  }
  checked.push("quote-based sellability");

  if (sell.ok === false && isHardQuoteFailure(sell)) {
    return failure(chainId, started, sell.kind, checked);
  }

  evidence.sellability = {
    canSell: sell.canSell,
    quoteStatus: sell.quote_status,
    unavailableReason: sell.unavailable_reason ?? null,
    probedInUsd: priceUsd != null ? probeUsd : null,
    probedUnits: sell.probedUnits ?? null,
    venuesThatQuote: sell.venuesThatQuote ?? [],
    probeRealizedUsd: sell.probeRealizedUsd ?? null,
    caveat: "quote-based only: a quote does not prove a transfer will succeed",
  };

  if (!sell.canSell) {
    problems.push(
      sell.reason
        ?? `even a $${probeUsd} sell could not be quoted by any configured venue on this chain - cannot be exited through the venues this service knows`
    );
  } else if (sell.probeRealizedUsd !== null && sell.probeRealizedUsd <= 0.000001) {
    problems.push(`a $${probeUsd} sell returned ~$${sell.probeRealizedUsd} - exit is effectively worthless`);
  } else {
    notes.push(`quoteable sell via ${sell.venuesThatQuote.join(", ")}`);
  }

  // --- 4. the position itself: enter and exit at the intended size ------------
  if (sell.canSell) {
    const base = resolveToken(chainId, baseSymbol);
    const size = BigInt(Math.max(1, Math.round(intendedUsd * 10 ** base.decimals)));
    const client = clientFactory(chainId);

    const buy = await quoteAllVenues(client, chainId, {
      tokenIn: base.address, tokenOut: address, amountIn: size, intermediates: ["WETH"],
    });
    if (buy.hard_failure) return failure(chainId, started, buy.hard_failure.kind, checked);

    if (!buy.quoted.length) {
      problems.push(`no configured venue could fill a $${intendedUsd} ${baseSymbol} entry - the pair is too thin to trade`);
    } else {
      const got = buy.quoted[0];
      const sellBack = await quoteAllVenues(client, chainId, {
        tokenIn: address, tokenOut: base.address, amountIn: got.amountOut, intermediates: ["WETH"],
      });
      if (sellBack.hard_failure) return failure(chainId, started, sellBack.hard_failure.kind, checked);

      if (!sellBack.quoted.length) {
        problems.push(`entered at the best venue but no configured venue would buy the exact position back at $${intendedUsd}`);
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

  const quoteStatus = !sell.canSell
    ? "no_pool"
    : sell.quote_status === "partial"
      ? "partial"
      : "ok";
  const honesty = paidHonesty("/safety", {
    checked,
    notChecked: [
      unconfiguredVenues(chainId),
      "actual token transfer or sell execution",
      "transfer tax / fee-on-transfer",
      "blacklist / allowlist restrictions",
      "pause / trading-disable switches",
      "max-transaction / max-wallet limits",
      "holder concentration",
      "contract audit",
      "sanctions screening",
      ...(priceUsd == null ? ["external market price (none available)"] : []),
    ],
  });

  return {
    ok: true,
    verdict: !sell.canSell ? "AVOID" : problems.length > 0 ? "CAUTION" : "TRUST",
    quote_status: quoteStatus,
    unavailable_reason: quoteStatus === "no_pool" ? "no_pool" : quoteStatus === "partial" ? "some_venues_no_pool" : null,
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
    checked: honesty.checked,
    notChecked: honesty.notChecked,
    evidence,
    elapsedMs: Date.now() - started,
  };
}
