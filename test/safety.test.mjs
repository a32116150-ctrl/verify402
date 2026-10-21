// Offline safety tests (C-2 / C-3 / H-1).
//
// Every dependency is injected: a fake chain client, a fake market lookup and
// no network. The contract under test:
//   * transport/decode failures abort with ok:false, never AVOID/TRUST
//   * a quote-based sellability result is labelled as such
//   * checked[]/notChecked[] are always present and list the untested
//     transfer restrictions and unconfigured venues
//
//   node test/safety.test.mjs

import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { preTradeCheck } from "../src/safety.mjs";
import { QUOTER_V2_ABI, V2_ROUTER_ABI } from "../src/measure.mjs";
import { CHAINS } from "../src/config.mjs";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

const C = CHAINS[1];
const TOKEN = "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE";
const USDC = C.tokens.USDC;

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
      functionName: "symbol", result: "TEST",
    });
  }
  if (sel === SELECTORS.name) {
    return encodeFunctionResult({
      abi: [{ inputs: [], outputs: [{ type: "string" }], name: "name", stateMutability: "view", type: "function" }],
      functionName: "name", result: "Test Token",
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

function healthyClient(overrides = {}) {
  return {
    async getCode() { return "0x6000"; },
    async getBlockNumber() { return 123n; },
    async call({ data }) {
      const sel = data.slice(0, 10);
      const meta = metadata(sel);
      if (meta) return { data: meta };
      return { data: quoteOut(data) };
    },
    ...overrides,
  };
}

const market = async () => ({
  priceUsd: 2000, liquidityUsd: 1_000_000, volume24hUsd: 100_000,
  buys24h: 100, sells24h: 100, priceChange24hPct: 1,
});
const noMarket = async () => null;

const run = (client, ds = market) => preTradeCheck(1, {
  tokenAddress: TOKEN, intendedUsd: 500, baseSymbol: "USDC",
}, { clientFactory: () => client, dexscreenerPair: ds });

console.log("\nsafety (quote-based sellability)");

await check("healthy token is TRUST with a quote-based sellability claim", async () => {
  const out = await run(healthyClient());
  assert.equal(out.ok, true);
  assert.equal(out.verdict, "TRUST");
  assert.equal(out.quote_status, "ok");
  assert.ok(out.checked.includes("quote-based sellability"));
  assert.ok(out.checked.includes("liquidity"));
  assert.ok(!out.checked.includes("sellability"), "the old ambiguous label must not be used");
  assert.ok(out.notChecked.includes("actual token transfer or sell execution"));
  assert.ok(out.notChecked.includes("transfer tax / fee-on-transfer"));
  assert.ok(out.notChecked.some((s) => /Aerodrome|Curve|Balancer/.test(s)), "unconfigured venues are named");
  assert.match(out.evidence.sellability.caveat, /quote-based only/i);
});

await check("no contract code is an AVOID market fact, never a transport failure", async () => {
  const out = await run(healthyClient({ async getCode() { return "0x"; } }));
  assert.equal(out.ok, true);
  assert.equal(out.verdict, "AVOID");
  assert.equal(out.quote_status, "no_pool");
  assert.ok(out.reasons.length > 0);
});

await check("getCode transport failure aborts with ok:false transport", async () => {
  const out = await run(healthyClient({ async getCode() { throw new Error("fetch failed"); } }));
  assert.equal(out.ok, false);
  assert.equal(out.kind, "transport");
  assert.equal(out.quote_status, "failed");
  assert.equal(out.verdict, undefined, "a provider outage is not a verdict");
  assert.ok(out.notChecked.some((s) => /could not be read/i.test(s)));
});

await check("malformed metadata (decode/unrevert) is AVOID, not a provider failure", async () => {
  const out = await run(healthyClient({
    async call({ data }) {
      if (data.startsWith(SELECTORS.decimals)) return { data: "0xdeadbeef" };
      return healthyClient().call({ data });
    },
  }));
  assert.equal(out.verdict, "AVOID");
  assert.equal(out.ok, true);
  assert.ok(out.reasons.some((r) => /decimals|ERC-20/i.test(r)));
});

await check("quote transport failure aborts with ok:false transport (no AVOID)", async () => {
  const out = await run(healthyClient({
    async call({ data }) {
      if (metadata(data.slice(0, 10))) return { data: metadata(data.slice(0, 10)) };
      throw new Error("429 Too Many Requests");
    },
  }));
  assert.equal(out.ok, false);
  assert.equal(out.kind, "transport");
  assert.equal(out.quote_status, "failed");
  assert.notEqual(out.verdict, "AVOID");
});

await check("all venues empty is AVOID/no_pool, and the limits are still stated", async () => {
  const out = await run(healthyClient({
    async call({ data }) {
      const sel = data.slice(0, 10);
      if (metadata(sel)) return { data: metadata(sel) };
      return { data: "0x" };
    },
  }));
  assert.equal(out.ok, true);
  assert.equal(out.verdict, "AVOID");
  assert.equal(out.quote_status, "no_pool");
  assert.equal(out.unavailable_reason, "no_pool");
  assert.ok(out.checked.length > 0);
  assert.ok(out.notChecked.length > 0);
});

await check("no external price still probes and says the probe was token-sized", async () => {
  const out = await run(healthyClient(), noMarket);
  assert.equal(out.ok, true);
  assert.ok(out.notChecked.includes("external market price (none available)"));
  assert.ok(out.notes.some((n) => /no external price/i.test(n)));
  assert.equal(out.evidence.sellability.probedInUsd, null);
});

console.log(`\nsafety: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
