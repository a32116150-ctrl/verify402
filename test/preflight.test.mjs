// Unit tests for the pre-signing gate. No network: the chain client is
// injected, so every verdict, reason code and receipt is deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { preflight, verifyReceipt, intentHash, PreflightError } from "../src/preflight.mjs";

const NOW = 1_700_000_000_000;
const FROM = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BLOCK_HASH = "0x" + "ab".repeat(32);

const ABI_APPROVE = parseAbi(["function approve(address spender, uint256 amount)"]);
const ABI_TRANSFER = parseAbi(["function transfer(address to, uint256 amount)"]);

function fakeClient(overrides = {}) {
  return {
    async getBlock() {
      return { number: 123n, hash: BLOCK_HASH, timestamp: BigInt(NOW / 1000) };
    },
    async getCode() {
      return "0x6000";
    },
    async call() {
      return { data: "0x" };
    },
    async readContract({ functionName }) {
      if (functionName === "balanceOf") return 10_000_000n;
      if (functionName === "decimals") return 6;
      if (functionName === "symbol") return "USDC";
      return 0n;
    },
    ...overrides,
  };
}

function run(input, client = fakeClient()) {
  return preflight(input, { clientFactory: () => client, now: NOW });
}

function payment(overrides = {}) {
  return {
    kind: "payment",
    payment: {
      scheme: "exact",
      network: "eip155:8453",
      asset: USDC,
      amount: "10000",
      payTo: PAY_TO,
      resource: "https://verify402.onrender.com/verify",
      maxTimeoutSeconds: 60,
      ...overrides.payment,
    },
    from: FROM,
    policy: { maxAmountUsd: 0.25, ...overrides.policy },
  };
}

function tx(data, overrides = {}) {
  return {
    kind: "transaction",
    chainId: 8453,
    from: FROM,
    to: USDC,
    data,
    value: "0",
    ...overrides,
  };
}

test("payment: canonical USDC with enough balance is PASS and the receipt verifies", async () => {
  const out = await run(payment());
  assert.equal(out.verdict, "PASS");
  assert.equal(out.sign_allowed, true);
  assert.equal(out.requires_ack, false);
  assert.equal(out.intentHash, out.receipt.intentHash);
  assert.equal(out.block.number, 123);
  assert.equal(out.block.ageSeconds, 0);
  assert.ok(out.checked.includes("block_freshness"));
  assert.ok(out.checked.includes("payer_balance"));
  assert.ok(out.notChecked.includes("sanctions screening"));
  assert.ok(out.notChecked.includes("counterparty identity / tool metadata"));
  assert.ok(out.notChecked.includes("prompt injection / hidden Unicode in tool output"));
  assert.equal(verifyReceipt(out.receipt, { now: NOW }).valid, true);
});

test("payment: non-canonical asset is CAUTION; an explicit asset allowlist makes it BLOCK", async () => {
  const out = await run(payment({ payment: { asset: SPENDER }, policy: { maxAmountUsd: null } }));
  assert.equal(out.verdict, "CAUTION");
  assert.ok(out.reasons.some((r) => r.code === "non_canonical_asset"));

  const blocked = await run(payment({ payment: { asset: SPENDER }, policy: { allowedAssets: [USDC], maxAmountUsd: null } }));
  assert.equal(blocked.verdict, "BLOCK");
  assert.ok(blocked.reasons.some((r) => r.code === "asset_not_allowed"));
});

test("payment: amount above the policy cap is BLOCK", async () => {
  const out = await run(payment({ payment: { amount: "100000000" } }));
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "amount_over_policy"));
});

test("payment: insufficient payer balance is BLOCK", async () => {
  const client = fakeClient({
    async readContract() {
      return 1n;
    },
  });
  const out = await run(payment(), client);
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "insufficient_balance"));
});

test("payment: expired authorization is BLOCK", async () => {
  const out = await run(payment({ payment: { extra: { validBefore: Math.floor(NOW / 1000) - 1 } } }));
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "authorization_expired"));
});

test("payment: payTo outside the allowlist is BLOCK", async () => {
  const out = await run(payment({ policy: { allowedPayTo: [SPENDER] } }));
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "payee_not_allowed"));
});

test("payment: a mixed-case address with a bad checksum is BLOCK", async () => {
  const out = await run(payment({ payment: { payTo: "0xAAEF086DD4e436c69d6d0F684b4c9F43392df9cb" } }));
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "invalid_payee"));
});

test("payment: chainId that contradicts the network is BLOCK", async () => {
  const out = await run({ ...payment(), chainId: 1 });
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "chain_mismatch"));
});

test("payment: malformed policy is a 400, not a verdict", async () => {
  await assert.rejects(
    () => run(payment({ policy: { maxAmountUsd: "nope" } })),
    (e) => e instanceof PreflightError && e.status === 400 && e.code === "invalid_policy",
  );
});

test("payment: Solana request is validated structurally without an EVM RPC", async () => {
  const out = await run({
    kind: "payment",
    payment: {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "10000",
      payTo: "BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ",
      resource: "https://verify402.onrender.com/verify",
      maxTimeoutSeconds: 60,
    },
    policy: { maxAmountUsd: 0.25 },
  }, null);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.block, null);
  assert.ok(out.notChecked.includes("solana slot binding"));
  assert.ok(out.checked.includes("asset"));
});

test("transaction: a plain ERC-20 transfer that simulates is PASS", async () => {
  const data = encodeFunctionData({ abi: ABI_TRANSFER, functionName: "transfer", args: [RECIPIENT, 1_000_000n] });
  const out = await run(tx(data));
  assert.equal(out.verdict, "PASS");
  assert.equal(out.decoded.action, "transfer");
  assert.equal(out.simulation.status, "ok");
});

test("transaction: an unlimited approval is CAUTION by default and BLOCK under policy", async () => {
  const data = encodeFunctionData({ abi: ABI_APPROVE, functionName: "approve", args: [SPENDER, 2n ** 256n - 1n] });
  const cautioned = await run(tx(data));
  assert.equal(cautioned.verdict, "CAUTION");
  assert.ok(cautioned.reasons.some((r) => r.code === "unlimited_approval"));

  const blocked = await run(tx(data, { policy: { forbidUnlimitedApproval: true } }));
  assert.equal(blocked.verdict, "BLOCK");
  assert.ok(blocked.reasons.some((r) => r.code === "unlimited_approval" && r.severity === "block"));
});

test("transaction: a revert is BLOCK", async () => {
  const data = encodeFunctionData({ abi: ABI_TRANSFER, functionName: "transfer", args: [RECIPIENT, 1n] });
  const client = fakeClient({
    async call() {
      const err = new Error("execution reverted");
      err.name = "CallExecutionError";
      throw err;
    },
  });
  const out = await run(tx(data), client);
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "simulation_revert"));
});

test("transaction: unknown calldata is CAUTION, not a silent pass", async () => {
  const out = await run(tx("0xdeadbeef" + "00".repeat(32)));
  assert.equal(out.verdict, "CAUTION");
  assert.ok(out.reasons.some((r) => r.code === "unrecognized_calldata"));
});

test("transaction: calldata sent to an EOA is BLOCK", async () => {
  const data = encodeFunctionData({ abi: ABI_TRANSFER, functionName: "transfer", args: [RECIPIENT, 1n] });
  const client = fakeClient({ async getCode() { return "0x"; } });
  const out = await run(tx(data), client);
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "target_not_contract"));
});

test("transaction: no from address means no simulation, so CAUTION", async () => {
  const data = encodeFunctionData({ abi: ABI_TRANSFER, functionName: "transfer", args: [RECIPIENT, 1n] });
  const out = await run({ ...tx(data), from: undefined });
  assert.equal(out.verdict, "CAUTION");
  assert.ok(out.reasons.some((r) => r.code === "simulation_skipped_no_from"));
});

test("transaction: an empty, valueless call is a CAUTION no-op", async () => {
  const out = await run({ kind: "transaction", chainId: 8453, from: FROM, to: USDC, data: "0x", value: "0" });
  assert.equal(out.verdict, "CAUTION");
  assert.ok(out.reasons.some((r) => r.code === "noop_transaction"));
});

test("chain unavailable: the gate fails closed with no receipt", async () => {
  const client = fakeClient({
    async getBlock() {
      throw new Error("rpc down");
    },
  });
  await assert.rejects(
    () => run(payment(), client),
    (e) => e instanceof PreflightError && e.status === 503 && e.code === "chain_unavailable",
  );
});

test("block freshness: a block older than 30s is CAUTION", async () => {
  const client = fakeClient({
    async getBlock() {
      return { number: 123n, hash: BLOCK_HASH, timestamp: BigInt(NOW / 1000 - 31) };
    },
  });
  const out = await run(payment(), client);
  assert.equal(out.verdict, "CAUTION");
  assert.equal(out.requires_ack, true);
  assert.equal(out.block.ageSeconds, 31);
  assert.ok(out.checked.includes("block_freshness"));
  assert.ok(out.reasons.some((r) => r.code === "stale_block" && r.severity === "caution"));
});

test("block freshness: a block older than 120s is BLOCK", async () => {
  const client = fakeClient({
    async getBlock() {
      return { number: 123n, hash: BLOCK_HASH, timestamp: BigInt(NOW / 1000 - 121) };
    },
  });
  const out = await run(payment(), client);
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.sign_allowed, false);
  assert.equal(out.block.ageSeconds, 121);
  assert.ok(out.reasons.some((r) => r.code === "stale_block" && r.severity === "block"));
});

test("block freshness: a block without a timestamp fails closed", async () => {
  const client = fakeClient({
    async getBlock() {
      return { number: 123n, hash: BLOCK_HASH };
    },
  });
  await assert.rejects(
    () => run(payment(), client),
    (e) => e instanceof PreflightError && e.status === 503 && e.code === "chain_unavailable",
  );
});

test("transaction: a value cap is enforced and the response stays JSON-safe", async () => {
  const out = await run({
    kind: "transaction",
    chainId: 8453,
    to: USDC,
    data: "0x",
    value: "1000000000000000000",
    policy: { maxValueEth: 0.1 },
  });
  assert.equal(out.verdict, "BLOCK");
  assert.ok(out.reasons.some((r) => r.code === "value_over_policy"));
  assert.equal(typeof out.intent.policy.maxValueWei, "string");
  assert.doesNotThrow(() => JSON.stringify(out));
});

test("transaction: a V3 exactInputSingle decodes and a 1-wei minimum is CAUTION", async () => {
  const ABI_V3 = parseAbi([
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  ]);
  const data = encodeFunctionData({
    abi: ABI_V3,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: USDC,
      tokenOut: RECIPIENT,
      fee: 500,
      recipient: FROM,
      deadline: Math.floor(NOW / 1000) + 600,
      amountIn: 1_000_000n,
      amountOutMinimum: 1n,
      sqrtPriceLimitX96: 0n,
    }],
  });
  const out = await run(tx(data));
  assert.equal(out.decoded.action, "swap");
  assert.equal(out.decoded.protocol, "uniswap-v3");
  assert.equal(out.decoded.amountOutMinimum, "1");
  assert.equal(out.verdict, "CAUTION");
  assert.ok(out.reasons.some((r) => r.code === "minimal_min_out"));
});

test("receipt: tampering invalidates the signature and expiry is enforced", async () => {
  const out = await run(payment());
  const tampered = { ...out.receipt, verdict: "BLOCK" };
  assert.deepEqual(verifyReceipt(tampered, { now: NOW }), { valid: false, reason: "bad_signature" });

  const expired = verifyReceipt(out.receipt, { now: NOW + 10 * 60 * 1000 });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, "expired");
});

test("receipt: a missing or unknown receipt is rejected", () => {
  assert.equal(verifyReceipt(null).valid, false);
  assert.equal(verifyReceipt({ spec: "something-else", signature: "00" }).reason, "unknown_spec");
});

test("H-8: a receipt verifies only against the exact intent and request it covered", async () => {
  const body = payment();
  const out = await run(body);

  const bound = verifyReceipt(out.receipt, { now: NOW, intent: out.intent, request: body });
  assert.equal(bound.valid, true);
  assert.equal(bound.reason, null);
  assert.equal(bound.intentBound, true);
  assert.equal(bound.requestBound, true);
  assert.equal(bound.intentHash, intentHash(out.intent));
  assert.equal(bound.requestHash, out.receipt.requestHash);

  // A changed request field must fail even when the gate's normalized intent
  // is supplied: the signed request hash covers the caller's original body.
  const changedBody = {
    ...body,
    payment: { ...body.payment, amount: "20000" },
  };
  assert.equal(
    verifyReceipt(out.receipt, { now: NOW, intent: out.intent, request: changedBody }).reason,
    "request_mismatch",
  );

  // A changed normalized intent must fail independently.
  const changedIntent = {
    ...out.intent,
    payment: { ...out.intent.payment, amount: "20000" },
  };
  assert.equal(
    verifyReceipt(out.receipt, { now: NOW, intent: changedIntent, request: body }).reason,
    "intent_mismatch",
  );

  // A missing caller field is not a wildcard.
  const missingField = { ...body, payment: { ...body.payment } };
  delete missingField.payment.payTo;
  assert.equal(
    verifyReceipt(out.receipt, { now: NOW, request: missingField }).reason,
    "request_mismatch",
  );

  // The old form stays valid, but it explicitly says it was not bound.
  const legacy = verifyReceipt(out.receipt, { now: NOW });
  assert.equal(legacy.valid, true);
  assert.equal(legacy.intentBound, false);
  assert.equal(legacy.requestBound, false);

  assert.equal(verifyReceipt(out.receipt, { now: NOW, intent: null }).reason, "invalid_intent");
  assert.equal(verifyReceipt(out.receipt, { now: NOW, request: [] }).reason, "invalid_request");
  assert.equal(
    verifyReceipt(out.receipt, { now: NOW, intent: { ...out.intent, kind: "transaction" } }).reason,
    "intent_mismatch",
  );
});

test("H-8: expired receipts fail even when the intent and request match", async () => {
  const body = payment();
  const out = await run(body);
  const expired = verifyReceipt(out.receipt, {
    now: NOW + 10 * 60 * 1000,
    intent: out.intent,
    request: body,
  });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, "expired");
});

// --- H-4: transaction chainId is mandatory and typed ------------------------

test("H-4: transaction without chainId returns 400 missing_chain (no Ethereum default)", async () => {
  const input = tx("0x");
  delete input.chainId;
  await assert.rejects(
    () => run(input),
    (err) => err instanceof PreflightError && err.status === 400 && err.code === "missing_chain",
  );
});

test("H-4: numeric-string chainId is rejected as invalid_chain", async () => {
  await assert.rejects(
    () => run(tx("0x", { chainId: "8453" })),
    (err) => err.status === 400 && err.code === "invalid_chain",
  );
});

test("H-4: unsupported chainId is 400 unsupported_chain, not a guessed simulation", async () => {
  await assert.rejects(
    () => run(tx("0x", { chainId: 999 })),
    (err) => err.status === 400 && err.code === "unsupported_chain",
  );
});

test("H-4: contract code is read on the named chain, not a default chain", async () => {
  const data = encodeFunctionData({
    abi: ABI_TRANSFER,
    functionName: "transfer",
    args: [RECIPIENT, 1n],
  });
  const clientFor = (chainId) => fakeClient({
    async getCode() { return chainId === 8453 ? "0x6000" : "0x"; },
  });

  const onBase = await preflight(tx(data), { clientFactory: clientFor, now: NOW });
  assert.ok(onBase.checked.includes("contract_code"), "Base sees bytecode");
  assert.ok(!onBase.reasons.some((r) => r.code === "target_not_contract"), "Base is not called an EOA");

  const onMainnet = await preflight(tx(data, { chainId: 1 }), { clientFactory: clientFor, now: NOW });
  assert.equal(onMainnet.verdict, "BLOCK");
  assert.ok(onMainnet.reasons.some((r) => r.code === "target_not_contract"), "mainnet sees an EOA at the same address");
});

// --- M-5: payment PASS must disclose that it is structural-only -------------

test("M-5: payment with no from is PASS but structural_only and names the gap", async () => {
  const input = payment({ from: undefined });
  delete input.from;
  const out = await run(input);
  assert.equal(out.verdict, "PASS", "backward-compatible verdict");
  assert.equal(out.structural_only, true);
  assert.ok(out.structural_only_reasons.some((r) => /no payer/i.test(r)));
});

test("M-5: payment with no proof is PASS but structural_only and names the gap", async () => {
  const out = await run(payment());
  assert.equal(out.verdict, "PASS");
  assert.equal(out.structural_only, true);
  assert.ok(out.structural_only_reasons.some((r) => /no payment proof/i.test(r)));
  assert.ok(out.notChecked.includes("payment proof / signed payload"));
});

test("M-5: testnet payment is structural_only even with from and proof", async () => {
  const input = payment({
    payment: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  });
  input.proof = "0xsigned";
  const out = await run(input);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.structural_only, true);
  assert.ok(out.structural_only_reasons.some((r) => /testnet/i.test(r)));
});

test("M-5: mainnet payment with from and proof is not marked structural_only", async () => {
  const input = payment();
  input.proof = "0xsigned";
  const out = await run(input);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.structural_only, false);
});
