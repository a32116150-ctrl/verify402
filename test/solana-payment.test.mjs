// Solana payment recovery: decode a real-format partially signed x402
// transaction, then prove the checker answers settled / never-settles /
// unknown correctly, and fails closed whenever the chain cannot be certain.
//
//   node --test test/solana-payment.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import {
  base58, decodeSolanaTransaction, solanaPaymentRef, checkSolanaPayment, SOLANA_EXPIRY_GRACE_MS,
} from "../src/solana-payment.mjs";
import {
  recordSettlement, requestHash, reconcileStagedEntry, setRecoveryPaymentChecker, isCheckablePaymentRef,
} from "../src/recovery.mjs";

function compact(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function payerKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { raw, privateKey };
}

// A transfer shaped like x402 exact on Solana: fee payer (facilitator) in slot
// 0, still unsigned; the payer in slot 1, signed.
function buildTx({ versioned = true, durableNonce = false } = {}) {
  const feePayer = randomBytes(32);
  const payer = payerKeys();
  const program = durableNonce ? Buffer.alloc(32) : randomBytes(32);
  const blockhash = randomBytes(32);
  const ixData = durableNonce ? Buffer.from([4, 0, 0, 0]) : Buffer.from([3, 1, 2, 3]);
  const message = Buffer.concat([
    versioned ? Buffer.from([0x80]) : Buffer.alloc(0),
    Buffer.from([2, 0, 1]),
    compact(3), feePayer, payer.raw, program,
    blockhash,
    compact(1), Buffer.from([2]), compact(2), Buffer.from([0, 1]), compact(ixData.length), ixData,
    versioned ? compact(0) : Buffer.alloc(0),
  ]);
  const payerSig = edSign(null, message, payer.privateKey);
  const wire = Buffer.concat([compact(2), Buffer.alloc(64), payerSig, message]);
  return {
    base64: wire.toString("base64"),
    payerSigner: base58(payer.raw),
    payerSignature: base58(payerSig),
    recentBlockhash: base58(blockhash),
  };
}

test("base58 matches known vectors", () => {
  assert.equal(base58(Buffer.from("hello world")), "StV1DL6CwTryKyV");
  assert.equal(base58(Buffer.alloc(32)), "11111111111111111111111111111111");
  assert.equal(base58(Buffer.from([0, 0, 1])), "112");
});

test("decodes legacy and v0 transactions and finds the payer's signature", () => {
  for (const versioned of [true, false]) {
    const tx = buildTx({ versioned });
    const decoded = decodeSolanaTransaction(tx.base64);
    assert.equal(decoded.signers.length, 2);
    assert.equal(decoded.recentBlockhash, tx.recentBlockhash);
    assert.equal(decoded.durableNonce, false);
    const ref = solanaPaymentRef(tx.base64);
    assert.equal(ref.payerSigner, tx.payerSigner, "skips the unsigned fee-payer slot");
    assert.equal(ref.payerSignature, tx.payerSignature);
    assert.equal(ref.recentBlockhash, tx.recentBlockhash);
  }
});

test("detects a durable-nonce transaction (its blockhash never expires)", () => {
  const tx = buildTx({ durableNonce: true });
  assert.equal(solanaPaymentRef(tx.base64).durableNonce, true);
});

test("rejects garbage and unsigned transactions", () => {
  assert.throws(() => decodeSolanaTransaction("AAAA"));
  assert.throws(() => decodeSolanaTransaction(Buffer.from([1, 2, 3]).toString("base64")));
  const unsigned = Buffer.from(buildTx().base64, "base64");
  unsigned.fill(0, 65, 129); // wipe the payer signature
  assert.throws(() => solanaPaymentRef(unsigned.toString("base64")), /no payer signature/);
});

// ---- checker against a fake RPC ---------------------------------------------
function fakeRpc({ landed = null, landedErr = null, blockhashValid = true, history = [], fail = null }) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    if (fail === method) return { ok: false, status: 429, json: async () => ({}) };
    let result;
    if (method === "isBlockhashValid") result = { value: blockhashValid };
    if (method === "getSignaturesForAddress") result = history;
    if (method === "getTransaction") {
      // A real RPC refuses a v1 transaction unless the caller allows v1.
      if (params[1]?.maxSupportedTransactionVersion !== 1) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32015, message: "Transaction version (1) is not supported" } }) };
      }
      const hit = landed && params[0] === "txid-landed";
      result = {
        transaction: { signatures: hit ? ["feePayerSig", landed] : ["other1", "other2"] },
        meta: { err: hit ? landedErr : null },
      };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return { fetchImpl, calls };
}

const NOW = 1_800_000_000_000;
function ref(tx, ageMs) {
  return {
    rail: "svm",
    payerSigner: tx.payerSigner,
    payerSignature: tx.payerSignature,
    recentBlockhash: tx.recentBlockhash,
    durableNonce: false,
    observedAt: NOW - ageMs,
  };
}
const recentHistory = (n = 2) => Array.from({ length: n }, (_, i) => ({
  signature: i === 0 ? "txid-landed" : `txid-${i}`,
  blockTime: Math.floor(NOW / 1000) - 30,
}));

test("found with no error -> settled (true)", async () => {
  const tx = buildTx();
  const rpc = fakeRpc({ landed: tx.payerSignature, history: recentHistory() });
  assert.equal(await checkSolanaPayment(ref(tx, 10_000), { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW }), true);
});

test("found but failed on-chain -> definitively not settled", async () => {
  const tx = buildTx();
  const rpc = fakeRpc({ landed: tx.payerSignature, landedErr: { InstructionError: [0, "Custom"] }, history: recentHistory() });
  assert.equal(await checkSolanaPayment(ref(tx, 10_000), { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW }), "expired");
});

test("not found and still young -> unknown (false), blockhash not even asked", async () => {
  const tx = buildTx();
  const rpc = fakeRpc({ history: recentHistory() });
  assert.equal(await checkSolanaPayment(ref(tx, 10_000), { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW }), false);
  assert.ok(!rpc.calls.includes("isBlockhashValid"));
});

test("not found, old, blockhash dead at finalized -> definitively not settled", async () => {
  const tx = buildTx();
  const rpc = fakeRpc({ blockhashValid: false, history: recentHistory() });
  const r = await checkSolanaPayment(ref(tx, SOLANA_EXPIRY_GRACE_MS + 1), { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW });
  assert.equal(r, "expired");
  assert.equal(rpc.calls[0], "isBlockhashValid", "expiry is read before the search");
});

test("not found, old, but blockhash still valid -> unknown, never expired", async () => {
  const tx = buildTx();
  const rpc = fakeRpc({ blockhashValid: true, history: recentHistory() });
  assert.equal(await checkSolanaPayment(ref(tx, SOLANA_EXPIRY_GRACE_MS + 1), { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW }), false);
});

test("durable nonce is never called expired by time", async () => {
  const tx = buildTx();
  const rpc = fakeRpc({ blockhashValid: false, history: [] });
  const r = await checkSolanaPayment({ ...ref(tx, 60 * 60 * 1000), durableNonce: true }, { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW });
  assert.equal(r, false);
});

test("fails closed: history too long to prove absence", async () => {
  const tx = buildTx();
  // A full page whose oldest entry is still inside the window: the payment
  // could be on the next page, so absence is not proven.
  const full = Array.from({ length: 200 }, (_, i) => ({ signature: `s${i}`, blockTime: Math.floor(NOW / 1000) - 100 }));
  const rpc = fakeRpc({ blockhashValid: false, history: full });
  await assert.rejects(checkSolanaPayment(ref(tx, SOLANA_EXPIRY_GRACE_MS + 1), { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW }));
});

test("a full page that reaches back past the window is a complete search", async () => {
  const tx = buildTx();
  const old = Array.from({ length: 200 }, (_, i) => ({ signature: `s${i}`, blockTime: Math.floor(NOW / 1000) - 5000 }));
  const rpc = fakeRpc({ blockhashValid: false, history: old });
  const r = await checkSolanaPayment(ref(tx, SOLANA_EXPIRY_GRACE_MS + 1), { rpcUrl: "x", fetchImpl: rpc.fetchImpl, now: NOW });
  assert.equal(r, "expired");
  assert.ok(!rpc.calls.includes("getTransaction"), "nothing in the window to fetch");
});

test("fails closed: too many candidates, RPC error, no RPC, incomplete ref", async () => {
  const tx = buildTx();
  const many = Array.from({ length: 60 }, (_, i) => ({ signature: `s${i}`, blockTime: Math.floor(NOW / 1000) - 10 }));
  await assert.rejects(checkSolanaPayment(ref(tx, 10_000), { rpcUrl: "x", fetchImpl: fakeRpc({ history: many }).fetchImpl, now: NOW }), /too many/);
  await assert.rejects(checkSolanaPayment(ref(tx, 10_000), { rpcUrl: "x", fetchImpl: fakeRpc({ fail: "getSignaturesForAddress" }).fetchImpl, now: NOW }), /429/);
  await assert.rejects(checkSolanaPayment(ref(tx, 10_000), { rpcUrl: null, now: NOW }), /no Solana RPC/);
  await assert.rejects(checkSolanaPayment({ rail: "svm" }, { rpcUrl: "x", now: NOW }), /incomplete/);
});

// ---- recovery integration ---------------------------------------------------
function stageSvm(key, paymentRef) {
  const ROUTE = "/route";
  const BODY = { chainId: 8453, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" };
  const { operationId } = recordSettlement(key, { ok: true, chainId: 8453 }, null, {
    settledNow: false,
    requestHash: requestHash(ROUTE, BODY),
    paymentRef,
  });
  return operationId;
}

test("recovery: a txHash-only Solana record is still treated as unreadable (unchanged)", () => {
  assert.equal(isCheckablePaymentRef({ txHash: "ab", rail: "svm" }), false);
  assert.equal(isCheckablePaymentRef({ txHash: "ab" }), false);
  assert.equal(isCheckablePaymentRef({ rail: "svm", payerSigner: "a", payerSignature: "b", recentBlockhash: "c" }), true);
  assert.equal(isCheckablePaymentRef({ nonce: "0x01", payer: "0x", token: "0x" }), true);
});

test("recovery: Solana checker 'settled' promotes; 'expired' expires safely", async () => {
  const tx = buildTx();
  const full = { rail: "svm", network: "solana:test", txHash: "h", ...ref(tx, 0) };

  setRecoveryPaymentChecker(async () => true);
  const a = stageSvm(`svm-settled-${randomBytes(16).toString("hex")}`, full);
  assert.equal(await reconcileStagedEntry(a), "settled");

  setRecoveryPaymentChecker(async () => "expired");
  const b = stageSvm(`svm-expired-${randomBytes(16).toString("hex")}`, { ...full, txHash: "h2" });
  assert.equal(await reconcileStagedEntry(b), "expired_safe");

  setRecoveryPaymentChecker(async () => false);
  const c = stageSvm(`svm-pending-${randomBytes(16).toString("hex")}`, { ...full, txHash: "h3" });
  assert.equal(await reconcileStagedEntry(c), "pending");

  const d = stageSvm(`svm-legacy-${randomBytes(16).toString("hex")}`, { rail: "svm", txHash: "h4" });
  assert.equal(await reconcileStagedEntry(d), "unavailable", "old-shape records keep failing closed");
});
