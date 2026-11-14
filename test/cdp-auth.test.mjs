// Tests for the local CDP facilitator auth (no SDK).
//
// CDP accepts a short-lived JWT bound to the exact method+host+path. These
// tests sign with real keys in both shapes CDP issues and verify the signature
// with node:crypto, so a wrong claim set or a bad DER->JOSE conversion fails
// here rather than as an opaque 401 from Coinbase.

import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { cdpJwt, cdpAuthHeaders, isCdpFacilitatorUrl, CDP_FACILITATOR_URL } from "../src/cdp-auth.mjs";

function ed25519Secret() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });      // { x, d, crv, kty }
  const pub = publicKey.export({ format: "jwk" });
  const secret = Buffer.concat([
    Buffer.from(jwk.d, "base64url"),
    Buffer.from(pub.x, "base64url"),
  ]);
  return { secret: secret.toString("base64"), publicKey };
}

function ecSecret() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { secret: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey };
}

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("cdp: Ed25519 key produces a JWT CDP will accept, with a verified signature", () => {
  const { secret, publicKey } = ed25519Secret();
  const now = 1_800_000_000;
  const jwt = cdpJwt({ keyId: "key-abc", keySecret: secret, method: "POST", path: "/platform/v2/x402/verify", now });
  const [headerB64, claimsB64, sigB64] = jwt.split(".");

  const header = decode(headerB64);
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, "key-abc");
  assert.equal(header.typ, "JWT");
  assert.match(header.nonce, /^[0-9a-f]{32}$/, "nonce must be 16 random bytes as hex");

  const claims = decode(claimsB64);
  assert.equal(claims.sub, "key-abc");
  assert.equal(claims.iss, "cdp");
  assert.equal(claims.iat, now);
  assert.equal(claims.nbf, now);
  assert.equal(claims.exp, now + 120, "CDP tokens are short-lived");
  assert.deepEqual(claims.uris, ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);

  const ok = cryptoVerify(
    null,
    Buffer.from(`${headerB64}.${claimsB64}`),
    publicKey,
    Buffer.from(sigB64, "base64url"),
  );
  assert.equal(ok, true, "signature must verify against the matching public key");
});

test("cdp: a PEM EC key produces an ES256 JWT with a JOSE-format signature", () => {
  const { secret, publicKey } = ecSecret();
  const now = 1_800_000_000;
  const jwt = cdpJwt({ keyId: "key-pem", keySecret: secret, method: "GET", path: "/platform/v2/x402/supported", now });
  const [headerB64, claimsB64, sigB64] = jwt.split(".");

  assert.equal(decode(headerB64).alg, "ES256");
  assert.deepEqual(decode(claimsB64).uris, ["GET api.cdp.coinbase.com/platform/v2/x402/supported"]);

  const sig = Buffer.from(sigB64, "base64url");
  assert.equal(sig.length, 64, "JOSE ES256 signatures are raw r||s, not DER");

  const ok = cryptoVerify(
    "sha256",
    Buffer.from(`${headerB64}.${claimsB64}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    sig,
  );
  assert.equal(ok, true);
});

test("cdp: the token is bound to one path, so it cannot be replayed elsewhere", () => {
  const { secret } = ed25519Secret();
  const a = cdpJwt({ keyId: "k", keySecret: secret, path: "/platform/v2/x402/verify", now: 1_800_000_000 });
  const b = cdpJwt({ keyId: "k", keySecret: secret, path: "/platform/v2/x402/settle", now: 1_800_000_000 });
  const urisOf = (jwt) => decode(jwt.split(".")[1]).uris[0];
  assert.notEqual(urisOf(a), urisOf(b));
});

test("cdp: two tokens for the same request differ (fresh nonce and signature)", () => {
  const { secret } = ed25519Secret();
  const a = cdpJwt({ keyId: "k", keySecret: secret, path: "/platform/v2/x402/verify", now: 1_800_000_000 });
  const b = cdpJwt({ keyId: "k", keySecret: secret, path: "/platform/v2/x402/verify", now: 1_800_000_000 });
  assert.notEqual(decode(a.split(".")[0]).nonce, decode(b.split(".")[0]).nonce);
  assert.notEqual(a, b);
});

test("cdp: missing or malformed credentials fail loudly, never silently", () => {
  assert.throws(() => cdpJwt({ keyId: "k", keySecret: "", path: "/x" }), /CDP_API_KEY_SECRET is empty/);
  assert.throws(() => cdpJwt({ keyId: "", keySecret: "AAAA", path: "/x" }), /CDP_API_KEY_ID is required/);
  assert.throws(() => cdpJwt({ keyId: "k", keySecret: "AAAA", path: "" }), /path is required/);
  assert.throws(() => cdpJwt({ keyId: "k", keySecret: Buffer.alloc(12).toString("base64"), path: "/x" }), /Ed25519 secret/);
});

test("cdp: header set covers the three facilitator endpoints with the right methods", () => {
  const { secret, publicKey } = ed25519Secret();
  const mint = cdpAuthHeaders({ keyId: "kid", keySecret: secret, baseUrl: CDP_FACILITATOR_URL });
  return Promise.resolve(mint()).then((headers) => {
    for (const key of ["verify", "settle", "supported"]) {
      assert.ok(headers[key]?.Authorization?.startsWith("Bearer "), `${key} must carry a bearer token`);
      const jwt = headers[key].Authorization.slice("Bearer ".length);
      const [h, c, s] = jwt.split(".");
      assert.equal(cryptoVerify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")), true);
    }
    assert.deepEqual(decode(headers.verify.Authorization.split(".")[1]).uris, ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);
    assert.deepEqual(decode(headers.settle.Authorization.split(".")[1]).uris, ["POST api.cdp.coinbase.com/platform/v2/x402/settle"]);
    assert.deepEqual(decode(headers.supported.Authorization.split(".")[1]).uris, ["GET api.cdp.coinbase.com/platform/v2/x402/supported"]);
  });
});

test("cdp: facilitator URL detection is exact, not a substring match", () => {
  assert.equal(isCdpFacilitatorUrl(CDP_FACILITATOR_URL), true);
  assert.equal(isCdpFacilitatorUrl("https://api.cdp.coinbase.com/platform/v2/x402/"), true);
  assert.equal(isCdpFacilitatorUrl("https://x402.org/facilitator"), false);
  assert.equal(isCdpFacilitatorUrl("https://facilitator.payai.network"), false);
  assert.equal(isCdpFacilitatorUrl("https://api.cdp.coinbase.com.evil.test/x"), false);
  assert.equal(isCdpFacilitatorUrl("not a url"), false);
  assert.equal(isCdpFacilitatorUrl(undefined), false);
});

test("cdp: a key pair round-trips through createPrivateKey the same way CDP parses it", () => {
  const { secret } = ed25519Secret();
  const raw = Buffer.from(secret, "base64");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: raw.subarray(0, 32).toString("base64url"), x: raw.subarray(32).toString("base64url") },
    format: "jwk",
  });
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(createPublicKey(key).asymmetricKeyType, "ed25519");
});
