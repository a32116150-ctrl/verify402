// H-3: /depth must use the token's real decimals for gotTokens and price.
//
// The token below is deliberately NOT in the chain registry. Before this fix
// depth fell back to 18 decimals, so a 6-decimal token looked 10^12 times
// smaller and an 8-decimal token looked 10^10 times smaller.

import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { depthProfile } from "../src/depth.mjs";
import { QUOTER_V2_ABI, V2_ROUTER_ABI } from "../src/measure.mjs";
import { CHAINS } from "../src/config.mjs";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

const C = CHAINS[1];
const USDC = C.tokens.USDC;
const WETH = C.tokens.WETH;
const TARGET = "0x1111111111111111111111111111111111111111";

const SELECTORS = {
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
};

function makeClient(decimals) {
  const metadata = (sel) => {
    if (sel === SELECTORS.symbol) {
      return encodeFunctionResult({
        abi: [{ inputs: [], outputs: [{ type: "string" }], name: "symbol", stateMutability: "view", type: "function" }],
        functionName: "symbol", result: "SIX",
      });
    }
    if (sel === SELECTORS.name) {
      return encodeFunctionResult({
        abi: [{ inputs: [], outputs: [{ type: "string" }], name: "name", stateMutability: "view", type: "function" }],
        functionName: "name", result: "Six Decimal Token",
      });
    }
    if (sel === SELECTORS.decimals) {
      return encodeFunctionResult({
        abi: [{ inputs: [], outputs: [{ type: "uint8" }], name: "decimals", stateMutability: "view", type: "function" }],
        functionName: "decimals", result: decimals,
      });
    }
    if (sel === SELECTORS.totalSupply) {
      return encodeFunctionResult({
        abi: [{ inputs: [], outputs: [{ type: "uint256" }], name: "totalSupply", stateMutability: "view", type: "function" }],
        functionName: "totalSupply", result: 1_000_000n * 10n ** BigInt(decimals),
      });
    }
    return null;
  };

  const isUsdc = (a) => String(a).toLowerCase() === USDC.address.toLowerCase();
  const isTarget = (a) => String(a).toLowerCase() === TARGET.toLowerCase();
  const isWeth = (a) => String(a).toLowerCase() === WETH.address.toLowerCase();
  const scale = 10n ** BigInt(decimals - 6);

  const amountFor = (tokenIn, tokenOut, amountIn) => {
    if (isUsdc(tokenIn) && isTarget(tokenOut)) return amountIn * 5n * scale;
    if (isTarget(tokenIn) && isUsdc(tokenOut)) return amountIn / scale;
    if (isUsdc(tokenIn) && isWeth(tokenOut)) return amountIn * 10n ** 12n;
    if (isWeth(tokenIn) && isTarget(tokenOut)) return (amountIn / 10n ** 18n) * 10n ** BigInt(decimals);
    if (isTarget(tokenIn) && isWeth(tokenOut)) return amountIn;
    if (isWeth(tokenIn) && isUsdc(tokenOut)) return amountIn / 10n ** 12n;
    return amountIn;
  };

  return {
    async getBlockNumber() { return 500n; },
    async getCode() { return "0x6000"; },
    async call({ data }) {
      const meta = metadata(String(data).slice(0, 10));
      if (meta) return { data: meta };
      try {
        const v3 = decodeFunctionData({ abi: QUOTER_V2_ABI, data });
        const p = v3.args[0];
        return {
          data: encodeFunctionResult({
            abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
            result: [amountFor(p.tokenIn, p.tokenOut, p.amountIn), 0n, 0n, 0n],
          }),
        };
      } catch { /* not V3 */ }
      const v2 = decodeFunctionData({ abi: V2_ROUTER_ABI, data });
      const [amountIn, path] = v2.args;
      return {
        data: encodeFunctionResult({
          abi: V2_ROUTER_ABI, functionName: "getAmountsOut",
          result: [amountIn, amountFor(path[0], path[path.length - 1], amountIn)],
        }),
      };
    },
  };
}

async function run(decimals, baseSymbol = "USDC", size = 100) {
  return depthProfile(1, {
    tokenAddress: TARGET,
    baseSymbol,
    sizesUsd: [size],
  }, { clientFactory: () => makeClient(decimals), dexscreenerPair: async () => null });
}

console.log("\ndepth token decimals");

await check("6-decimal token reports 500 tokens at 0.20 USDC implied", async () => {
  const r = await run(6);
  assert.equal(r.ok, true, r.error);
  const rung = r.ladder[0];
  assert.equal(rung.fillable, true);
  assert.equal(rung.gotTokens, 500);
  assert.equal(rung.impliedPriceBase, 0.2);
  assert.equal(rung.impliedPriceUsd, 0.2, "USDC base keeps the deprecated alias");
});

await check("8-decimal token reports 500 tokens at 0.20 USDC implied", async () => {
  const r = await run(8);
  assert.equal(r.ok, true, r.error);
  const rung = r.ladder[0];
  assert.equal(rung.fillable, true);
  assert.equal(rung.gotTokens, 500);
  assert.equal(rung.impliedPriceBase, 0.2);
  assert.equal(rung.impliedPriceUsd, 0.2, "USDC base keeps the deprecated alias");
});

await check("non-USD base: impliedPriceBase is present, impliedPriceUsd is null", async () => {
  const r = await run(8, "WETH", 1);
  assert.equal(r.ok, true, r.error);
  const rung = r.ladder[0];
  assert.equal(rung.fillable, true);
  assert.equal(rung.gotTokens, 1);
  assert.equal(rung.impliedPriceBase, 1);
  assert.equal(rung.impliedPriceUsd, null, "the USD alias must not be claimed for a WETH base");
});

await check("round-trip tolerance is normalized to integer basis points", async () => {
  const r = await depthProfile(1, {
    tokenAddress: TARGET,
    baseSymbol: "USDC",
    sizesUsd: [100],
    maxRoundTripPct: 2.5,
  }, { clientFactory: () => makeClient(8), dexscreenerPair: async () => null });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.maxRoundTripPct, 2.5);
  assert.equal(r.maxRoundTripBps, "250");
  assert.equal(Number.isInteger(r.ladder[0].roundTripCostBps), true);
  assert.equal(r.ladder[0].underTolerance, r.ladder[0].roundTripCostBps <= 250);
});

console.log(`\ndepth-decimals: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
