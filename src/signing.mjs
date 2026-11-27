// Signed results: every paid answer carries an Ed25519 signature, so anyone
// can prove later that the answer came from this service and was not changed.
//
// The private key comes from VERIFY402_SIGNING_KEY (base64 PKCS#8 DER). With
// no key set, a fresh key is made at start-up: signatures still verify against
// the public key served at /.well-known/verify402-signing-key, but only until
// the process restarts, and the key endpoint says so (source: "ephemeral").
//
// What is signed: SHA-256 of the canonical JSON (sorted keys, BigInt as
// decimal string) of the response with the `signature` field removed. The
// signature is over those 32 hash bytes.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export const SIGNATURE_SPEC = "verify402/signature@1";

function canonical(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : canonical(v))).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== "function" && typeof value[k] !== "symbol").sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/** SHA-256 (hex) of the canonical JSON of `body` without its `signature` field. */
export function signedHash(body) {
  const { signature: _omit, ...rest } = body ?? {};
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

function loadKey(env = process.env) {
  const raw = env.VERIFY402_SIGNING_KEY;
  if (raw) {
    const privateKey = createPrivateKey({ key: Buffer.from(raw.trim(), "base64"), format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("VERIFY402_SIGNING_KEY must be an Ed25519 PKCS#8 key");
    return { privateKey, publicKey: createPublicKey(privateKey), source: "env" };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, source: "ephemeral" };
}

export function createSigner(env = process.env) {
  const { privateKey, publicKey, source } = loadKey(env);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const keyId = `ed25519:${createHash("sha256").update(spki).digest("hex").slice(0, 16)}`;
  const jwk = publicKey.export({ format: "jwk" });
  return {
    keyId,
    source,
    publicKeyInfo() {
      return {
        spec: SIGNATURE_SPEC,
        keyId,
        alg: "Ed25519",
        source,
        publicKeySpkiBase64: spki.toString("base64"),
        jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
        note: source === "env"
          ? "Long-lived signing key. Signatures made with it verify against this public key."
          : "Ephemeral key made at start-up: signatures verify only until this service restarts.",
        verify: "Remove the `signature` field from the response, serialize the rest as canonical JSON (keys sorted, no spaces), SHA-256 it, and verify `signature.value` (base64url Ed25519) over those 32 bytes with this key.",
      };
    },
    /** Returns the body with a `signature` field added. */
    sign(body) {
      const hash = signedHash(body);
      const value = sign(null, Buffer.from(hash, "hex"), privateKey).toString("base64url");
      return {
        ...body,
        signature: {
          spec: SIGNATURE_SPEC,
          alg: "Ed25519",
          keyId,
          keySource: source,
          signedHash: `sha256:${hash}`,
          value,
          publicKeyUrl: "/.well-known/verify402-signing-key",
        },
      };
    },
  };
}

/** Verifies a signed response against a public key (KeyObject, SPKI base64, or JWK). */
export function verifySignedResponse(body, publicKey) {
  if (!body?.signature?.value) return { ok: false, reason: "no_signature" };
  let key = publicKey;
  if (typeof publicKey === "string") key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  else if (publicKey && publicKey.kty) key = createPublicKey({ key: publicKey, format: "jwk" });
  const hash = signedHash(body);
  if (body.signature.signedHash && body.signature.signedHash !== `sha256:${hash}`) return { ok: false, reason: "hash_mismatch" };
  const ok = verify(null, Buffer.from(hash, "hex"), key, Buffer.from(body.signature.value, "base64url"));
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}
