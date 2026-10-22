import test from "node:test";
import assert from "node:assert/strict";

import {
  createPayerGuard,
  resolvePayerConfig,
  validateSettlementReceipt,
  verifySettlementEvidence,
  FIRST_PAYMENT_ROUTE,
} from "../first-payment.mjs";
import {
  createPaymentPolicy,
  DEFAULT_PAY_TO,
  DEMO_NETWORK,
  DEMO_USDC,
  MAINNET_NETWORK,
  MAINNET_USDC,
} from "../payment-policy.mjs";

const RESOURCE = "https://verify402.onrender.com/route";
const TESTNET = {
  scheme: "exact",
  network: DEMO_NETWORK,
  amount: "30000",
  asset: DEMO_USDC,
  payTo: DEFAULT_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};
const MAINNET = {
  ...TESTNET,
  network: MAINNET_NETWORK,
  asset: MAINNET_USDC,
  extra: { name: "USD Coin", version: "2" },
};

function challenge(accepts, resource = RESOURCE) {
  return { x402Version: 2, resource: { url: resource }, accepts };
}

function guardFor({
  networks = [DEMO_NETWORK],
  payTo = DEFAULT_PAY_TO,
  maxAmountUsd = 0.03,
} = {}) {
  const policy = createPaymentPolicy({
    networks,
    payTo,
    resourcePrefix: "https://verify402.onrender.com",
    paidRoutes: [FIRST_PAYMENT_ROUTE],
  });
  return createPayerGuard({ policy, expectedResource: RESOURCE, maxAmountUsd });
}

function context(requirement, selected = requirement, resource = RESOURCE) {
  return {
    paymentRequired: challenge([requirement], resource),
    selectedRequirements: selected,
  };
}

test("payer accepts a fully valid Base Sepolia /route challenge", () => {
  const guard = guardFor();
  assert.equal(guard(context(TESTNET)), undefined);
});

test("payer independently rejects a mainnet-only challenge", () => {
  const guard = guardFor();
  const result = guard(context(MAINNET));
  assert.equal(result.abort, true);
  assert.match(result.reason, /not an allowed EVM network/);
});

test("payer rejects a mixed challenge that still offers Base mainnet", () => {
  const guard = guardFor();
  const result = guard({
    paymentRequired: challenge([TESTNET, MAINNET]),
    selectedRequirements: TESTNET,
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /not an allowed EVM network/);
});

test("payer rejects a mainnet requirement selected after a testnet challenge", () => {
  const guard = guardFor();
  const result = guard({
    paymentRequired: challenge([TESTNET]),
    selectedRequirements: MAINNET,
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /not an allowed EVM network/);
});

test("payer rejects an unexpected payee", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, payTo: "0x1111111111111111111111111111111111111111" }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /payee/);
});

test("payer rejects an unexpected resource", () => {
  const guard = guardFor();
  const result = guard(context(TESTNET, TESTNET, "https://verify402.onrender.com/verify"));
  assert.equal(result.abort, true);
  assert.match(result.reason, /not the expected/);
});

test("payer rejects an amount above the configured cap", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, amount: "60000" }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /USD cap/);
});

test("payer rejects a missing network field", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, network: undefined }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /no valid network/);
});

test("payer rejects a non-canonical asset on the testnet network", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, asset: MAINNET_USDC }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /canonical USDC/);
});

test("missing payee configuration disables payment instead of guessing an address", () => {
  const guard = createPayerGuard({
    policy: { allowedNetworks: [DEMO_NETWORK], allowedPayTo: "" },
    expectedResource: RESOURCE,
    maxAmountUsd: 0.03,
  });
  const result = guard(context(TESTNET));
  assert.equal(result.abort, true);
  assert.match(result.reason, /no valid expected payee/);
});

test("an explicitly configured mainnet policy preserves the deliberate mainnet path", () => {
  const guard = guardFor({ networks: [MAINNET_NETWORK] });
  assert.equal(guard(context(MAINNET)), undefined);
  const testnet = guard(context(TESTNET));
  assert.equal(testnet.abort, true);
  assert.match(testnet.reason, /not an allowed EVM network/);
});

test("payer config defaults to Base Sepolia and the verify402 payee", () => {
  const config = resolvePayerConfig({ EVM_PRIVATE_KEY: "0x" + "11".repeat(32) });
  assert.deepEqual(config.policy.allowedNetworks, [DEMO_NETWORK]);
  assert.equal(config.policy.allowedPayTo, DEFAULT_PAY_TO.toLowerCase());
  assert.equal(config.expectedResource, `https://verify402.onrender.com${FIRST_PAYMENT_ROUTE}`);
  assert.equal(config.maxAmountUsd, 0.03);
});

test("payer config refuses explicitly empty network or payee values", () => {
  const key = "0x" + "11".repeat(32);
  assert.throws(
    () => resolvePayerConfig({ EVM_PRIVATE_KEY: key, VERIFY402_NETWORKS: "" }),
    /at least one/,
  );
  assert.throws(
    () => resolvePayerConfig({ EVM_PRIVATE_KEY: key, VERIFY402_PAY_TO: "" }),
    /20-byte/,
  );
});

// --- maxTimeoutSeconds -------------------------------------------------------
// The SDK signs `validBefore = now + maxTimeoutSeconds`, so an unbounded or
// non-integer timeout is a signing-safety problem, not a formatting problem.

test("payer rejects a missing maxTimeoutSeconds", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, maxTimeoutSeconds: undefined }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /maxTimeoutSeconds/);
});

test("payer rejects a numeric-string maxTimeoutSeconds", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, maxTimeoutSeconds: "300" }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /maxTimeoutSeconds/);
});

test("payer rejects a fractional maxTimeoutSeconds", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, maxTimeoutSeconds: 300.5 }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /maxTimeoutSeconds/);
});

test("payer rejects a zero or negative maxTimeoutSeconds", () => {
  const guard = guardFor();
  for (const value of [0, -1]) {
    const result = guard(context({ ...TESTNET, maxTimeoutSeconds: value }));
    assert.equal(result.abort, true);
    assert.match(result.reason, /maxTimeoutSeconds/);
  }
});

test("payer rejects a maxTimeoutSeconds above the 300 second cap", () => {
  const guard = guardFor();
  const result = guard(context({ ...TESTNET, maxTimeoutSeconds: 301 }));
  assert.equal(result.abort, true);
  assert.match(result.reason, /300s maximum/);
});

test("payer accepts exactly the 300 second boundary", () => {
  const guard = guardFor();
  assert.equal(guard(context({ ...TESTNET, maxTimeoutSeconds: 300 })), undefined);
});

// --- settlement evidence -----------------------------------------------------

const TX_HASH = "0x" + "ab".repeat(32);
const PAYER = "0x1111111111111111111111111111111111111111";

function receipt(overrides = {}) {
  return {
    success: true,
    transaction: TX_HASH,
    network: DEMO_NETWORK,
    payer: PAYER,
    amount: "20000",
    ...overrides,
  };
}

test("a settlement receipt without a transaction hash is not proof of settlement", () => {
  const verdict = validateSettlementReceipt(receipt({ transaction: undefined }), {
    expectedNetwork: DEMO_NETWORK,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /transaction hash/);
});

test("a malformed settlement transaction hash is not proof of settlement", () => {
  const verdict = validateSettlementReceipt(receipt({ transaction: "0xnothex" }), {
    expectedNetwork: DEMO_NETWORK,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /transaction hash/);
});

test("an unsuccessful settlement is not proof of settlement", () => {
  const verdict = validateSettlementReceipt(
    receipt({ success: false, errorReason: "insufficient_funds" }),
    { expectedNetwork: DEMO_NETWORK },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not succeed/);
});

test("a settlement on a different network than the signed requirement is rejected", () => {
  const verdict = validateSettlementReceipt(receipt({ network: MAINNET_NETWORK }), {
    expectedNetwork: DEMO_NETWORK,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the expected/);
});

test("a settlement credited to another payer is rejected", () => {
  const verdict = validateSettlementReceipt(receipt(), {
    expectedNetwork: DEMO_NETWORK,
    expectedPayer: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the paying wallet/);
});

test("a settlement of a different amount is rejected", () => {
  const verdict = validateSettlementReceipt(receipt(), {
    expectedNetwork: DEMO_NETWORK,
    expectedAmountAtomic: "30000",
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the expected/);
});

test("a valid settlement receipt proves the network and transaction", () => {
  const verdict = validateSettlementReceipt(receipt(), {
    expectedNetwork: DEMO_NETWORK,
    expectedPayer: PAYER,
    expectedAmountAtomic: "20000",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.proves.network, DEMO_NETWORK);
  assert.equal(verdict.proves.transaction, TX_HASH);
  assert.equal(verdict.proves.payer, "checked");
  assert.equal(verdict.proves.amount, "checked");
});

test("a receipt without payer or amount is accepted but reports them as unproven", () => {
  const verdict = validateSettlementReceipt(receipt({ payer: undefined, amount: undefined }), {
    expectedNetwork: DEMO_NETWORK,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.proves.payer, "not-reported");
  assert.equal(verdict.proves.amount, "not-reported");
});

// --- the paid script's settlement gate ---------------------------------------

const decodeJsonHeader = (raw) => JSON.parse(Buffer.from(raw, "base64").toString("utf8"));

test("the paid script refuses to report success without a PAYMENT-RESPONSE header", () => {
  const evidence = verifySettlementEvidence({
    rawHeader: undefined,
    decodeReceipt: decodeJsonHeader,
    expected: { expectedNetwork: DEMO_NETWORK },
  });
  assert.equal(evidence.ok, false);
  assert.match(evidence.reason, /no PAYMENT-RESPONSE header/);
});

test("the paid script refuses to report success when the receipt cannot be decoded", () => {
  const evidence = verifySettlementEvidence({
    rawHeader: "not-base64!!",
    decodeReceipt: () => {
      throw new Error("invalid base64");
    },
    expected: { expectedNetwork: DEMO_NETWORK },
  });
  assert.equal(evidence.ok, false);
  assert.match(evidence.reason, /did not decode/);
});

test("the paid script refuses to report success for an unsuccessful settlement", () => {
  const evidence = verifySettlementEvidence({
    rawHeader: "e30=",
    decodeReceipt: () => receipt({ success: false, errorReason: "network_mismatch" }),
    expected: { expectedNetwork: DEMO_NETWORK },
  });
  assert.equal(evidence.ok, false);
  assert.match(evidence.reason, /did not succeed/);
});

test("the paid script reports success only with a complete valid receipt", () => {
  const evidence = verifySettlementEvidence({
    rawHeader: "e30=",
    decodeReceipt: () => receipt(),
    expected: {
      expectedNetwork: DEMO_NETWORK,
      expectedPayer: PAYER,
      expectedAmountAtomic: "20000",
    },
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.receipt.transaction, TX_HASH);
  assert.equal(evidence.verdict.proves.network, DEMO_NETWORK);
});
