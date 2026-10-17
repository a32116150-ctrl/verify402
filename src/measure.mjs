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

import { createPublicClient, http, decodeFunctionResult, encodeFunctionData } from "viem";
import * as viemChains from "viem/chains";
import { chain, resolveToken, DEFAULT_GAS_UNITS } from "./config.mjs";

const QUOTER_V2_ABI = [
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

const V2_ROUTER_ABI = [
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
  const url = process.env[c.rpcEnv] || c.rpcDefault;
  const viemChain = viemChains[c.viemChain];
  const client = createPublicClient({
    chain: viemChain,
    transport: http(url, { retryCount: 2, timeout: 15_000 }),
  });
  clients.set(chainId, client);
  return client;
}

/**
 * Quote an exact-input V3 swap through Uniswap's canonical QuoterV2.
 * Returns null when the pool does not exist or cannot fill the size - both of
 * which are legitimate "this venue is not available" answers, not errors.
 */
export async function quoteV3(client, { quoter, tokenIn, tokenOut, amountIn, fee, blockNumber }) {
  try {
    const data = encodeFunctionData({
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    const raw = await client.call({ to: quoter, data, blockNumber });
    if (!raw.data) return null;
    const decoded = decodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", data: raw.data });
    const out = decoded[0];
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/** Quote an exact-input V2 swap through the router itself. */
export async function quoteV2(client, { router, tokenIn, tokenOut, amountIn, blockNumber }) {
  try {
    const data = encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [tokenIn, tokenOut]],
    });
    const raw = await client.call({ to: router, data, blockNumber });
    if (!raw.data) return null;
    const decoded = decodeFunctionResult({ abi: V2_ROUTER_ABI, functionName: "getAmountsOut", data: raw.data });

    // getAmountsOut returns uint256[] = [amountIn, amountOut, ...]. viem hands
    // back a single declared output UNWRAPPED, so `decoded` is usually the
    // amounts array itself - but not always, depending on how the result is
    // shaped. Taking `decoded[0]` because it looked array-ish silently returned
    // the INPUT amount, which on the sell leg read as 41 trillion USDC of
    // profit. Find the actual uint256[] wherever it sits.
    const amounts = findUintArray(decoded);
    if (!amounts || amounts.length < 2) return null;
    const out = amounts[amounts.length - 1];

    // Structural guard: no router can hand back exactly what it was given.
    // If it does, this decode is wrong, and a wrong decode here is invented
    // profit - the one bug this engine must never ship.
    if (!(out > 0n) || out === amountIn) return null;
    return out;
  } catch {
    return null;
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

/** Every venue this chain knows about, quoted for one direction, at one block. */
export async function quoteAllVenues(client, chainId, { tokenIn, tokenOut, amountIn, blockNumber }) {
  const c = chain(chainId);

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
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));

  const quoted = [];
  const unavailable = [];
  settled.forEach((res, i) => {
    const j = jobs[i];
    const amountOut = res.status === "fulfilled" ? res.value : null;
    if (amountOut === null) unavailable.push({ venue: j.venue, reason: "no pool or cannot fill size" });
    else quoted.push({ venue: j.venue, kind: j.kind, fee: j.fee, amountOut });
  });

  // Best first: the whole point is to find the most you can get.
  quoted.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return { quoted, unavailable };
}

/** Price of the chain's gas token in USD, using the same engine. */
export async function gasTokenPriceUsd(client, chainId, blockNumber) {
  const c = chain(chainId);
  const weth = c.tokens[c.gasToken];
  const usdc = c.tokens.USDC;
  if (!weth || !usdc) return null;

  // Try each fee tier; the deepest pool wins. Same-block, so it is consistent
  // with the rest of the measurement.
  const outs = await Promise.all(
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
  const best = outs.filter((o) => o !== null).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))[0];
  if (!best) return null;
  return { usd: Number(best) / 10 ** usdc.decimals, feeUsed: c.v3Fees[outs.indexOf(best)] };
}

const STABLES = new Set(["USDC", "USDT", "DAI"]);

/**
 * The measurement: buy `target` with `size` of base on the best venue, sell it
 * back on the best venue, net off every cost we can see, and say whether it
 * pays.
 */
export async function measureRoundTrip(chainId, { baseSymbol = "USDC", targetSymbol, size, minNet = 0n, gasUnits = DEFAULT_GAS_UNITS, venues = null } = {}) {
  const c = chain(chainId);
  const base = resolveToken(chainId, baseSymbol);
  const target = resolveToken(chainId, targetSymbol);
  const client = clientFor(chainId);

  const blockNumber = await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber });

  // --- leg 1: base -> target, on every venue
  const buySide = await quoteAllVenues(client, chainId, {
    tokenIn: base.address,
    tokenOut: target.address,
    amountIn: size,
    blockNumber,
  });

  if (!buySide.quoted.length) {
    return {
      ok: false,
      reason: "No venue on this chain could quote the buy leg. Either the pair does not exist here or every pool is too thin for this size.",
      chainId,
      blockNumber: Number(blockNumber),
      base: { symbol: baseSymbol, address: base.address, decimals: base.decimals },
      target: { symbol: targetSymbol, address: target.address, decimals: target.decimals },
      unavailable: buySide.unavailable,
    };
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

  if (!sellSide.quoted.length) {
    return {
      ok: false,
      reason: "No venue could quote the sell leg for the exact amount the buy leg produces.",
      chainId,
      blockNumber: Number(blockNumber),
      unavailable: sellSide.unavailable,
    };
  }

  const sell = sellSide.quoted[0];

  // --- arithmetic
  const gross = sell.amountOut - size;

  const eth = await gasTokenPriceUsd(client, chainId, blockNumber);
  const gasPrice = await client.getGasPrice();

  let gasBase = 0n;
  let gasUsd = null;
  if (eth) {
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

  return {
    ok: true,
    verdict,
    chainId,
    chainName: c.name,
    blockNumber: Number(blockNumber),
    blockTimestamp: Number(block.timestamp),
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
      unavailable: [...buySide.unavailable, ...sellSide.unavailable],
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
