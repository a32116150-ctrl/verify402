// Engine tests. No framework - just the checks that would catch this service
// lying, which is the only thing that matters for a service sold on accuracy.
//
//   node test/measure.test.mjs
//
// Needs network access to a mainnet RPC.

import { clientFor, quoteAllVenues, measureRoundTrip } from "../src/measure.mjs";
import { chain } from "../src/config.mjs";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS${detail ? `  (${detail})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL\n      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CHAIN_ID = 1;
const client = clientFor(CHAIN_ID);
const c = chain(CHAIN_ID);

console.log(`\nengine tests on ${c.name} (chainId ${CHAIN_ID})\n`);

// --- 1. every configured venue must actually exist on-chain ----------------
await check("all configured venues exist on-chain", async () => {
  const targets = [
    { what: "QuoterV2", address: c.quoterV2 },
    ...c.v2Routers.map((r) => ({ what: r.label, address: r.address })),
  ];
  const codes = await Promise.all(targets.map((t) => client.getCode({ address: t.address })));
  const missing = targets.filter((_, i) => !codes[i] || codes[i] === "0x");
  assert(missing.length === 0, `no bytecode at: ${missing.map((m) => `${m.what}=${m.address}`).join(", ")}`);
  return `${targets.length} addresses`;
});

// --- 2. QuoterV2 must agree with the V2 router's own arithmetic -----------
// Same pair, same block, two independent sources. They differ by the fee gap
// (0.05% vs 0.30%) plus whatever the two pools' mid prices have drifted apart.
// If the QuoterV2 call were mis-encoded, this would be off by orders of
// magnitude rather than a couple of percent.
await check("QuoterV2 agrees with V2 router within 5%", async () => {
  const blockNumber = await client.getBlockNumber();
  const tenEth = 10n * 10n ** 18n;

  const buySide = await quoteAllVenues(client, CHAIN_ID, {
    tokenIn: c.tokens.WETH.address,
    tokenOut: c.tokens.USDC.address,
    amountIn: tenEth,
    blockNumber,
  });

  const v3 = buySide.quoted.find((q) => q.venue === "uni-v3-0.05%");
  const v2 = buySide.quoted.find((q) => q.venue === "uniswap-v2");
  assert(v3, "QuoterV2 returned nothing for WETH->USDC 0.05%");
  assert(v2, "V2 router returned nothing for WETH->USDC");

  const diffPct = Math.abs(Number(v3.amountOut - v2.amountOut)) / Number(v2.amountOut) * 100;
  assert(diffPct < 5, `V3 and V2 disagree by ${diffPct.toFixed(2)}% - encodings likely wrong`);
  return `Δ ${diffPct.toFixed(3)}%`;
});

// --- 3. no invented profit ------------------------------------------------
// The headline sanity property. On a market this efficient a 100k USDC
// USDC->WETH->USDC round trip must NOT come out ahead. If this ever passes as
// profitable, the engine is wrong until proven otherwise.
await check("no invented profit on a 100k USDC round trip", async () => {
  const r = await measureRoundTrip(CHAIN_ID, { targetSymbol: "WETH", size: 100_000n * 10n ** 6n });
  assert(r.ok, `measurement failed: ${r.reason}`);
  assert(r.verdict !== "edge", `reported an edge: net ${r.net.human} ${r.base.symbol} - investigate before believing it`);
  assert(Math.abs(r.net.bps) < 200, `net ${r.net.bps} bps is absurd for a tight pair - engine is broken`);
  return `${r.verdict}, net ${r.net.bps.toFixed(2)} bps`;
});

// --- 4. more input must never buy more output ----------------------------
await check("output is monotonic in size", async () => {
  const blockNumber = await client.getBlockNumber();
  const small = 100n * 10n ** 6n;
  const big = 1_000_000n * 10n ** 6n;
  const [a, b] = await Promise.all([
    quoteAllVenues(client, CHAIN_ID, { tokenIn: c.tokens.USDC.address, tokenOut: c.tokens.WETH.address, amountIn: small, blockNumber }),
    quoteAllVenues(client, CHAIN_ID, { tokenIn: c.tokens.USDC.address, tokenOut: c.tokens.WETH.address, amountIn: big, blockNumber }),
  ]);
  const aBest = a.quoted[0];
  const bBest = b.quoted[0];
  assert(aBest && bBest, "a size returned no quote");
  assert(bBest.amountOut > aBest.amountOut, "1M USDC did not buy more WETH than 100 USDC");
  // ...but the rate must get worse, not better.
  const rateSmall = Number(aBest.amountOut) / Number(small);
  const rateBig = Number(bBest.amountOut) / Number(big);
  assert(rateBig < rateSmall, "the larger trade got a BETTER unit rate - that cannot happen");
  return `rate worsens ${((1 - rateBig / rateSmall) * 100).toFixed(3)}%`;
});

// --- 5. the same block must give the same answer -------------------------
await check("measurements are deterministic at a pinned block", async () => {
  const blockNumber = await client.getBlockNumber() - 5n;
  const args = { tokenIn: c.tokens.USDC.address, tokenOut: c.tokens.WETH.address, amountIn: 100_000n * 10n ** 6n, blockNumber };
  const [x, y] = await Promise.all([quoteAllVenues(client, CHAIN_ID, args), quoteAllVenues(client, CHAIN_ID, args)]);
  assert(x.quoted.length > 0, "no quotes");
  const same = x.quoted.every((q, i) => y.quoted[i] && q.venue === y.quoted[i].venue && q.amountOut === y.quoted[i].amountOut);
  assert(same, "two calls at the same block disagreed");
  return `${x.quoted.length} venues identical`;
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
