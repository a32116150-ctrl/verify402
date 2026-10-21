// C-2 typed-quote tests. No network: every client is injected.
//
// The contract under test: transport/decode failures are hard failures that
// must abort a measurement (ok:false), never become a market verdict such as
// no_pool / AVOID / unknown. Only a genuine empty/reverting venue may become
// "unavailable".
//
//   node test/measure-typed.test.mjs

import assert from "node:assert/strict";
import { encodeFunctionResult } from "viem";
import {
  quoteV3, quoteV2, quoteAllVenues, measureRoundTrip, isHardQuoteFailure, classifyQuoteError,
  V2_ROUTER_ABI,
} from "../src/measure.mjs";
import { CHAINS } from "../src/config.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

const C = CHAINS[1];
const blockNumber = 123n;

const clientCall = (fn) => ({
  async getBlockNumber() { return blockNumber; },
  async getBlock() { return { number: blockNumber, hash: "0x" + "11".repeat(32), timestamp: 1_700_000_000n }; },
  async getGasPrice() { return 1_000_000_000n; },
  async call(args) { return fn(args); },
});

console.log("\ntyped quote failures");

await checkAsync("quoteV3: transport -> typed transport, never no_pool", async () => {
  const r = await quoteV3(clientCall(() => { throw new Error("fetch failed http://secret"); }), {
    quoter: C.quoterV2, tokenIn: C.tokens.USDC.address, tokenOut: C.tokens.WETH.address,
    amountIn: 1_000_000n, fee: 500, blockNumber,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "transport");
  assert.equal(isHardQuoteFailure(r), true);
});

await checkAsync("quoteV3: undecodable provider data -> typed decode, never no_pool", async () => {
  const r = await quoteV3(clientCall(() => ({ data: "0xdeadbeef" })), {
    quoter: C.quoterV2, tokenIn: C.tokens.USDC.address, tokenOut: C.tokens.WETH.address,
    amountIn: 1_000_000n, fee: 500, blockNumber,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "decode");
  assert.equal(isHardQuoteFailure(r), true);
});

await checkAsync("quoteV3: an empty answer is a legitimate no_pool, not a hard failure", async () => {
  const r = await quoteV3(clientCall(() => ({ data: "0x" })), {
    quoter: C.quoterV2, tokenIn: C.tokens.USDC.address, tokenOut: C.tokens.WETH.address,
    amountIn: 1_000_000n, fee: 500, blockNumber,
  });
  assert.equal(r.kind, "no_pool");
  assert.equal(isHardQuoteFailure(r), false);
});

await checkAsync("quoteV2: transport -> hard failure", async () => {
  const r = await quoteV2(clientCall(() => { throw new Error("ECONNREFUSED"); }), {
    router: C.v2Routers[0].address, tokenIn: C.tokens.USDC.address, tokenOut: C.tokens.WETH.address,
    amountIn: 1_000_000n, blockNumber,
  });
  assert.equal(r.kind, "transport");
  assert.equal(isHardQuoteFailure(r), true);
});

await checkAsync("quoteV2: an exact 1:1 output is a legitimate quote, not an echo", async () => {
  const amountIn = 1_000_000n;
  const r = await quoteV2(clientCall(() => ({
    data: encodeFunctionResult({
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      result: [amountIn, amountIn],
    }),
  })), {
    router: C.v2Routers[0].address,
    tokenIn: C.tokens.USDC.address,
    tokenOut: C.tokens.USDT.address,
    amountIn,
    blockNumber,
  });
  assert.equal(r.ok, true);
  assert.equal(r.amountOut, amountIn);
  assert.equal(isHardQuoteFailure(r), false);
});

await checkAsync("quoteV2: a wrong-shaped getAmountsOut result is still a decode failure", async () => {
  const amountIn = 1_000_000n;
  const r = await quoteV2(clientCall(() => ({
    data: encodeFunctionResult({
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      result: [amountIn],
    }),
  })), {
    router: C.v2Routers[0].address,
    tokenIn: C.tokens.USDC.address,
    tokenOut: C.tokens.USDT.address,
    amountIn,
    blockNumber,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "decode");
  assert.equal(isHardQuoteFailure(r), true);
});

await checkAsync("quoteAllVenues: any transport failure aborts the whole book", async () => {
  const book = await quoteAllVenues(clientCall((args) => {
    // Let some venues answer cleanly, one venue fail. A partial book must not
    // be used to issue a verdict.
    if (args.to === C.v2Routers[0].address) throw new Error("429 Too Many Requests");
    return { data: "0x" };
  }), 1, {
    tokenIn: C.tokens.USDC.address,
    tokenOut: C.tokens.WETH.address,
    amountIn: 1_000_000n,
    blockNumber,
  });
  assert.equal(book.quote_status, "failed");
  assert.ok(book.hard_failure);
  assert.equal(book.hard_failure.kind, "transport");
  assert.ok(book.unavailable.length > 0, "no_pool venues are still recorded as market facts");
});

await checkAsync("quoteAllVenues: all no_pool is a market fact, not a failure", async () => {
  const book = await quoteAllVenues(clientCall(() => ({ data: "0x" })), 1, {
    tokenIn: C.tokens.USDC.address,
    tokenOut: C.tokens.WETH.address,
    amountIn: 1_000_000n,
    blockNumber,
  });
  assert.equal(book.quoted.length, 0);
  assert.equal(book.hard_failure, null);
  assert.equal(book.quote_status, "no_pool");
});

await checkAsync("measureRoundTrip: transport on the block read -> ok:false, no verdict", async () => {
  const r = await measureRoundTrip(1, {
    baseSymbol: "USDC", targetSymbol: "WETH", size: 1_000_000n,
  }, {
    clientFactory: () => ({
      async getBlockNumber() { throw new Error("fetch failed"); },
      async getBlock() { throw new Error("unreachable"); },
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "transport");
  assert.equal(r.quote_status, "failed");
  assert.equal(r.verdict, undefined, "a transport failure must never carry a verdict");
});

await checkAsync("measureRoundTrip: decode failure -> ok:false, no AVOID/no_edge", async () => {
  const r = await measureRoundTrip(1, {
    baseSymbol: "USDC", targetSymbol: "WETH", size: 1_000_000n,
  }, {
    clientFactory: () => clientCall(() => ({ data: "0x1234" })),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "decode");
  assert.equal(r.quote_status, "failed");
  assert.equal(r.verdict, undefined);
});

await checkAsync("measureRoundTrip: all venues empty -> ok:false no_pool (a market fact)", async () => {
  const r = await measureRoundTrip(1, {
    baseSymbol: "USDC", targetSymbol: "WETH", size: 1_000_000n,
  }, {
    clientFactory: () => clientCall(() => ({ data: "0x" })),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "no_pool");
  assert.equal(r.quote_status, "no_pool");
  assert.equal(r.unavailable_reason, "no_pool");
  assert.equal(r.verdict, undefined);
});

check("classifyQuoteError: a revert is a market fact, a timeout is transport", () => {
  assert.equal(classifyQuoteError(new Error("execution reverted")).kind, "revert");
  assert.equal(classifyQuoteError(new Error("The operation timed out")).kind, "transport");
  assert.equal(classifyQuoteError(new Error("429 Too Many Requests")).reason, "rate_limited");
});

console.log(`\nmeasure-typed: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
