// The measurement engine.
//
// The one design decision that matters:
//
//   We do NOT compute swap output ourselves.
//
// Reimplementing Uniswap V3's tick-crossing mathematics is exactly how the
// project this service grew out of once reported 6.2M USDC of profit on a pool
// holding 285K. So this engine asks the canonical on-chain sources instead:
//
//   * V3  -> Uniswap's deployed QuoterV2, whose answers are the router's
//            answers by construction.
//   * V2  -> the router's own getAmountsOut.
//
// Every call is pinned to ONE block number, so both legs of a round trip are
// measured against the same instant. A round trip assembled from two different
// blocks can show profit that never coexisted.
//
// Failure classification (audit C-2) is part of the contract:
//   ok        a real quote
//   no_pool   the venue has no pool / cannot fill; legitimate market fact
//   revert    the venue reverted; legitimate market fact
//   transport the provider/network failed; NEVER a market fact
//   decode    the provider returned undecodable data; NEVER a market fact
//
// Only no_pool/revert may become "unavailable". transport/decode abort the
// measurement with ok:false and a 503 at the route boundary, so a provider
// outage can never be sold as AVOID / no_edge / unknown / illiquid.

import { createPublicClient, http, fallback, decodeFunctionResult, encodeFunctionData } from "viem";
import * as viemChains from "viem/chains";
import { chain, resolveToken, DEFAULT_GAS_UNITS } from "./config.mjs";

export const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
];

export const V2_ROUTER_ABI = [
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    name: "getAmountsOut",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
];

const clients = new Map();

export function clientFor(chainId) {
  if (clients.has(chainId)) return clients.get(chainId);
  const c = chain(chainId);
  const configured = process.env[c.rpcEnv];
  // A single free endpoint can throttle a cloud instance's egress IP, which is
  // how a correct measurement becomes a 90-second "loading" spinner. When no
  // paid endpoint is configured, fail over across independent public ones
  // instead of trusting any single provider.
  const urls = configured ? [configured] : [c.rpcDefault, ...(c.rpcFallbacks || [])];
  const viemChain = viemChains[c.viemChain];
  const transport = urls.length === 1
    ? http(urls[0], { retryCount: 2, timeout: 15_000 })
    : fallback(
        urls.map((url) => http(url, { retryCount: 0, timeout: 5_000 })),
        { rank: false },
      );
  const client = createPublicClient({ chain: viemChain, transport });
  clients.set(chainId, client);
  return client;
}

/** Stable, public-safe classification of a provider/contract error. */
export function classifyQuoteError(error) {
  const names = [error?.name, error?.cause?.name, error?.cause?.cause?.name].filter(Boolean).join(" ");
  const msg = String(error?.shortMessage || error?.details || error?.message || error || "");
  if (/decode|returned values|could not decode|cannot decode|abi/i.test(`${names} ${msg}`)) {
    return { kind: "decode", detail: msg };
  }
  if (/CallExecutionError/i.test(names) || /execution reverted|revert|panic/i.test(msg)) {
    return { kind: "revert", detail: msg };
  }
  if (/rate limit|too many requests|429/i.test(msg)) {
    return { kind: "transport", reason: "rate_limited", detail: msg };
  }
  return { kind: "transport", reason: "network", detail: msg };
}

export function quoteOk(amountOut) {
  return { ok: true, amountOut };
}

export function quoteFail(kind, detail = null, reason = null) {
  return { ok: false, kind, detail, reason };
}

export function isHardQuoteFailure(result) {
  return result && result.ok === false && (result.kind === "transport" || result.kind === "decode");
}

/**
 * Quote an exact-input V3 swap through Uniswap's canonical QuoterV2.
 * Returns a typed result: ok / no_pool / revert / transport / decode.
 */
export async function quoteV3(client, { quoter, tokenIn, tokenOut, amountIn, fee, blockNumber }) {
  try {
    const data = encodeFunctionData({
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    const raw = await client.call({ to: quoter, data, blockNumber });
    if (!raw?.data || raw.data === "0x") return quoteFail("no_pool", "empty data from quoter");
    let decoded;
    try {
      decoded = decodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", data: raw.data });
    } catch (e) {
      return quoteFail("decode", e?.message || String(e));
    }
    const out = decoded[0];
    return out > 0n ? quoteOk(out) : quoteFail("no_pool", "quoter returned zero");
  } catch (e) {
    const c = classifyQuoteError(e);
    return quoteFail(c.kind, c.detail, c.reason ?? null);
  }
}

/** Quote an exact-input V2 swap through the router itself. */
export async function quoteV2(client, { router, tokenIn, tokenOut, amountIn, blockNumber, path = null }) {
  try {
    // Multi-hop paths are the router's own math; we only build the address
    // array. The direct path label (tokenIn/tokenOut) is used for the decode
    // guard below, which does not depend on path shape.
    const route = path ?? [tokenIn, tokenOut];
    const data = encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, route],
    });
    const raw = await client.call({ to: router, data, blockNumber });
    if (!raw?.data || raw.data === "0x") return quoteFail("no_pool", "empty data from router");

    let decoded;
    try {
      decoded = decodeFunctionResult({ abi: V2_ROUTER_ABI, functionName: "getAmountsOut", data: raw.data });
    } catch (e) {
      return quoteFail("decode", e?.message || String(e));
    }

    // getAmountsOut returns uint256[] = [amountIn, amountOut, ...]. viem hands
    // back a single declared output UNWRAPPED, so `decoded` is usually the
    // amounts array itself - but not always, depending on how the result is
    // shaped. Taking `decoded[0]` because it looked array-ish silently returned
    // the INPUT amount, which on the sell leg read as 41 trillion USDC of
    // profit. Find the actual uint256[] wherever it sits.
    const amounts = findUintArray(decoded);
    if (!amounts || amounts.length < 2) return quoteFail("decode", "getAmountsOut did not return a uint256[]");
    const out = amounts[amounts.length - 1];

    // Structural guard: no router can hand back exactly what it was given.
    // If it does, this decode is wrong, and a wrong decode here is invented
    // profit - the one bug this engine must never ship. We keep this as a
    // market-unavailable result (the L-1 edge case is tracked separately)
    // rather than a 503, because it is a decode-shape guard, not an outage.
    if (!(out > 0n) || out === amountIn) return quoteFail("no_pool", "echo guard: amountOut equals amountIn");
    return quoteOk(out);
  } catch (e) {
    const c = classifyQuoteError(e);
    return quoteFail(c.kind, c.detail, c.reason ?? null);
  }
}

/** Find the uint256[] inside a decoded result, whatever wrapper it arrived in. */
function findUintArray(res) {
  const stack = [res];
  const seen = new Set();
  while (stack.length) {
    const v = stack.shift();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 0 && typeof v[0] === "bigint") return v;
      stack.push(...v);
    }
  }
  return null;
}

/**
 * Quote an exact-input V3 swap across a multi-hop path, leg by leg through
 * QuoterV2 itself, with every leg pinned to ONE block so the quote is
 * internally consistent. No tick math is implemented here.
 */
export async function quoteV3Path(client, { quoter, path, amountIn, fee, blockNumber = null }) {
  try {
    const bn = blockNumber ?? (await client.getBlockNumber());
    let amount = amountIn;
    for (let i = 0; i < path.length - 1; i++) {
      const out = await quoteV3(client, {
        quoter,
        tokenIn: path[i],
        tokenOut: path[i + 1],
        amountIn: amount,
        fee,
        blockNumber: bn,
      });
      if (!out.ok) return out;
      if (!(out.amountOut > 0n)) return quoteFail("no_pool", "leg returned zero");
      amount = out.amountOut;
    }
    return quoteOk(amount);
  } catch (e) {
    const c = classifyQuoteError(e);
    return quoteFail(c.kind, c.detail, c.reason ?? null);
  }
}

/** Every configured venue this chain knows about, at one block. */
export async function quoteAllVenues(client, chainId, { tokenIn, tokenOut, amountIn, blockNumber, intermediates = [] }) {
  const c = chain(chainId);

  // Direct pairs miss most real liquidity: a token's deep pool is frequently
  // VS WETH (or another major), not vs the caller's base. Routed jobs use the
  // router's OWN path math (getAmountsOut accepts a full path; QuoterV2 is
  // chained leg by leg), so no pricing is ever implemented locally.
  const viaTokens = intermediates
    .filter((sym) => {
      const t = c.tokens[sym];
      if (!t) return false;
      const addr = t.address.toLowerCase();
      return addr !== tokenIn.toLowerCase() && addr !== tokenOut.toLowerCase();
    })
    .map((sym) => c.tokens[sym]);

  const jobs = [
    ...c.v3Fees.map((fee) => ({
      venue: `uni-v3-${fee / 10_000}%`,
      kind: "v3",
      fee,
      run: () => quoteV3(client, { quoter: c.quoterV2, tokenIn, tokenOut, amountIn, fee, blockNumber }),
    })),
    ...c.v2Routers.map((r) => ({
      venue: r.label,
      kind: "v2",
      fee: r.feeBps * 100,
      run: () => quoteV2(client, { router: r.address, tokenIn, tokenOut, amountIn, blockNumber }),
    })),
    // Routed variants, clearly labeled so the caller knows the price came via
    // a hop and not a direct pair.
    ...viaTokens.flatMap((v) => [
      ...c.v2Routers.map((r) => ({
        venue: `${r.label} via ${v.symbol ?? "hop"}`,
        kind: "v2",
        fee: r.feeBps * 100,
        run: () => quoteV2(client, { router: r.address, tokenIn, tokenOut, amountIn, blockNumber, path: [tokenIn, v.address, tokenOut] }),
      })),
      ...c.v3Fees.map((fee) => ({
        venue: `uni-v3-${fee / 10_000}% via ${v.symbol ?? "hop"}`,
        kind: "v3-path",
        fee,
        run: () => quoteV3Path(client, { quoter: c.quoterV2, path: [tokenIn, v.address, tokenOut], amountIn, fee, blockNumber }),
      })),
    ]),
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));

  const quoted = [];
  const unavailable = [];
  const failures = [];
  settled.forEach((res, i) => {
    const j = jobs[i];
    let result;
    if (res.status === "fulfilled") {
      result = res.value;
    } else {
      const c = classifyQuoteError(res.reason);
      result = quoteFail(c.kind, c.detail, c.reason ?? null);
    }
    if (result?.ok && result.amountOut != null) {
      quoted.push({ venue: j.venue, kind: j.kind, fee: j.fee, amountOut: result.amountOut, status: "ok" });
    } else if (result?.kind === "no_pool" || result?.kind === "revert") {
      unavailable.push({
        venue: j.venue,
        status: result.kind,
        reason: result.kind === "no_pool" ? "no pool or cannot fill size" : "venue reverted (no pool or cannot fill size)",
      });
    } else {
      failures.push({
        venue: j.venue,
        kind: result?.kind ?? "transport",
        reason: result?.reason ?? null,
        // Keep the provider detail server-side only. Routes log failures and
        // return a sanitized 503; never echo this to a caller.
        detail: result?.detail ?? null,
      });
    }
  });

  // Best first: the whole point is to find the most you can get.
  quoted.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  const hard = failures.find((f) => f.kind === "transport" || f.kind === "decode") ?? null;
  return {
    quoted,
    unavailable,
    failures,
    hard_failure: hard,
    quote_status: hard ? "failed" : quoted.length ? "ok" : "no_pool",
  };
}

/** Price of the chain's gas token in USD, using the same engine. */
export async function gasTokenPriceUsd(client, chainId, blockNumber) {
  const c = chain(chainId);
  const weth = c.tokens[c.gasToken];
  const usdc = c.tokens.USDC;
  if (!weth || !usdc) return quoteFail("no_pool", "gas token or USDC is not configured");

  // Try each fee tier; the deepest pool wins. Same-block, so it is consistent
  // with the rest of the measurement. A transport/decode failure in ANY tier
  // aborts: using a partial set could understate gas and invent an edge.
  const results = await Promise.all(
    c.v3Fees.map((fee) =>
      quoteV3(client, {
        quoter: c.quoterV2,
        tokenIn: weth.address,
        tokenOut: usdc.address,
        amountIn: 10n ** BigInt(weth.decimals),
        fee,
        blockNumber,
      })
    )
  );
  const hard = results.find((r) => isHardQuoteFailure(r));
  if (hard) return hard;
  const quoted = results
    .map((r, i) => (r.ok ? { amountOut: r.amountOut, fee: c.v3Fees[i] } : null))
    .filter(Boolean)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  if (!quoted.length) return quoteFail("no_pool", "no gas-token/USDC pool answered");
  return {
    ok: true,
    usd: Number(quoted[0].amountOut) / 10 ** usdc.decimals,
    feeUsed: quoted[0].fee,
    quote_status: results.some((r) => !r.ok) ? "partial" : "ok",
  };
}

const STABLES = new Set(["USDC", "USDT", "DAI"]);

function unavailableReason(book) {
  if (book.hard_failure) return book.hard_failure.kind;
  if (!book.quoted.length) return "no_pool";
  return book.unavailable.length ? "some_venues_no_pool" : null;
}

function failedMeasurement(chainId, kind, { reason = null, detail = null, blockNumber = null, unavailable = [] } = {}) {
  return {
    ok: false,
    kind,
    reason: reason || (kind === "no_pool"
      ? "no configured venue could quote this pair at this size"
      : "the chain could not be read, so no verdict was issued"),
    quote_status: kind === "no_pool" || kind === "revert" ? "no_pool" : "failed",
    unavailable_reason: kind,
    chainId,
    blockNumber: blockNumber == null ? null : Number(blockNumber),
    unavailable,
    ...(detail ? { _detail: detail } : {}),
  };
}

/**
 * The measurement: buy `target` with `size` of base on the best venue, sell it
 * back on the best venue, net off every cost we can see, and say whether it
 * pays. `clientFactory` is injectable for offline tests.
 */
export async function measureRoundTrip(chainId, {
  baseSymbol = "USDC",
  targetSymbol,
  size,
  minNet = 0n,
  gasUnits = DEFAULT_GAS_UNITS,
  venues = null,
} = {}, { clientFactory = clientFor } = {}) {
  const c = chain(chainId);
  const base = resolveToken(chainId, baseSymbol);
  const target = resolveToken(chainId, targetSymbol);
  const client = clientFactory(chainId);

  let blockNumber;
  let block;
  try {
    blockNumber = await client.getBlockNumber();
    block = await client.getBlock({ blockNumber });
  } catch (e) {
    const failure = classifyQuoteError(e);
    return failedMeasurement(chainId, failure.kind, { detail: failure.detail });
  }

  // --- leg 1: base -> target, on every configured venue
  const buySide = await quoteAllVenues(client, chainId, {
    tokenIn: base.address,
    tokenOut: target.address,
    amountIn: size,
    blockNumber,
  });
  if (buySide.hard_failure) {
    return failedMeasurement(chainId, buySide.hard_failure.kind, {
      blockNumber,
      detail: buySide.hard_failure.detail,
    });
  }

  if (!buySide.quoted.length) {
    return failedMeasurement(chainId, "no_pool", {
      blockNumber,
      reason: "No configured venue on this chain could quote the buy leg. Either the pair does not exist here or every pool is too thin for this size.",
      unavailable: buySide.unavailable,
    });
  }

  const buy = buySide.quoted[0];
  const midAmount = buy.amountOut;

  // --- leg 2: target -> base, selling exactly what leg 1 produced
  const sellSide = await quoteAllVenues(client, chainId, {
    tokenIn: target.address,
    tokenOut: base.address,
    amountIn: midAmount,
    blockNumber,
  });
  if (sellSide.hard_failure) {
    return failedMeasurement(chainId, sellSide.hard_failure.kind, {
      blockNumber,
      detail: sellSide.hard_failure.detail,
    });
  }

  if (!sellSide.quoted.length) {
    return failedMeasurement(chainId, "no_pool", {
      blockNumber,
      reason: "No configured venue could quote the sell leg for the exact amount the buy leg produces.",
      unavailable: sellSide.unavailable,
    });
  }

  const sell = sellSide.quoted[0];

  // --- arithmetic
  const gross = sell.amountOut - size;

  const gasQuote = await gasTokenPriceUsd(client, chainId, blockNumber);
  if (isHardQuoteFailure(gasQuote)) {
    return failedMeasurement(chainId, gasQuote.kind, { blockNumber, detail: gasQuote.detail });
  }
  if (!gasQuote.ok) {
    return failedMeasurement(chainId, "no_pool", {
      blockNumber,
      reason: "The gas token could not be priced at this block, so costs cannot be netted.",
      unavailable: [{ venue: "gas-token/usdc", status: "no_pool", reason: "no gas price pool" }],
    });
  }

  let gasPrice;
  try {
    gasPrice = await client.getGasPrice();
  } catch (e) {
    const failure = classifyQuoteError(e);
    return failedMeasurement(chainId, failure.kind, { blockNumber, detail: failure.detail });
  }

  const eth = gasQuote;
  let gasBase = 0n;
  let gasUsd = null;
  if (eth?.ok) {
    // gasUsd = gasUnits * gasPrice(wei) / 1e18 * ethUsd
    gasUsd = (Number(gasUnits) * Number(gasPrice) * eth.usd) / 1e18;
    if (STABLES.has(baseSymbol)) {
      // Base is a USD stable; treat 1 unit as $1. Stated in the response so the
      // caller is not misled if that assumption stops holding.
      gasBase = BigInt(Math.ceil(gasUsd * 10 ** base.decimals));
    }
  }

  const flashPremium = (size * BigInt(c.flashLoanPremiumBps)) / 10_000n;
  const costs = gasBase + flashPremium;
  const net = gross - costs;

  const scale = 10 ** base.decimals;
  // Basis points with two decimals of precision: (v / size) * 10_000, scaled by
  // 100 to keep the fraction. Getting this wrong by a factor of 100 is how a
  // -292 USDC loss on 100,000 USDC reads as a harmless -0.29 bps.
  const bps = (v) => Number((v * 1_000_000n) / size) / 100;

  const verdict =
    net > BigInt(minNet) ? "edge" : gross > 0n ? "no_edge_costs_ate_it" : "no_edge";

  const allUnavailable = [...buySide.unavailable, ...sellSide.unavailable];
  const quote_status = allUnavailable.length ? "partial" : "ok";

  return {
    ok: true,
    verdict,
    quote_status,
    unavailable_reason: allUnavailable.length ? "some_venues_no_pool" : null,
    chainId,
    chainName: c.name,
    blockNumber: Number(blockNumber),
    blockTimestamp: Number(block.timestamp),
    blockHash: block.hash ?? null,
    base: { symbol: baseSymbol, address: base.address, decimals: base.decimals },
    target: { symbol: targetSymbol, address: target.address, decimals: target.decimals },
    size: { raw: size.toString(), human: Number(size) / scale },
    buy: { venue: buy.venue, kind: buy.kind, feeBps: buy.fee / 100, amountOutRaw: midAmount.toString(), amountOutHuman: Number(midAmount) / 10 ** target.decimals },
    sell: { venue: sell.venue, kind: sell.kind, feeBps: sell.fee / 100, amountOutRaw: sell.amountOut.toString(), amountOutHuman: Number(sell.amountOut) / scale },
    gross: { raw: gross.toString(), human: Number(gross) / scale, bps: bps(gross) },
    costs: {
      flashLoanPremiumRaw: flashPremium.toString(),
      flashLoanPremiumBps: c.flashLoanPremiumBps,
      gasUnits: gasUnits.toString(),
      gasPriceGwei: Number(gasPrice) / 1e9,
      gasTokenUsd: eth ? eth.usd : null,
      gasUsd,
      gasRaw: gasBase.toString(),
      totalRaw: costs.toString(),
      note: eth && STABLES.has(baseSymbol)
        ? `gas converted to ${baseSymbol} at 1 ${baseSymbol} = $1`
        : "gas not converted to base units; see gasUsd",
    },
    net: { raw: net.toString(), human: Number(net) / scale, bps: bps(net) },
    venues: {
      quoted: buySide.quoted.length + sellSide.quoted.length,
      buySide: buySide.quoted.map((q) => ({ venue: q.venue, outRaw: q.amountOut.toString() })),
      sellSide: sellSide.quoted.map((q) => ({ venue: q.venue, outRaw: q.amountOut.toString() })),
      unavailable: allUnavailable,
    },
    method: {
      quoting: "V3 via Uniswap QuoterV2; V2 via router getAmountsOut",
      blockPinned: true,
      sameVenueRoundTrip: buy.venue === sell.venue,
      assumption: STABLES.has(baseSymbol)
        ? `${baseSymbol} treated as $1 for gas conversion`
        : "base token is not a USD stable; costs are reported in USD",
    },
    caveats: [
      "Measures a cross-venue round trip at one block. It is not a forecast, and it is not financial advice.",
      "Does not model slippage beyond what the venues themselves report, MEV competition, or failed-transaction cost.",
      buy.venue === sell.venue
        ? "Both legs route through the SAME venue: a one-pool round trip pays that pool's fee twice and cannot win."
        : "Legs route through different venues, which is the case worth checking.",
    ],
  };
}
