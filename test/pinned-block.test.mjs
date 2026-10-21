// H-2: one pinned block per measurement.
//
// Every function below is called with a fake client whose getBlockNumber()
// advances on each call. If a code path quietly re-reads "latest", the block
// numbers recorded on getCode/call/getBlock diverge and the test fails. A
// caller-supplied block must never trigger getBlockNumber() at all.

import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { preTradeCheck } from "../src/safety.mjs";
import { measureRoundTrip, quoteAllVenues, QUOTER_V2_ABI, V2_ROUTER_ABI } from "../src/measure.mjs";
import { fairQuoteCheck, bestRouteBook } from "../src/quotecheck.mjs";
import { depthProfile } from "../src/depth.mjs";
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

const SELECTORS = {
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
};

function metadata(sel) {
  if (sel === SELECTORS.symbol) {
    return encodeFunctionResult({
      abi: [{ inputs: [], outputs: [{ type: "string" }], name: "symbol", stateMutability: "view", type: "function" }],
      functionName: "symbol", result: "WETH",
    });
  }
  if (sel === SELECTORS.name) {
    return encodeFunctionResult({
      abi: [{ inputs: [], outputs: [{ type: "string" }], name: "name", stateMutability: "view", type: "function" }],
      functionName: "name", result: "Wrapped Ether",
    });
  }
  if (sel === SELECTORS.decimals) {
    return encodeFunctionResult({
      abi: [{ inputs: [], outputs: [{ type: "uint8" }], name: "decimals", stateMutability: "view", type: "function" }],
      functionName: "decimals", result: 18,
    });
  }
  if (sel === SELECTORS.totalSupply) {
    return encodeFunctionResult({
      abi: [{ inputs: [], outputs: [{ type: "uint256" }], name: "totalSupply", stateMutability: "view", type: "function" }],
      functionName: "totalSupply", result: 1_000_000n * 10n ** 18n,
    });
  }
  return null;
}

function quoteOut(data) {
  const amountFor = (tokenIn, tokenOut, amountIn) => {
    const inIsUsdc = String(tokenIn).toLowerCase() === USDC.address.toLowerCase();
    const outIsUsdc = String(tokenOut).toLowerCase() === USDC.address.toLowerCase();
    if (inIsUsdc) return amountIn * 5n * 10n ** 11n;
    if (outIsUsdc) return amountIn / (5n * 10n ** 8n);
    return amountIn;
  };
  try {
    const v3 = decodeFunctionData({ abi: QUOTER_V2_ABI, data });
    const p = v3.args[0];
    return encodeFunctionResult({
      abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
      result: [amountFor(p.tokenIn, p.tokenOut, p.amountIn), 0n, 0n, 0n],
    });
  } catch { /* not V3 */ }
  const v2 = decodeFunctionData({ abi: V2_ROUTER_ABI, data });
  const [amountIn, path] = v2.args;
  return encodeFunctionResult({
    abi: V2_ROUTER_ABI, functionName: "getAmountsOut",
    result: [amountIn, amountFor(path[0], path[path.length - 1], amountIn)],
  });
}

function makeClient(start = 100n) {
  const seen = [];
  let next = start;
  return {
    seen,
    blockReads: 0,
    async getBlockNumber() {
      this.blockReads++;
      return next++;
    },
    async getBlock({ blockNumber }) {
      seen.push(["block", blockNumber]);
      return { number: blockNumber, hash: "0x" + "11".repeat(32), timestamp: 1_700_000_000n };
    },
    async getGasPrice() { return 1_000_000_000n; },
    async getCode({ blockNumber }) {
      seen.push(["code", blockNumber]);
      return "0x6000";
    },
    async call({ data, blockNumber }) {
      seen.push(["call", blockNumber]);
      const meta = metadata(String(data).slice(0, 10));
      return { data: meta ?? quoteOut(data) };
    },
  };
}

const market = async () => ({
  priceUsd: 2000, liquidityUsd: 1_000_000, volume24hUsd: 100_000,
  buys24h: 100, sells24h: 100, priceChange24hPct: 1,
});

function assertSingleBlock(client, expected) {
  assert.equal(client.blockReads, 1, "getBlockNumber must be called exactly once");
  assert.ok(client.seen.length > 0, "the measurement must make calls");
  for (const [kind, blockNumber] of client.seen) {
    assert.equal(blockNumber, expected, `${kind} was called at ${blockNumber}, expected ${expected}`);
  }
}

console.log("\npinned block threading");

await check("preTradeCheck pins token facts, probes and both legs to one block", async () => {
  const client = makeClient(100n);
  const out = await preTradeCheck(1, {
    tokenAddress: WETH.address, intendedUsd: 500, baseSymbol: "USDC",
  }, { clientFactory: () => client, dexscreenerPair: market });
  assert.equal(out.ok, true);
  assert.equal(out.blockNumber, 100);
  assertSingleBlock(client, 100n);
});

await check("measureRoundTrip pins both round-trip legs and the gas quote", async () => {
  const client = makeClient(200n);
  const out = await measureRoundTrip(1, {
    baseSymbol: "USDC", targetSymbol: "WETH", size: 1_000n * 10n ** 6n,
  }, { clientFactory: () => client });
  assert.equal(out.ok, true);
  assert.equal(out.blockNumber, 200);
  assertSingleBlock(client, 200n);
});

await check("quoteAllVenues pins one block when the caller does not supply one", async () => {
  const client = makeClient(250n);
  const book = await quoteAllVenues(client, 1, {
    tokenIn: USDC.address, tokenOut: WETH.address, amountIn: 1_000_000n,
  });
  assert.ok(book.quoted.length > 0);
  assertSingleBlock(client, 250n);
});

await check("fairQuoteCheck uses the supplied block without reading latest", async () => {
  const client = makeClient(999n);
  const out = await fairQuoteCheck(1, {
    tokenIn: WETH.address,
    tokenOut: USDC.address,
    amountIn: 10n ** 18n,
    quotedOut: 2_000_000_000n,
    blockNumber: 300n,
  }, { clientFactory: () => client });
  assert.equal(out.ok, true);
  assert.equal(out.blockNumber, 300);
  assert.equal(client.blockReads, 0, "a supplied block must not trigger getBlockNumber");
  assert.ok(client.seen.length > 0);
  assert.ok(client.seen.every(([, n]) => n === 300n));
});

await check("bestRouteBook uses the supplied block without reading latest", async () => {
  const client = makeClient(999n);
  const book = await bestRouteBook(client, 1, {
    tokenIn: USDC.address, tokenOut: WETH.address, amountIn: 1_000_000n, blockNumber: 350n,
  });
  assert.ok(book.quoted.length > 0);
  assert.equal(client.blockReads, 0);
  assert.ok(client.seen.every(([, n]) => n === 350n));
});

await check("depthProfile pins token facts and every rung to the supplied block", async () => {
  const client = makeClient(999n);
  const out = await depthProfile(1, {
    tokenAddress: "WETH",
    baseSymbol: "USDC",
    sizesUsd: [100, 1_000],
    blockNumber: 400n,
  }, { clientFactory: () => client, dexscreenerPair: async () => null });
  assert.equal(out.ok, true);
  assert.equal(out.blockNumber, 400);
  assert.equal(client.blockReads, 0);
  assert.ok(client.seen.length > 0);
  assert.ok(client.seen.every(([, n]) => n === 400n));
});

console.log(`\npinned-block: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
