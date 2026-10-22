// Cross-layer reconciliation of the paid 402 policy.
//
// The same 402 challenge can reach a payer through four different code paths:
// the shared validator, the standalone first-payment payer, the installed MCP
// bridge's x402 client, and the paid smoke preflight. If those layers ever
// disagree about whether a challenge may be signed, the weakest layer decides
// the outcome. This test drives one fixture through all four and requires the
// same accept/refuse decision, and the same refusal reason where the layers
// share a code path.
//
// Offline only: no network, no wallet key material, no payment. The bridge is
// exercised through its real x402 client with a fake scheme standing in for the
// signer, and the smoke is exercised through its real paid preflight with a
// mocked service.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { encodePaymentRequiredHeader } from "@x402/core/http";

const BASE = "https://verify402.onrender.com";
const FAKE_KEY = "0x" + "11".repeat(32);
const PAID_ROUTE = "/route";

// The bridge reads its environment at import time, so the environment is set
// before the module is loaded. dotenv never overrides an existing value.
process.env.EVM_PRIVATE_KEY = FAKE_KEY;
process.env.VERIFY402_URL = BASE;
process.env.VERIFY402_NETWORKS = "eip155:84532";
process.env.MAX_PAYMENT_USD = "0.03";

const { createBridgeClientFromEnv, runWithPaidTool } = await import("../mcp-bridge/index.mjs");
const {
  validatePaymentChallenge,
  DEFAULT_PAY_TO,
  DEMO_NETWORK,
  DEMO_USDC,
  MAINNET_NETWORK,
  MAINNET_USDC,
} = await import("../mcp-bridge/payment-policy.mjs");
const { createPayerGuard, resolvePayerConfig } = await import("../mcp-bridge/first-payment.mjs");
const { runSmoke } = await import("../scripts/smoke.mjs");

const TESTNET_REQUIREMENT = {
  scheme: "exact",
  network: DEMO_NETWORK,
  amount: "20000",
  asset: DEMO_USDC,
  payTo: DEFAULT_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};
const MAINNET_REQUIREMENT = {
  ...TESTNET_REQUIREMENT,
  network: MAINNET_NETWORK,
  asset: MAINNET_USDC,
  extra: { name: "USD Coin", version: "2" },
};

const FIXTURES = {
  valid: { accepts: [TESTNET_REQUIREMENT], accept: true },
  mainnetOnly: { accepts: [MAINNET_REQUIREMENT], accept: false },
  mixed: { accepts: [TESTNET_REQUIREMENT, MAINNET_REQUIREMENT], accept: false },
  wrongPayee: {
    accepts: [{ ...TESTNET_REQUIREMENT, payTo: "0x1111111111111111111111111111111111111111" }],
    accept: false,
  },
  wrongAsset: { accepts: [{ ...TESTNET_REQUIREMENT, asset: MAINNET_USDC }], accept: false },
  stringTimeout: { accepts: [{ ...TESTNET_REQUIREMENT, maxTimeoutSeconds: "300" }], accept: false },
  overCapTimeout: { accepts: [{ ...TESTNET_REQUIREMENT, maxTimeoutSeconds: 301 }], accept: false },
  permit2: {
    accepts: [
      {
        ...TESTNET_REQUIREMENT,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      },
    ],
    accept: false,
  },
  queryResource: {
    accepts: [TESTNET_REQUIREMENT],
    resource: `${BASE}${PAID_ROUTE}?x=1`,
    accept: false,
  },
  trailingSlashResource: {
    accepts: [TESTNET_REQUIREMENT],
    resource: `${BASE}${PAID_ROUTE}/`,
    accept: false,
  },
};

function challengeFor(fixture) {
  return {
    x402Version: 2,
    resource: { url: fixture.resource ?? `${BASE}${PAID_ROUTE}` },
    accepts: fixture.accepts,
  };
}

// --- layer 1: the shared validator -------------------------------------------

function sharedDecision(challenge) {
  return validatePaymentChallenge(challenge, {
    allowedNetworks: [DEMO_NETWORK],
    allowedPayTo: DEFAULT_PAY_TO,
    expectedResource: `${BASE}${PAID_ROUTE}`,
    maxAmountUsd: 0.03,
  });
}

// --- layer 2: the standalone first-payment payer -----------------------------

const payerConfig = resolvePayerConfig({
  EVM_PRIVATE_KEY: FAKE_KEY,
  VERIFY402_URL: BASE,
  MAX_PAYMENT_USD: "0.03",
});
const payerGuard = createPayerGuard(payerConfig);

function payerDecision(challenge) {
  return payerGuard({
    paymentRequired: challenge,
    selectedRequirements: challenge.accepts[0],
  });
}

// --- layer 3: the installed MCP bridge's real x402 client --------------------

function fakeScheme(signerCalls) {
  return {
    scheme: "exact",
    // The signer stand-in only counts invocations; the canonical-asset and
    // domain rules are enforced by the policy layer under test.
    findDefaultAsset: (asset) => ({ asset, decimals: 6, symbol: "USDC" }),
    createPaymentPayload: async (x402Version, requirements) => {
      signerCalls.count += 1;
      return {
        x402Version,
        payload: { authorization: { requirement: requirements }, signature: "0xfake" },
      };
    },
  };
}

async function bridgeDecision(challenge) {
  const signerCalls = { count: 0 };
  const client = createBridgeClientFromEnv();
  client.register(DEMO_NETWORK, fakeScheme(signerCalls));
  let error = null;
  try {
    // Drive the real tool binding: the bridge only signs a challenge whose
    // resource matches the paid route of the tool being invoked.
    await runWithPaidTool("get_best_route", () => client.createPaymentPayload(challenge));
  } catch (caught) {
    error = caught;
  }
  const message = error?.message ?? "";
  const aborted = message.startsWith("Payment creation aborted: ");
  return {
    signed: signerCalls.count,
    error,
    reason: aborted ? message.slice("Payment creation aborted: ".length) : null,
    rejectedEarly: error !== null && !aborted,
  };
}

// --- layer 4: the paid smoke preflight ---------------------------------------

function jsonResponse(status, body, headers = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    map.set(String(key).toLowerCase(), value);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name ? map.get(String(name).toLowerCase()) ?? null : null),
      set: (name, value) => map.set(String(name).toLowerCase(), value),
    },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

function smokeFetch(challenge) {
  const header = encodePaymentRequiredHeader(challenge);
  return async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/health")) return jsonResponse(200, { ok: true, mode: "testnet" });
    if (target.endsWith("/ready")) {
      return jsonResponse(200, { ok: true, ready: true, blockNumber: 1 });
    }
    if (target.includes("/preflight/verify")) return jsonResponse(200, { valid: true });
    if (target.includes("/preflight")) {
      const body = String(init?.body || "");
      if (body.includes('"kind":"transaction"')) return jsonResponse(400, { code: "missing_chain" });
      if (body.includes("1000000000")) {
        return jsonResponse(200, {
          verdict: "BLOCK",
          receipt: { hmac: "x" },
          checked: ["a"],
          notChecked: ["b"],
        });
      }
      return jsonResponse(200, {
        verdict: "CAUTION",
        receipt: { hmac: "x" },
        checked: ["a"],
        notChecked: ["b"],
      });
    }
    if (target.endsWith("/.well-known/agent-card.json")) return jsonResponse(200, BASE);
    if (target.endsWith("/verify")) {
      if (init?.headers?.["x-idempotency-key"] === "test-1") {
        return jsonResponse(400, { code: "weak_idempotency_key" });
      }
      const verifyChallenge = {
        x402Version: 2,
        resource: { url: `${BASE}/verify` },
        accepts: [TESTNET_REQUIREMENT],
      };
      return jsonResponse(
        402,
        { error: "Payment required" },
        { "payment-required": encodePaymentRequiredHeader(verifyChallenge) },
      );
    }
    if (target.endsWith(PAID_ROUTE)) {
      return jsonResponse(402, { error: "Payment required" }, { "payment-required": header });
    }
    return jsonResponse(404, {});
  };
}

function fakeSpawn() {
  const calls = [];
  const spawnImpl = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  return { spawnImpl, calls };
}

async function smokeDecision(challenge) {
  const { spawnImpl, calls } = fakeSpawn();
  const result = await runSmoke({
    baseUrl: BASE,
    env: {
      SMOKE_PAID: "1",
      SMOKE_BASE_URL: BASE,
      AGENT_URL: BASE,
      EVM_PRIVATE_KEY: FAKE_KEY,
      MAX_PAYMENT_USD: "0.03",
    },
    allowPaid: true,
    fetchImpl: smokeFetch(challenge),
    spawnImpl,
    log: () => {},
  });
  const failure = result.failures.find((entry) => entry.name === "paid mode preflight");
  return {
    accepted: result.ok && calls.length === 1,
    spawned: calls.length,
    reason: failure?.error ?? null,
  };
}

// --- the reconciliation ------------------------------------------------------

async function reconcile(fixture) {
  const challenge = challengeFor(fixture);

  const shared = sharedDecision(challenge);
  const payer = payerDecision(challenge);
  const bridge = await bridgeDecision(challenge);
  const smoke = await smokeDecision(challenge);

  // 1. The shared validator decides.
  assert.equal(
    shared.ok,
    fixture.accept,
    `shared validator: ${shared.ok ? "accepted" : `refused (${shared.reason})`}`,
  );

  // 2. The standalone payer agrees.
  assert.equal(
    payer?.abort === true,
    !fixture.accept,
    `first-payment payer: ${payer?.abort ? "refused" : "accepted"}`,
  );

  // 3. The installed bridge agrees, and never signs a refused challenge.
  assert.equal(
    bridge.signed,
    fixture.accept ? 1 : 0,
    `installed bridge signed ${bridge.signed} time(s)`,
  );
  if (!fixture.accept) {
    assert.ok(bridge.error, "the installed bridge must refuse the challenge");
  }

  // 4. The paid smoke agrees and never spawns a payer for a refused challenge.
  assert.equal(
    smoke.spawned,
    fixture.accept ? 1 : 0,
    `paid smoke spawned the payer ${smoke.spawned} time(s)`,
  );
  assert.equal(smoke.accepted, fixture.accept);

  // The refusal reason is identical wherever the layers share a code path.
  if (!fixture.accept) {
    assert.ok(shared.reason, "a refusal must carry a reason");
    assert.equal(
      payer?.reason,
      shared.reason,
      "the first-payment payer must refuse with the shared reason",
    );
    assert.equal(
      smoke.reason,
      shared.reason,
      "the paid smoke must refuse with the shared reason",
    );
    if (bridge.reason !== null) {
      assert.equal(
        bridge.reason,
        shared.reason,
        "the installed bridge must refuse with the shared reason",
      );
    }
  }
}

test("every layer makes the same decision for a valid Base Sepolia /route challenge", async () => {
  await reconcile(FIXTURES.valid);
});

test("every layer makes the same decision for a Base mainnet-only challenge", async () => {
  await reconcile(FIXTURES.mainnetOnly);
});

test("every layer makes the same decision for a mixed Base Sepolia + Base mainnet challenge", async () => {
  await reconcile(FIXTURES.mixed);
});

test("every layer makes the same decision for a challenge with an unexpected payee", async () => {
  await reconcile(FIXTURES.wrongPayee);
});

test("every layer makes the same decision for a challenge with a non-canonical asset", async () => {
  await reconcile(FIXTURES.wrongAsset);
});

test("every layer makes the same decision for a challenge with a numeric-string maxTimeoutSeconds", async () => {
  await reconcile(FIXTURES.stringTimeout);
});

test("every layer makes the same decision for a challenge with a maxTimeoutSeconds above the cap", async () => {
  await reconcile(FIXTURES.overCapTimeout);
});

test("every layer makes the same decision for a challenge with a permit2 transfer method", async () => {
  await reconcile(FIXTURES.permit2);
});

test("every layer makes the same decision for a challenge whose resource carries a query", async () => {
  await reconcile(FIXTURES.queryResource);
});

test("every layer makes the same decision for a challenge whose resource has a trailing slash", async () => {
  await reconcile(FIXTURES.trailingSlashResource);
});

test("the installed bridge ties the trailing-slash resource to the tool's own route", async () => {
  // The bridge pins the exact resource of the tool being invoked, so a
  // trailing slash is refused for the same reason as the shared validator.
  const challenge = challengeFor({
    accepts: [TESTNET_REQUIREMENT],
    resource: `${BASE}${PAID_ROUTE}/`,
  });
  const shared = sharedDecision(challenge);
  const bridge = await bridgeDecision(challenge);
  assert.equal(shared.ok, false);
  assert.equal(bridge.signed, 0);
  assert.ok(bridge.error);
  assert.equal(bridge.reason, shared.reason);
});
