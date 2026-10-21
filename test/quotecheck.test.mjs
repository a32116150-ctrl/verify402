// Fairness-audit tests. No framework - the same discipline as measure tests:
// the only thing that matters for a service sold on accuracy is that it can
// be caught lying.
//
//   node test/quotecheck.test.mjs
//
// Needs network access to a mainnet RPC.

import { clientFor, quoteAllVenues } from "../src/measure.mjs";
import { fairQuoteCheck } from "../src/quotecheck.mjs";
import { chain } from "../src/config.mjs";
import { rpcSetFor, testMode } from "./suite.mjs";

const RPC = rpcSetFor(import.meta.url);

let passed = 0;
let failed = 0;
let skipped = 0;

async function check(name, fn) {
  const mode = testMode(RPC.has(name));
  if (mode !== "run") {
    skipped++;
    console.log(`  ${name} ... SKIP (${mode === "skip-rpc" ? "requires RPC; TEST_OFFLINE=1" : "offline test; covered by test:offline"})`);
    return;
  }
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
const WETH = c.tokens.WETH.address;
const USDC = c.tokens.USDC.address;

console.log(`\nfairness-audit tests on ${c.name} (chainId ${CHAIN_ID})\n`);

// Shared block so every test quotes the same book. The promise is created
// inside the first RPC test, not at module top level: an unreachable RPC must
// produce per-test FAILs, never an unhandled top-level rejection.
let blockPromise = null;
function sharedBlock() {
  if (!blockPromise) blockPromise = client.getBlockNumber();
  return blockPromise;
}

// --- 1. a quote the chain itself produced must pass as fair ----------------
await check("a real chain quote audits as fair", async () => {
  const blockNumber = await sharedBlock();
  const oneEth = 10n ** 18n;
  const book = await quoteAllVenues(client, CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: oneEth, blockNumber, intermediates: ["WETH"],
  });
  assert(book.quoted.length > 0, "no venue quoted WETH->USDC 1.0 - test precondition gone");
  const honest = book.quoted[0].amountOut;
  const r = await fairQuoteCheck(CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: oneEth, quotedOut: honest,
  });
  assert(r.ok, r.error ?? "not ok");
  assert(r.verdict === "fair", `a chain-produced quote judged ${r.verdict}: ${JSON.stringify(r.notes)}`);
  return `${r.verdict}, ratio ${r.evidence.ratioVsChainBest.toFixed(4)}`;
});

// --- 2. half of a real quote must be overpaying ------------------------------
await check("a 50%-lowballed quote is overpaying", async () => {
  const blockNumber = await sharedBlock();
  const oneEth = 10n ** 18n;
  const book = await quoteAllVenues(client, CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: oneEth, blockNumber, intermediates: ["WETH"],
  });
  const lowball = (book.quoted[0].amountOut * 5n) / 10n;
  const r = await fairQuoteCheck(CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: oneEth, quotedOut: lowball,
  });
  assert(r.ok, r.error ?? "not ok");
  assert(r.verdict === "overpaying", `expected overpaying, got ${r.verdict}`);
  assert(r.evidence.shortfallBps > 1000, "shortfall should be ~5000 bps for a 50% haircut");
  return `${r.verdict}, shortfall ${r.evidence.shortfallBps.toFixed(1)} bps`;
});

// --- 3. many times the real quote is too good -------------------------------
await check("a doubled quote is too_good_to_be_true", async () => {
  const blockNumber = await sharedBlock();
  const oneEth = 10n ** 18n;
  const book = await quoteAllVenues(client, CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: oneEth, blockNumber, intermediates: ["WETH"],
  });
  const doubled = book.quoted[0].amountOut * 2n;
  const r = await fairQuoteCheck(CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: oneEth, quotedOut: doubled,
  });
  assert(r.ok, r.error ?? "not ok");
  assert(r.verdict === "too_good_to_be_true", `expected too_good_to_be_true, got ${r.verdict}`);
  return r.verdict;
});

// --- 4. the echo guard: offered == input is an echo, not a quote ------------
await check("offered exactly equal to amountIn is rejected as an echo", async () => {
  const r = await fairQuoteCheck(CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: 10n ** 18n, quotedOut: 10n ** 18n,
  });
  assert(r.ok !== undefined, "must return a result");
  assert(r.verdict === "too_good_to_be_true", `expected too_good_to_be_true for echo, got ${r.verdict}`);
  assert(String(r.error ?? "").includes("echo"), "reason must name the echo");
  return "echo rejected";
});

// --- 5. zero/invalid offers never crash, never pass -------------------------
await check("zero and garbage offers return unknown/bootstrap verdicts without crashing", async () => {
  const r0 = await fairQuoteCheck(CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: 10n ** 18n, quotedOut: 0,
  });
  assert(r0.verdict === "unknown", `zero offer: expected unknown, got ${r0.verdict}`);
  const rg = await fairQuoteCheck(CHAIN_ID, {
    tokenIn: WETH, tokenOut: USDC, amountIn: 10n ** 18n, quotedOut: "not-a-number",
  });
  assert(rg.verdict !== "fair", "garbage offer must not pass as fair");
  return `zero=${r0.verdict}, garbage=${rg.verdict}`;
});

// --- 6. unknown token pair is unknown, not a verdict -------------------------
await check("a pair with no liquidity returns unknown", async () => {
  const r = await fairQuoteCheck(CHAIN_ID, {
    tokenIn: USDC,
    tokenOut: "0x000000000000000000000000000000000000dEaD", // burn address: no code, no pools
    amountIn: 10n ** 6n,
    quotedOut: "12345",
  });
  assert(r.verdict === "unknown", `expected unknown for dead pair, got ${r.verdict}`);
  return r.verdict;
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
