// Advice on a transaction preflight: preview, explanation, fixes, paid hints,
// and plug-in enrichers. Advice must never change the verdict.
//
//   node --test test/preflight-advice.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeFunctionData, parseAbi } from "viem";
import { preflight } from "../src/preflight.mjs";
import { loadRouterPlugins } from "../src/routers.mjs";
import { formatAmount } from "../src/preflight-advice.mjs";

const NOW = 1_800_000_000_000;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const FROM = "0x1111111111111111111111111111111111111111";
const OTHER = "0x9999999999999999999999999999999999999999";
const UNKNOWN_TOKEN = "0x00000000000000000000000000000000000c0de0";

// One enricher that answers and one that throws: the throw must be ignored.
const dir = mkdtempSync(join(tmpdir(), "v402-advice-"));
const plugin = join(dir, "enricher.mjs");
writeFileSync(plugin, `
export const enrichers = [
  async (ctx) => ({ involved: [{ address: String(ctx.to).toLowerCase(), roles: ["called"], label: "Test Label" }], risk: { summary: "test risk" } }),
  async () => { throw new Error("enricher down"); },
];
`);
await loadRouterPlugins(plugin);

function fakeClient(overrides = {}) {
  return {
    async getBlock() { return { number: 123n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(NOW / 1000) }; },
    async getCode() { return "0x6000"; },
    async call() { return { data: "0x" }; },
    async readContract({ functionName }) {
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return "ODD";
      return 0n;
    },
    async estimateGas() { return 100_000n; },
    async getGasPrice() { return 1_000_000_000n; },
    ...overrides,
  };
}
const run = (body, client = fakeClient()) => preflight({ kind: "transaction", ...body }, { clientFactory: () => client, now: NOW });

const V3 = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)"]);
function v3Swap({ tokenIn = USDC, tokenOut = WETH, recipient = FROM, amountIn = 100_000_000n, min = 59_000_000_000_000_000n, deadline = NOW / 1000 + 300 } = {}) {
  return encodeFunctionData({ abi: V3, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut, fee: 500, recipient, deadline: BigInt(deadline), amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n }] });
}
const approve = (spender, amount) => encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [spender, amount] });
const transfer = (to, amount) => encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [to, amount] });

test("formatAmount trims long decimals", () => {
  assert.equal(formatAmount("100000000", { decimals: 6 }), "100");
  assert.equal(formatAmount("58926618511296721", { decimals: 18 }), "0.058926");
  assert.equal(formatAmount("123", null), "123");
});

test("swap: preview, plain explanation, network fee", async () => {
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap(), value: "0" }, from: FROM });
  assert.equal(r.verdict, "PASS", JSON.stringify(r.reasons));
  const [send, min] = r.advice.preview.effects;
  assert.deepEqual([send.kind, send.amount, send.token.symbol, send.usd], ["send", "100", "USDC", 100]);
  assert.deepEqual([min.kind, min.amount, min.token.symbol], ["receive_at_least", "0.059", "WETH"]);
  assert.match(r.advice.explanation, /^Swap 100 USDC for at least 0\.059 WETH via uniswap-v3, paid to your wallet\./);
  assert.match(r.advice.explanation, /within about 5 minutes/);
  assert.equal(r.advice.preview.networkFee.gas, "100000");
  assert.equal(r.advice.fixes.length, 0);
});

test("advice never changes the verdict or the reasons", async () => {
  const body = { transaction: { chainId: 8453, to: ROUTER, data: v3Swap({ min: 0n }), value: "0" }, from: FROM };
  const r = await run(body);
  const { advice, ...rest } = r;
  assert.ok(advice);
  assert.equal(rest.verdict, "CAUTION");
  assert.ok(rest.reasons.some((x) => x.code === "zero_min_out"));
  assert.equal(rest.receipt.verdict ?? rest.verdict, "CAUTION");
});

test("fixes: zero minimum suggests a floor from the quote", async () => {
  const quote = { spender: ROUTER, input: { amount: "100000000", token: USDC }, output: { amount: "59300000000000000", minimumAmount: "0", token: WETH } };
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap({ min: 0n }), value: "0" }, from: FROM, quote });
  const fix = r.advice.fixes.find((f) => f.for === "zero_min_out");
  assert.equal(fix.suggested.amountOutMinimum, "59003500000000000");
  assert.match(fix.action, /at least 0\.059003 WETH/);
});

test("fixes: tampered transaction lists each difference against the quote", async () => {
  const quote = { spender: ROUTER, input: { amount: "100000000", token: { address: USDC } }, output: { amount: "59300000000000000", minimumAmount: "59000000000000000", token: { address: WETH } } };
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap({ min: 1n }), value: "0" }, from: FROM, quote });
  assert.equal(r.verdict, "BLOCK");
  const fix = r.advice.fixes.find((f) => f.for === "quote_terms_mismatch");
  assert.deepEqual(fix.differences, [{ field: "minimumAmount", transaction: "1", quote: "59000000000000000" }]);
  assert.match(r.advice.explanation, /Do not sign\./);
});

test("fixes: recipient and missing from", async () => {
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap({ recipient: OTHER }), value: "0" }, from: FROM });
  assert.equal(r.advice.fixes.find((f) => f.for === "swap_recipient_mismatch").suggested.recipient, FROM);
  const n = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap(), value: "0" } });
  assert.ok(n.advice.fixes.some((f) => f.for === "simulation_skipped_no_from"));
  assert.equal(n.advice.preview.networkFee, undefined, "no fee without a simulated signer");
});

test("native coin: each chain names its own coin (BNB, POL, ETH)", async () => {
  const send = (chainId) => run({ transaction: { chainId, to: OTHER, data: "0x", value: "1000000000000000000" }, from: FROM });
  const bnb = await send(56);
  assert.match(bnb.advice.explanation, /^Send 1 BNB to 0x9999…9999\./);
  assert.equal(bnb.advice.preview.networkFee.symbol, "BNB");
  assert.equal(bnb.advice.preview.networkFee.eth, undefined, "no ETH field for a BNB fee");
  assert.match((await send(137)).advice.explanation, /^Send 1 POL /);
  const base = await send(8453);
  assert.match(base.advice.explanation, /^Send 1 ETH /);
  assert.equal(base.advice.preview.networkFee.eth, base.advice.preview.networkFee.amount, "ETH chains keep the eth field");
});

test("gate-only chain: known dollar coins are priced (Polygon USDC)", async () => {
  const r = await run({ transaction: { chainId: 137, to: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", data: transfer(OTHER, 2_500_000n), value: "0" }, from: FROM });
  assert.match(r.advice.explanation, /^Send 2\.5 USDC to 0x9999…9999\./);
  assert.equal(r.advice.preview.effects[0].usd, 2.5);
});

test("approve: unlimited allowance is spelled out", async () => {
  const r = await run({ transaction: { chainId: 8453, to: USDC, data: approve(OTHER, 2n ** 256n - 1n), value: "0" }, from: FROM });
  const allow = r.advice.preview.effects[0];
  assert.equal(allow.kind, "allow");
  assert.equal(allow.unlimited, true);
  assert.match(r.advice.explanation, /spend ALL of your USDC, with no limit/);
  assert.ok(r.advice.fixes.some((f) => f.for === "unlimited_approval"));
});

test("transfer: amount and recipient in the preview", async () => {
  const r = await run({ transaction: { chainId: 8453, to: USDC, data: transfer(OTHER, 2_500_000n), value: "0" }, from: FROM });
  assert.match(r.advice.explanation, /^Send 2\.5 USDC to 0x9999…9999\./);
  assert.equal(r.advice.preview.effects[0].usd, 2.5);
});

test("paid hints: unknown output token suggests the token safety check", async () => {
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap({ tokenOut: UNKNOWN_TOKEN }), value: "0" }, from: FROM });
  const up = r.advice.upgrades.find((u) => u.tool === "check_token_safety");
  assert.equal(up.price, "$0.02");
  assert.equal(up.input.tokenAddress, UNKNOWN_TOKEN);
  assert.ok(r.advice.upgrades.length <= 2);
});

test("plug-in enrichers add involved and risk; a failing enricher is ignored", async () => {
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap(), value: "0" }, from: FROM });
  assert.equal(r.advice.involved[0].label, "Test Label");
  assert.equal(r.advice.risk.summary, "test risk");
  assert.equal(r.verdict, "PASS");
});

test("risk limit: under the limit passes and is listed as checked", async () => {
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap(), value: "0" }, from: FROM, policy: { maxRiskUsd: 500 } });
  assert.equal(r.verdict, "PASS", JSON.stringify(r.reasons));
  assert.ok(r.checked.includes("risk_limit"));
  assert.deepEqual(r.advice.riskLimit, { limitUsd: 500, atRiskUsd: 100, basis: "what leaves the wallet", within: true });
});

test("risk limit: over the limit is BLOCK with a fix", async () => {
  const r = await run({ transaction: { chainId: 8453, to: USDC, data: transfer(OTHER, 2_000_000_000n), value: "0" }, from: FROM, policy: { maxRiskUsd: 500 } });
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.some((x) => x.code === "risk_over_limit" && /\$2000/.test(x.message)));
  assert.equal(r.advice.riskLimit.within, false);
  assert.ok(r.advice.fixes.some((f) => f.for === "risk_over_limit"));
});

test("risk limit: an unpriceable token is CAUTION, never a guess", async () => {
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: v3Swap({ tokenIn: UNKNOWN_TOKEN }), value: "0" }, from: FROM, policy: { maxRiskUsd: 500 } });
  assert.notEqual(r.verdict, "PASS");
  assert.ok(r.reasons.some((x) => x.code === "risk_unmeasured"));
  assert.ok(r.notChecked.includes("risk_limit"));
  assert.equal(r.advice.riskLimit.atRiskUsd, null);
});

test("risk limit: no limit set changes nothing; a bad limit is rejected", async () => {
  const r = await run({ transaction: { chainId: 8453, to: USDC, data: transfer(OTHER, 2_000_000_000n), value: "0" }, from: FROM });
  assert.ok(!r.reasons.some((x) => x.code.startsWith("risk_")));
  assert.equal(r.advice.riskLimit, undefined);
  await assert.rejects(run({ transaction: { chainId: 8453, to: USDC, data: transfer(OTHER, 1n), value: "0" }, from: FROM, policy: { maxRiskUsd: -5 } }), /maxRiskUsd/);
});

test("an unreadable contract call still gets an explanation", async () => {
  const r = await run({ transaction: { chainId: 8453, to: ROUTER, data: "0xdeadbeef", value: "0" }, from: FROM });
  assert.match(r.advice.explanation, /does not read/);
  assert.ok(r.advice.fixes.some((f) => f.for === "unrecognized_calldata"));
});
