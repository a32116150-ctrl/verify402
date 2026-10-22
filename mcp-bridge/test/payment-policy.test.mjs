import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaymentPolicy,
  createPaymentPolicyFromEnv,
  validatePaymentChallenge,
  DEFAULT_NETWORKS,
  DEFAULT_PAY_TO,
  DEMO_NETWORK,
  MAINNET_NETWORK,
} from "../payment-policy.mjs";

// The live verify402 /verify 402, abbreviated to the fields the policy sees.
const TESTNET = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "50000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: DEFAULT_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};
const MAINNET = {
  ...TESTNET,
  network: MAINNET_NETWORK,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const SOLANA = {
  scheme: "exact",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  amount: "50000",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  payTo: "BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ",
  maxTimeoutSeconds: 300,
  extra: { feePayer: "GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb" },
};
const policy = createPaymentPolicy({
  resourcePrefix: "https://verify402.onrender.com",
});

test("selects the Base Sepolia requirement from the live EVM + Solana offer", () => {
  const selected = policy.filter(2, [SOLANA, TESTNET]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].network, DEMO_NETWORK);
  assert.equal(selected[0].payTo, DEFAULT_PAY_TO);
});

test("the real bridge default is Base Sepolia and refuses a mainnet-only 402", () => {
  assert.deepEqual(DEFAULT_NETWORKS, [DEMO_NETWORK]);

  const demo = createPaymentPolicyFromEnv({
    resourcePrefix: "https://verify402.onrender.com",
    env: {},
  });
  assert.deepEqual(demo.allowedNetworks, [DEMO_NETWORK]);
  assert.deepEqual(
    demo.filter(2, [MAINNET, TESTNET]).map((r) => r.network),
    [DEMO_NETWORK],
  );
  assert.throws(
    () => demo.filter(2, [MAINNET]),
    /no payment on an allowed network\/payee/,
  );
});

test("an explicit mainnet setting preserves the deliberate mainnet path", () => {
  const mainnet = createPaymentPolicyFromEnv({
    resourcePrefix: "https://verify402.onrender.com",
    env: { VERIFY402_NETWORKS: MAINNET_NETWORK },
  });
  assert.deepEqual(mainnet.allowedNetworks, [MAINNET_NETWORK]);
  assert.equal(mainnet.filter(2, [MAINNET]).length, 1);
  assert.throws(
    () => mainnet.filter(2, [TESTNET]),
    /no payment on an allowed network\/payee/,
  );
});

test("fails closed when only an unlisted network is offered", () => {
  assert.throws(
    () => policy.filter(2, [SOLANA]),
    /no payment on an allowed network\/payee/,
  );
});

test("fails closed on a different payee", () => {
  assert.throws(
    () => policy.filter(2, [{ ...TESTNET, payTo: "0x1111111111111111111111111111111111111111" }]),
    /no payment on an allowed network\/payee/,
  );
});

test("accepts the live /verify resource", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com/verify" } },
    selectedRequirements: TESTNET,
  });
  assert.equal(result, undefined);
});

test("rejects a resource on another origin", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com.evil.example/verify" } },
    selectedRequirements: TESTNET,
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /origin|outside/);
});

test("rejects a free route masquerading as a paid resource", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com/preflight" } },
    selectedRequirements: TESTNET,
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /not a paid/);
});

test("rejects a missing resource", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: {},
    selectedRequirements: TESTNET,
  });
  assert.equal(result.abort, true);
});

test("rejects a requirement that changed after selection", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com/verify" } },
    selectedRequirements: { ...TESTNET, network: "eip155:1" },
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /changed/);
});

test("allows a local http prefix for tests", () => {
  const local = createPaymentPolicy({ resourcePrefix: "http://localhost:4021" });
  const result = local.checkBeforeSign({
    paymentRequired: { resource: { url: "http://localhost:4021/verify" } },
    selectedRequirements: TESTNET,
  });
  assert.equal(result, undefined);
});

test("rejects a non-EVM network configuration", () => {
  assert.throws(
    () => createPaymentPolicy({ networks: ["solana:mainnet"], resourcePrefix: "https://verify402.onrender.com" }),
    /eip155/,
  );
});

test("rejects a bad payee configuration", () => {
  assert.throws(
    () => createPaymentPolicy({ payTo: "0x1234", resourcePrefix: "https://verify402.onrender.com" }),
    /20-byte/,
  );
});

test("rejects a bad resource prefix", () => {
  assert.throws(
    () => createPaymentPolicy({ resourcePrefix: "not a url" }),
    /not a URL/,
  );
});

test("an explicitly empty environment value fails closed instead of falling back to a default", () => {
  const base = { resourcePrefix: "https://verify402.onrender.com" };

  assert.throws(
    () => createPaymentPolicyFromEnv({ ...base, env: { VERIFY402_NETWORKS: "" } }),
    /at least one/,
  );
  assert.throws(
    () => createPaymentPolicyFromEnv({ ...base, env: { VERIFY402_PAY_TO: "" } }),
    /20-byte/,
  );
  assert.throws(
    () => createPaymentPolicyFromEnv({ ...base, env: { VERIFY402_RESOURCE_PREFIX: "" } }),
    /not a URL/,
  );
  assert.throws(
    () => createPaymentPolicyFromEnv({ ...base, env: { VERIFY402_NETWORKS: "eip155:1" } }),
    /not a supported payment network/,
  );
  assert.throws(
    () => createPaymentPolicyFromEnv({ ...base, env: { VERIFY402_NETWORKS: "solana:mainnet" } }),
    /eip155/,
  );
});

test("an unset environment value still uses the documented Base Sepolia default", () => {
  const policy = createPaymentPolicyFromEnv({
    resourcePrefix: "https://verify402.onrender.com",
    env: {},
  });
  assert.deepEqual(policy.allowedNetworks, [DEMO_NETWORK]);
  assert.equal(policy.allowedPayTo, DEFAULT_PAY_TO.toLowerCase());
});

// --- maxTimeoutSeconds -------------------------------------------------------

function challengeWith(requirement, resource = "https://verify402.onrender.com/route") {
  return { x402Version: 2, resource: { url: resource }, accepts: [requirement] };
}

function validateTimeoutFixture(requirement) {
  return validatePaymentChallenge(challengeWith(requirement), {
    allowedNetworks: [DEMO_NETWORK],
    allowedPayTo: DEFAULT_PAY_TO,
    maxAmountUsd: 1,
  });
}

test("accepts exactly the 300 second maxTimeoutSeconds boundary", () => {
  const result = validateTimeoutFixture({ ...TESTNET, maxTimeoutSeconds: 300 });
  assert.equal(result.ok, true);
});

test("rejects a missing maxTimeoutSeconds", () => {
  const result = validateTimeoutFixture({ ...TESTNET, maxTimeoutSeconds: undefined });
  assert.equal(result.ok, false);
  assert.match(result.reason, /maxTimeoutSeconds/);
});

test("rejects a numeric-string maxTimeoutSeconds", () => {
  const result = validateTimeoutFixture({ ...TESTNET, maxTimeoutSeconds: "300" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /maxTimeoutSeconds/);
});

test("rejects a fractional maxTimeoutSeconds", () => {
  const result = validateTimeoutFixture({ ...TESTNET, maxTimeoutSeconds: 299.5 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /maxTimeoutSeconds/);
});

test("rejects a zero, negative, or over-cap maxTimeoutSeconds", () => {
  for (const value of [0, -30, 301, 86_400]) {
    const result = validateTimeoutFixture({ ...TESTNET, maxTimeoutSeconds: value });
    assert.equal(result.ok, false, `expected ${value} to be refused`);
    assert.match(result.reason, /maxTimeoutSeconds/);
  }
});

test("rejects the whole challenge when a non-selected entry has a bad timeout", () => {
  const result = validatePaymentChallenge(
    {
      x402Version: 2,
      resource: { url: "https://verify402.onrender.com/route" },
      accepts: [TESTNET, { ...TESTNET, maxTimeoutSeconds: 86_400 }],
    },
    { allowedNetworks: [DEMO_NETWORK], allowedPayTo: DEFAULT_PAY_TO, maxAmountUsd: 1 },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /maxTimeoutSeconds/);
});

test("rejects a challenge that is not x402 v2", () => {
  const result = validatePaymentChallenge(
    { ...challengeWith(TESTNET), x402Version: 1 },
    { allowedNetworks: [DEMO_NETWORK], allowedPayTo: DEFAULT_PAY_TO, maxAmountUsd: 1 },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /x402 v2/);
});

test("rejects a resource that carries a query or fragment", () => {
  for (const url of [
    "https://verify402.onrender.com/route?x=1",
    "https://verify402.onrender.com/route#frag",
  ]) {
    const result = validatePaymentChallenge(challengeWith(TESTNET, url), {
      allowedNetworks: [DEMO_NETWORK],
      allowedPayTo: DEFAULT_PAY_TO,
      maxAmountUsd: 1,
    });
    assert.equal(result.ok, false, `expected ${url} to be refused`);
    assert.match(result.reason, /query or fragment/);
  }
});

test("treats a trailing-slash resource as a different resource", () => {
  const result = validatePaymentChallenge(
    challengeWith(TESTNET, "https://verify402.onrender.com/route/"),
    {
      allowedNetworks: [DEMO_NETWORK],
      allowedPayTo: DEFAULT_PAY_TO,
      expectedResource: "https://verify402.onrender.com/route",
      maxAmountUsd: 1,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /not the expected/);
});

test("rejects a permit2 transfer method and any unvalidated signing extension", () => {
  const permit2 = validateTimeoutFixture({
    ...TESTNET,
    extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
  });
  assert.equal(permit2.ok, false);
  assert.match(permit2.reason, /transfer method/);

  const unknown = validateTimeoutFixture({
    ...TESTNET,
    extra: { name: "USDC", version: "2", someSigningHook: "value" },
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /signing extension/);
});

test("rejects an EIP-712 domain that is not canonical for the network", () => {
  const result = validateTimeoutFixture({
    ...TESTNET,
    extra: { name: "USDC", version: "1" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /canonical USDC domain/);
});
