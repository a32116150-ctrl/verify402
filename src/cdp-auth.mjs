// Coinbase CDP facilitator auth, without the CDP SDK.
//
// Why this exists: the Bazaar catalog that agents search is fed by the CDP
// facilitator, so a seller that settles anywhere else is not indexed at all.
// We want to settle through CDP, and the SDK that does so is ~104 packages with
// a high-severity advisory in a transitive validator (zod) — a bad trade for a
// service whose whole pitch is "check before you sign".
//
// So this module does the only part of the SDK we need: mint the short-lived
// JWT that CDP's REST API accepts, using node:crypto. It mirrors
// `generateJwt` in @coinbase/cdp-sdk (Ed25519 or ES256 key, 120 s expiry,
// `uris` bound to the exact method+host+path, random nonce in the header).
//
// Nothing here touches money: the facilitator only verifies and submits signed
// payments that a buyer already authorised; funds move on-chain to `payTo`.

import { createPrivateKey, sign as cryptoSign, randomBytes } from "node:crypto";

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

const b64url = (value) => Buffer.from(value).toString("base64url");

function nonce() {
  return randomBytes(16).toString("hex");
}

// CDP hands out two key shapes: a base64 Ed25519 secret (64 bytes: 32-byte
// seed + 32-byte public key) and, for some accounts, a PEM EC private key.
function keyFromSecret(secret) {
  const s = String(secret ?? "").trim();
  if (!s) throw new Error("CDP_API_KEY_SECRET is empty");
  if (s.includes("BEGIN PRIVATE KEY")) {
    return { kind: "es256", key: createPrivateKey({ key: s, format: "pem" }) };
  }
  const raw = Buffer.from(s, "base64");
  if (raw.length === 64) {
    return {
      kind: "eddsa",
      key: createPrivateKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          d: raw.subarray(0, 32).toString("base64url"),
          x: raw.subarray(32).toString("base64url"),
        },
        format: "jwk",
      }),
    };
  }
  throw new Error(
    "CDP_API_KEY_SECRET must be a base64 Ed25519 secret (64 bytes) or a PEM EC private key; " +
      `got ${raw.length} decoded bytes`,
  );
}

// ES256 signatures are DER-encoded (SEQUENCE of two INTEGERs); JOSE wants the
// raw r||s pair, each left-padded to the curve size.
function derToJose(der, size) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("malformed ECDSA signature: expected SEQUENCE");
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f);
  else i += 1;
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error("malformed ECDSA signature: expected INTEGER");
    const len = der[i++];
    let value = der.subarray(i, i + len);
    i += len;
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    const out = Buffer.alloc(size);
    value.copy(out, size - value.length);
    return out;
  };
  return Buffer.concat([readInt(), readInt()]);
}

// One JWT per facilitator path, because the `uris` claim is bound to the exact
// request: a token minted for /verify is not accepted for /settle.
export function cdpJwt({
  keyId,
  keySecret,
  method = "POST",
  host = "api.cdp.coinbase.com",
  path,
  now = Math.floor(Date.now() / 1000),
  ttlSeconds = 120,
} = {}) {
  if (!keyId) throw new Error("CDP_API_KEY_ID is required");
  if (!path) throw new Error("path is required");
  const { kind, key } = keyFromSecret(keySecret);
  const alg = kind === "eddsa" ? "EdDSA" : "ES256";
  const header = { alg, kid: keyId, typ: "JWT", nonce: nonce() };
  const claims = {
    sub: keyId,
    iss: "cdp",
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
    uris: [`${String(method).toUpperCase()} ${host}${path}`],
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature =
    kind === "eddsa"
      ? cryptoSign(null, Buffer.from(signingInput), key)
      : derToJose(cryptoSign("sha256", Buffer.from(signingInput), key), 32);
  return `${signingInput}.${b64url(signature)}`;
}

// Shape expected by @x402/core's HTTPFacilitatorClient.createAuthHeaders.
export function cdpAuthHeaders({
  keyId = process.env.CDP_API_KEY_ID,
  keySecret = process.env.CDP_API_KEY_SECRET,
  baseUrl = CDP_FACILITATOR_URL,
} = {}) {
  const parsed = new URL(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const host = parsed.host;
  const paths = {
    verify: `${basePath}/verify`,
    settle: `${basePath}/settle`,
    supported: `${basePath}/supported`,
  };
  return async () => {
    const mint = (path, method) => ({
      Authorization: `Bearer ${cdpJwt({ keyId, keySecret, method, host, path })}`,
    });
    return {
      verify: mint(paths.verify, "POST"),
      settle: mint(paths.settle, "POST"),
      supported: mint(paths.supported, "GET"),
    };
  };
}

export function isCdpFacilitatorUrl(url) {
  try {
    return new URL(String(url)).host === "api.cdp.coinbase.com";
  } catch {
    return false;
  }
}
