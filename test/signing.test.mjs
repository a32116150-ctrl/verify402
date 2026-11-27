// Signed results: every paid answer carries an Ed25519 signature that verifies
// against the key at /.well-known/verify402-signing-key.

import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";

process.env.X402_MODE = "testnet";
process.env.BYPASS_PAYMENT = "1";

const { createSigner, verifySignedResponse, signedHash } = await import("../src/signing.mjs");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

console.log("\nsigned results");

await check("a signed body verifies, and any change breaks it", () => {
  const s = createSigner({});
  const body = s.sign({ ok: true, verdict: "fair", amount: "123", nested: { b: 2, a: [1, "x", null] } });
  const key = s.publicKeyInfo();
  assert.deepEqual(verifySignedResponse(body, key.publicKeySpkiBase64), { ok: true });
  assert.deepEqual(verifySignedResponse(body, key.jwk), { ok: true });
  const changed = { ...body, verdict: "too_good_to_be_true" };
  assert.equal(verifySignedResponse(changed, key.publicKeySpkiBase64).ok, false);
  const forged = { ...changed, signature: { ...changed.signature, signedHash: `sha256:${signedHash(changed)}` } };
  assert.equal(verifySignedResponse(forged, key.publicKeySpkiBase64).reason, "bad_signature");
});

await check("key order does not matter (canonical JSON)", () => {
  const s = createSigner({});
  const a = s.sign({ x: 1, y: { q: 1, p: 2 } });
  const reordered = { signature: a.signature, y: { p: 2, q: 1 }, x: 1 };
  assert.equal(verifySignedResponse(reordered, s.publicKeyInfo().publicKeySpkiBase64).ok, true);
});

await check("a key from VERIFY402_SIGNING_KEY is used and reported as env; a wrong key type is refused", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const s1 = createSigner({ VERIFY402_SIGNING_KEY: der });
  const s2 = createSigner({ VERIFY402_SIGNING_KEY: der });
  assert.equal(s1.source, "env");
  assert.equal(s1.keyId, s2.keyId, "same key, same id across restarts");
  const other = createSigner({});
  assert.equal(other.source, "ephemeral");
  assert.notEqual(other.keyId, s1.keyId);
  const body = s1.sign({ ok: true });
  assert.equal(verifySignedResponse(body, other.publicKeyInfo().publicKeySpkiBase64).ok, false, "another key must not verify");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  assert.throws(() => createSigner({ VERIFY402_SIGNING_KEY: ec }), /Ed25519/);
});

await check("the server publishes the key and signs a replayed paid answer with it", async () => {
  const { recordSettlement, requestHash } = await import("../src/recovery.mjs");
  const { app } = await import("../src/server.mjs");
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const keyRes = await fetch(`${base}/.well-known/verify402-signing-key`);
    assert.equal(keyRes.status, 200);
    const key = await keyRes.json();
    assert.equal(key.alg, "Ed25519");
    assert.match(key.keyId, /^ed25519:[0-9a-f]{16}$/);

    const body = { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" };
    const idem = randomUUID();
    recordSettlement(idem, { ok: true, verdict: "measured", checked: ["x"], notChecked: ["y"] }, null, {
      settledNow: true, requestHash: requestHash("/route", body),
    });
    const r = await fetch(`${base}/route`, {
      method: "POST", headers: { "content-type": "application/json", "x-idempotency-key": idem }, body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.recovery?.replayed, true, "this is the replay path");
    assert.equal(out.signature?.keyId, key.keyId);
    assert.deepEqual(verifySignedResponse(out, key.publicKeySpkiBase64), { ok: true });
  } finally {
    server.close();
  }
});

console.log(`\nsigning: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
