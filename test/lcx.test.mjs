// LCX Liberty DEX support in the free gate. Calldata here is synthetic, built
// in the layout observed in LCX's own POST /v1/swap responses; LCX's raw
// samples are not published in this repository (Phase 1 agreement: LCX sees
// raw results before anything is public).
//
//   node --test test/lcx.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../src/preflight.mjs";
import { knownRouter, decodeLcxCall, bindQuote, LCX_SWAP_SELECTOR } from "../src/routers.mjs";

const NOW = 1_800_000_000_000;
const ROUTER = "0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0";
// Lower-case: a valid address with no checksum to fail, so the tests reach
// the router and quote checks rather than stopping at invalid_to.
const LOOKALIKE = "0x0000000000b1ae06c96ab73ff4360d7aeaab56f1";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const TAKER = "0x1111111111111111111111111111111111111111";
const THIEF = "0x9999999999999999999999999999999999999999";

const w = (v) => BigInt(v).toString(16).padStart(64, "0");
const a = (addr) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function lcxCalldata({
  tokenIn = USDC, tokenOut = WETH, amountIn = 100_000_000n, minOut = 58_926_618_511_296_721n,
  recipient = TAKER, deadline = Math.floor(NOW / 1000) + 300, routeWords = 4,
} = {}) {
  const head = [a(tokenIn), a(tokenOut), w(amountIn), w(minOut), a(recipient), w(deadline), w(7 * 32)];
  const route = [w(routeWords * 32 - 32), ...Array.from({ length: routeWords - 1 }, (_, i) => w(i + 1))];
  return LCX_SWAP_SELECTOR + head.join("") + route.join("");
}

function quote(overrides = {}) {
  return {
    spender: ROUTER,
    input: { amount: "100000000", token: { address: USDC, symbol: "USDC" } },
    output: { amount: "59222732172157509", minimumAmount: "58926618511296721", token: { address: WETH, symbol: "WETH" } },
    expiresAt: Math.floor(NOW / 1000) + 120,
    ...overrides,
  };
}

function fakeClient() {
  return {
    async getBlock() { return { number: 123n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(NOW / 1000) }; },
    async getCode() { return "0x6000"; },
    async call() { return { data: "0x" }; },
    async readContract() { return 0n; },
  };
}

function run(body) {
  return preflight({ kind: "transaction", ...body }, { clientFactory: () => fakeClient(), now: NOW });
}
const codes = (r) => r.reasons.map((x) => x.code);
const tx = (data, to = ROUTER, chainId = 8453) => ({ chainId, to, data, value: "0" });

test("router registry: LCX by chain and address only", () => {
  assert.equal(knownRouter(8453, ROUTER)?.id, "lcx");
  assert.equal(knownRouter(8453, ROUTER.toLowerCase())?.id, "lcx");
  assert.equal(knownRouter(1, ROUTER)?.id, "lcx");
  assert.equal(knownRouter(42161, ROUTER)?.id, "lcx");
  assert.equal(knownRouter(84532, ROUTER), null, "not deployed on Base Sepolia");
  assert.equal(knownRouter(8453, LOOKALIKE), null);
});

test("decoder reads the swap head and refuses malformed words", () => {
  const d = decodeLcxCall(lcxCalldata());
  assert.equal(d.protocol, "lcx-liberty");
  assert.equal(d.tokenIn, USDC.toLowerCase());
  assert.equal(d.tokenOut, WETH.toLowerCase());
  assert.equal(d.amountIn, "100000000");
  assert.equal(d.amountOutMinimum, "58926618511296721");
  assert.equal(d.recipient, TAKER.toLowerCase());
  assert.equal(decodeLcxCall("0x31ab353b" + "00".repeat(224)), null, "other selectors are not guessed");
  assert.equal(decodeLcxCall(lcxCalldata().slice(0, 10 + 64 * 5)), null, "truncated head");
  const dirty = lcxCalldata().replace(a(USDC), `ff${a(USDC).slice(2)}`);
  assert.equal(decodeLcxCall(dirty), null, "an address word with high bits set is not an address");
});

test("an LCX swap is named and its terms are checked (no more 'unrecognized')", async () => {
  const r = await run({ transaction: tx(lcxCalldata()), from: TAKER });
  assert.ok(!codes(r).includes("unrecognized_calldata"));
  assert.equal(r.decoded.protocol, "lcx-liberty");
  assert.equal(r.decoded.router.name, "LCX Liberty DEX");
  assert.ok(r.checked.includes("known_router"));
  assert.equal(r.verdict, "PASS", JSON.stringify(r.reasons));
  assert.ok(r.notChecked.some((n) => /upgradeable/.test(n)), "the upgradeable proxy is disclosed");
});

test("the same calldata on a look-alike address is NOT decoded as LCX", async () => {
  const r = await run({ transaction: tx(lcxCalldata(), LOOKALIKE), from: TAKER });
  assert.ok(codes(r).includes("unrecognized_calldata"));
  assert.ok(!r.checked.includes("known_router"));
});

test("output sent to someone other than the payer is flagged", async () => {
  const r = await run({ transaction: tx(lcxCalldata({ recipient: THIEF })), from: TAKER });
  assert.ok(codes(r).includes("swap_recipient_mismatch"));
  assert.notEqual(r.verdict, "PASS");
});

test("zero minimum and expired deadline are caught", async () => {
  const zero = await run({ transaction: tx(lcxCalldata({ minOut: 0n })), from: TAKER });
  assert.ok(codes(zero).includes("zero_min_out"));
  const late = await run({ transaction: tx(lcxCalldata({ deadline: Math.floor(NOW / 1000) - 10 })), from: TAKER });
  assert.ok(codes(late).includes("swap_deadline_expired"));
  assert.equal(late.verdict, "BLOCK");
});

test("quote binding: matching quote PASSes with quote_binding checked", async () => {
  const r = await run({ transaction: tx(lcxCalldata()), from: TAKER, quote: quote() });
  assert.equal(r.verdict, "PASS", JSON.stringify(r.reasons));
  assert.ok(r.checked.includes("quote_binding"));
});

test("quote binding: tampered bytes are BLOCKed", async () => {
  for (const [field, data] of [
    ["minimumAmount", lcxCalldata({ minOut: 1_000n })],
    ["amountIn", lcxCalldata({ amountIn: 999_000_000n })],
    ["tokenOut", lcxCalldata({ tokenOut: THIEF })],
  ]) {
    const r = await run({ transaction: tx(data), from: TAKER, quote: quote() });
    assert.equal(r.verdict, "BLOCK", field);
    const m = r.reasons.find((x) => x.code === "quote_terms_mismatch");
    assert.ok(m && m.message.includes(field), `${field} named in ${m?.message}`);
  }
});

test("quote binding: transaction sent to a router other than the quoted spender is BLOCKed", async () => {
  const r = await run({ transaction: tx(lcxCalldata(), LOOKALIKE), from: TAKER, quote: quote() });
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.some((x) => x.code === "quote_terms_mismatch" && x.message.includes("spender")));
});

test("quote binding: expired quote and wide floor are cautions", async () => {
  const old = await run({ transaction: tx(lcxCalldata()), from: TAKER, quote: quote({ expiresAt: Math.floor(NOW / 1000) - 1 }) });
  assert.ok(codes(old).includes("quote_expired"));
  const wide = quote({ output: { amount: "100000000000000000", minimumAmount: "58926618511296721", token: { address: WETH } } });
  const r = await run({ transaction: tx(lcxCalldata()), from: TAKER, quote: wide });
  assert.ok(codes(r).includes("wide_slippage_floor"));
});

test("an LCX method we cannot decode is named, not anonymous", async () => {
  const r = await run({ transaction: tx("0x31ab353b" + "00".repeat(64)), from: TAKER });
  assert.ok(codes(r).includes("router_call_not_decoded"));
  assert.ok(!codes(r).includes("unrecognized_calldata"));
  assert.equal(r.verdict, "CAUTION");
});

test("bindQuote rejects a non-object quote", () => {
  const b = bindQuote("nope", { to: ROUTER, decoded: null, nowMs: NOW });
  assert.equal(b.problems[0].code, "invalid_quote");
});
