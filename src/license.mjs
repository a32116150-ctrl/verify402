// Local license gate for the paid engines.
//
// The hosted service is paid through x402 at the HTTP boundary. A copy of this
// repository can also call the same engines directly, which does not touch the
// paywall. This module makes that local path require a signed license.
//
// This is a barrier, not a perfect lock: the source is public, so a determined
// reader can remove the checks. The real enforcement is keeping the paid
// computation server-side (see docs/LOCAL-LICENSE.md).
//
// Token: v1.<base64url(json)>.<base64url(ed25519 signature over "v1.<json>")>
// The public key below is the verifier. The signing key is held by the operator
// and is never in this repository.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const PUBLIC_KEY_SPKI_BASE64 = "MCowBQYDK2VwAyEAWLSJrnBbr7nKoB6wDwERs9QQ3SvZ2qNWgBTk3n5T9Mc=";
const TOKEN_PREFIX = "v1.";
const LICENSE_KIND = "verify402-local-license";

let hostedMode = false;

/** Called once by the hosted server: its paid calls are already charged. */
export function enableHostedMode() {
  hostedMode = true;
}

export function isHostedMode() {
  return hostedMode;
}

export class LicenseRequiredError extends Error {
  constructor(engine, reason = "missing") {
    super(
      `verify402: local ${engine} needs a paid license. ` +
      `Set VERIFY402_LICENSE_KEY to a signed license (see docs/LOCAL-LICENSE.md), ` +
      `or call the hosted paid endpoint at https://vex402.online/${engine}. ` +
      `(reason: ${reason})`,
    );
    this.name = "LicenseRequiredError";
    this.code = "license_required";
    this.engine = engine;
    this.reason = reason;
  }
}

/** Verify a signed local-license token. `publicKey` is injectable for tests. */
export function verifyLicenseToken(token, {
  publicKey = PUBLIC_KEY_SPKI_BASE64,
  now = Date.now(),
} = {}) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, reason: "missing" };
  }
  const parts = token.slice(TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || payload.kind !== LICENSE_KIND ||
      typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: "malformed" };
  }
  let signature;
  try {
    signature = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  } catch {
    return { ok: false, reason: "bad_verifier_key" };
  }
  let valid = false;
  try {
    valid = cryptoVerify(null, Buffer.from(`${TOKEN_PREFIX}${parts[0]}`, "utf8"), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  if (typeof payload.iat === "number" && payload.iat * 1000 > now + 60_000) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true, license: payload };
}

/**
 * Fail closed unless this process is the hosted service, the offline test
 * harness set the local bypass, or a valid signed license is configured.
 */
export function requirePaidLicense(engine, { publicKey = PUBLIC_KEY_SPKI_BASE64 } = {}) {
  if (hostedMode) return { grantedBy: "hosted" };
  if (process.env.X402_MODE !== "mainnet" && process.env.VERIFY402_LICENSE_BYPASS === "1") {
    return { grantedBy: "bypass" };
  }
  const result = verifyLicenseToken(process.env.VERIFY402_LICENSE_KEY, { publicKey });
  if (result.ok) return { grantedBy: "license", license: result.license };
  throw new LicenseRequiredError(engine, result.reason);
}
