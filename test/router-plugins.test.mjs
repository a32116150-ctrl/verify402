// Router plug-ins and quote binding in the free gate. The router here is
// made up: a fixed address, a made-up selector and a simple head layout
// (tokenIn, tokenOut, amountIn, minOut, recipient, deadline).
//
//   node --test test/router-plugins.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflight } from "../src/preflight.mjs";
import { knownRouter, loadRouterPlugins, bindQuote } from "../src/routers.mjs";

const NOW = 1_800_000_000_000;
const ROUTER = "0x00000000000000000000000000000000000a11ce";
const LOOKALIKE = "0x00000000000000000000000000000000000a11cf";
const SELECTOR = "0xa1b2c3d4";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
const TAKER = "0x1111111111111111111111111111111111111111";
const THIEF = "0x9999999999999999999999999999999999999999";

const w = (v) => BigInt(v).toString(16).padStart(64, "0");
const a = (addr) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

// A plug-in module, written to disk and loaded the way production loads one.
const dir = mkdtempSync(join(tmpdir(), "v402-router-"));
const pluginPath = join(dir, "example-router.mjs");
writeFileSync(pluginPath, `
const addr = (h) => /^0{24}[0-9a-f]{40}$/.test(h) ? "0x" + h.slice(24) : null;
export const routers = [{
  id: "example", name: "Example Router", upgradeable: true,
  deployments: { "${ROUTER}": [8453] },
  decode(data) {
    const d = String(data).toLowerCase();
    if (d.slice(0, 10) !== "${SELECTOR}") return null;
    const b = d.slice(10); if (b.length < 6 * 64) return null;
    const word = (i) => b.slice(i * 64, i * 64 + 64);
    const tokenIn = addr(word(0)), tokenOut = addr(word(1)), recipient = addr(word(4));
    if (!tokenIn || !tokenOut || !recipient) return null;
    return { action: "swap", protocol: "example", tokenIn, tokenOut,
      amountIn: BigInt("0x" + word(2)).toString(), amountOutMinimum: BigInt("0x" + word(3)).toString(),
      recipient, deadline: Number(BigInt("0x" + word(5))), notChecked: ["example route legs are not decoded"] };
  },
}];
`);
await loadRouterPlugins(pluginPath);

function calldata({ tokenIn = USDC, tokenOut = WETH, amountIn = 100_000_000n, minOut = 59_000_000_000_000_000n,
  recipient = TAKER, deadline = Math.floor(NOW / 1000) + 300 } = {}) {
  return SELECTOR + [a(tokenIn), a(tokenOut), w(amountIn), w(minOut), a(recipient), w(deadline)].join("");
}

function quote(overrides = {}) {
  return {
    spender: ROUTER,
    input: { amount: "100000000", token: { address: USDC } },
    output: { amount: "59300000000000000", minimumAmount: "59000000000000000", token: { address: WETH } },
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

const run = (body) => preflight({ kind: "transaction", ...body }, { clientFactory: () => fakeClient(), now: NOW });
const codes = (r) => r.reasons.map((x) => x.code);
const tx = (data, to = ROUTER, chainId = 8453) => ({ chainId, to, data, value: "0" });

test("a plug-in router is recognised by chain and address only", () => {
  assert.equal(knownRouter(8453, ROUTER)?.id, "example");
  assert.equal(knownRouter(1, ROUTER), null, "not deployed on that chain");
  assert.equal(knownRouter(8453, LOOKALIKE), null);
});

test("a plug-in swap is decoded, named and checked", async () => {
  const r = await run({ transaction: tx(calldata()), from: TAKER });
  assert.equal(r.verdict, "PASS", JSON.stringify(r.reasons));
  assert.equal(r.decoded.router.name, "Example Router");
  assert.ok(r.checked.includes("known_router"));
  assert.ok(r.notChecked.some((n) => /upgradeable/.test(n)));
  assert.ok(r.notChecked.includes("example route legs are not decoded"));
});

test("the same bytes on a look-alike address are not decoded", async () => {
  const r = await run({ transaction: tx(calldata(), LOOKALIKE), from: TAKER });
  assert.ok(codes(r).includes("unrecognized_calldata"));
});

test("recipient, zero minimum and deadline checks apply to plug-in swaps", async () => {
  assert.ok(codes(await run({ transaction: tx(calldata({ recipient: THIEF })), from: TAKER })).includes("swap_recipient_mismatch"));
  assert.ok(codes(await run({ transaction: tx(calldata({ minOut: 0n })), from: TAKER })).includes("zero_min_out"));
  const late = await run({ transaction: tx(calldata({ deadline: Math.floor(NOW / 1000) - 10 })), from: TAKER });
  assert.equal(late.verdict, "BLOCK");
});

test("quote binding: matching quote PASSes; tampered bytes BLOCK", async () => {
  const ok = await run({ transaction: tx(calldata()), from: TAKER, quote: quote() });
  assert.equal(ok.verdict, "PASS", JSON.stringify(ok.reasons));
  assert.ok(ok.checked.includes("quote_binding"));
  for (const [field, data] of [
    ["minimumAmount", calldata({ minOut: 1_000n })],
    ["amountIn", calldata({ amountIn: 999_000_000n })],
    ["tokenOut", calldata({ tokenOut: THIEF })],
  ]) {
    const r = await run({ transaction: tx(data), from: TAKER, quote: quote() });
    assert.equal(r.verdict, "BLOCK", field);
    assert.ok(r.reasons.find((x) => x.code === "quote_terms_mismatch")?.message.includes(field));
  }
});

test("quote binding: wrong contract, expired quote, wide floor", async () => {
  const wrong = await run({ transaction: tx(calldata(), LOOKALIKE), from: TAKER, quote: quote() });
  assert.equal(wrong.verdict, "BLOCK");
  const old = await run({ transaction: tx(calldata()), from: TAKER, quote: quote({ expiresAt: Math.floor(NOW / 1000) - 1 }) });
  assert.ok(codes(old).includes("quote_expired"));
  const wide = await run({ transaction: tx(calldata()), from: TAKER,
    quote: quote({ output: { amount: "100000000000000000", minimumAmount: "59000000000000000", token: WETH } }) });
  assert.ok(codes(wide).includes("wide_slippage_floor"));
});

test("an undecoded method on a known router is named, not anonymous", async () => {
  const r = await run({ transaction: tx("0xdeadbeef" + "00".repeat(64)), from: TAKER });
  assert.ok(codes(r).includes("router_call_not_decoded"));
  assert.equal(r.verdict, "CAUTION");
});

test("bindQuote rejects a non-object quote", () => {
  assert.equal(bindQuote("nope", { to: ROUTER, decoded: null, nowMs: NOW }).problems[0].code, "invalid_quote");
});
