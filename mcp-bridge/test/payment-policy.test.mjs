import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentPolicy, DEFAULT_PAY_TO } from "../payment-policy.mjs";

// The live verify402 /verify 402, abbreviated to the fields the policy sees.
const BASE = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "50000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: DEFAULT_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};
const SOLANA = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "50000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ",
  maxTimeoutSeconds: 300,
  extra: { feePayer: "GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb" },
};
const policy = createPaymentPolicy({
  resourcePrefix: "https://verify402.onrender.com",
});

test("selects the Base requirement from the live EVM + Solana offer", () => {
  const selected = policy.filter(2, [SOLANA, BASE]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].network, "eip155:8453");
  assert.equal(selected[0].payTo, DEFAULT_PAY_TO);
});

test("fails closed when only an unlisted network is offered", () => {
  assert.throws(
    () => policy.filter(2, [SOLANA]),
    /no payment on an allowed network\/payee/,
  );
});

test("fails closed on a different payee", () => {
  assert.throws(
    () => policy.filter(2, [{ ...BASE, payTo: "0x1111111111111111111111111111111111111111" }]),
    /no payment on an allowed network\/payee/,
  );
});

test("accepts the live /verify resource", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com/verify" } },
    selectedRequirements: BASE,
  });
  assert.equal(result, undefined);
});

test("rejects a resource on another origin", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com.evil.example/verify" } },
    selectedRequirements: BASE,
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /origin|outside/);
});

test("rejects a free route masquerading as a paid resource", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com/preflight" } },
    selectedRequirements: BASE,
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /not a paid/);
});

test("rejects a missing resource", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: {},
    selectedRequirements: BASE,
  });
  assert.equal(result.abort, true);
});

test("rejects a requirement that changed after selection", () => {
  const result = policy.checkBeforeSign({
    paymentRequired: { resource: { url: "https://verify402.onrender.com/verify" } },
    selectedRequirements: { ...BASE, network: "eip155:1" },
  });
  assert.equal(result.abort, true);
  assert.match(result.reason, /changed/);
});

test("allows a local http prefix for tests", () => {
  const local = createPaymentPolicy({ resourcePrefix: "http://localhost:4021" });
  const result = local.checkBeforeSign({
    paymentRequired: { resource: { url: "http://localhost:4021/verify" } },
    selectedRequirements: BASE,
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
