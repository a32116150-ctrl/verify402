// Local paid engines must fail closed without a signed license, and the hosted
// server must remain unaffected. Uses a throwaway keypair; never the real one.

import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  LicenseRequiredError,
  enableHostedMode,
  requirePaidLicense,
  verifyLicenseToken,
} from "../src/license.mjs";

// Fixed RFC 8032 test-vector keys keep this test deterministic. These are
// published vectors, not the project's signing key.
const FIXED_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const FIXED_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const OTHER_SEED_HEX = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const OTHER_PUBLIC_HEX = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";

function fixedPrivateKey(seedHex, publicHex) {
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(seedHex, "hex").toString("base64url"),
      x: Buffer.from(publicHex, "hex").toString("base64url"),
    },
    format: "jwk",
  });
}

const privateKey = fixedPrivateKey(FIXED_SEED_HEX, FIXED_PUBLIC_HEX);
const publicKey = createPublicKey(privateKey);
const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const otherPublicKeyBase64 = createPublicKey(fixedPrivateKey(OTHER_SEED_HEX, OTHER_PUBLIC_HEX))
  .export({ type: "spki", format: "der" }).toString("base64");

function mint({ exp, iat, kind = "verify402-local-license", body } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, kind, id: "test-license", iat: iat ?? now - 10, exp: exp ?? now + 3600 };
  const encoded = Buffer.from(body ?? JSON.stringify(payload)).toString("base64url");
  const data = `v1.${encoded}`;
  const signature = sign(null, Buffer.from(data, "utf8"), privateKey).toString("base64url");
  return `${data}.${signature}`;
}

function withEnv(values, fn) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

const NO_LICENSE = {
  VERIFY402_LICENSE_KEY: null,
  VERIFY402_LICENSE_BYPASS: null,
  X402_MODE: null,
};

test("accepts a correctly signed, unexpired license", () => {
  const result = verifyLicenseToken(mint(), { publicKey: publicKeyBase64 });
  assert.equal(result.ok, true);
  assert.equal(result.license.id, "test-license");
});

test("rejects missing and malformed tokens", () => {
  assert.equal(verifyLicenseToken(undefined).reason, "missing");
  assert.equal(verifyLicenseToken("").reason, "missing");
  assert.equal(verifyLicenseToken("garbage").reason, "missing");
  assert.equal(verifyLicenseToken("v1.onlyone").reason, "malformed");
  assert.equal(verifyLicenseToken("v1.notjson.sig").reason, "malformed");
});

test("rejects a different signing key and a tampered signature", () => {
  const token = mint();
  assert.equal(verifyLicenseToken(token, { publicKey: otherPublicKeyBase64 }).reason, "bad_signature");
  const parts = token.split(".");
  const signature = parts[2];
  parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  const tampered = parts.join(".");
  assert.equal(verifyLicenseToken(tampered, { publicKey: publicKeyBase64 }).reason, "bad_signature");
});

test("rejects expired, future and wrong-kind tokens", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyLicenseToken(mint({ exp: now - 1 }), { publicKey: publicKeyBase64 }).reason, "expired");
  assert.equal(verifyLicenseToken(mint({ iat: now + 3600 }), { publicKey: publicKeyBase64 }).reason, "not_yet_valid");
  assert.equal(verifyLicenseToken(mint({ kind: "something-else" }), { publicKey: publicKeyBase64 }).reason, "malformed");
});

test("requirePaidLicense fails closed without a license", () => withEnv(NO_LICENSE, () => {
  assert.throws(() => requirePaidLicense("safety", { publicKey: publicKeyBase64 }), (error) => {
    assert.ok(error instanceof LicenseRequiredError);
    assert.equal(error.code, "license_required");
    assert.match(error.message, /VERIFY402_LICENSE_KEY/);
    return true;
  });
}));

test("requirePaidLicense accepts a valid configured key", () => withEnv({
  ...NO_LICENSE,
  VERIFY402_LICENSE_KEY: mint(),
}, () => {
  const grant = requirePaidLicense("verify", { publicKey: publicKeyBase64 });
  assert.equal(grant.grantedBy, "license");
  assert.equal(grant.license.id, "test-license");
}));

test("local bypass is usable off mainnet but refused on mainnet", async () => {
  await withEnv({ ...NO_LICENSE, VERIFY402_LICENSE_BYPASS: "1", X402_MODE: "testnet" }, () => {
    assert.equal(requirePaidLicense("depth", { publicKey: publicKeyBase64 }).grantedBy, "bypass");
  });
  await withEnv({ ...NO_LICENSE, VERIFY402_LICENSE_BYPASS: "1", X402_MODE: "mainnet" }, () => {
    assert.throws(() => requirePaidLicense("depth", { publicKey: publicKeyBase64 }), (error) =>
      error instanceof LicenseRequiredError && error.code === "license_required");
  });
});

test("paid engines themselves refuse to run without a license", async () => {
  await withEnv(NO_LICENSE, async () => {
    const { measureRoundTrip } = await import("../src/measure.mjs");
    const { preTradeCheck } = await import("../src/safety.mjs");
    const { fairQuoteCheck, bestRouteBook } = await import("../src/quotecheck.mjs");
    const { depthProfile } = await import("../src/depth.mjs");
    const calls = [
      () => measureRoundTrip(1, {}),
      () => preTradeCheck(1, {}),
      () => fairQuoteCheck(1, {}),
      () => bestRouteBook(null, 1, {}),
      () => depthProfile(1, {}),
    ];
    for (const call of calls) {
      await assert.rejects(call, (error) => error.code === "license_required");
    }
  });
});

test("hosted server mode bypasses the local gate in a fresh process", () => {
  const moduleUrl = new URL("../src/license.mjs", import.meta.url).href;
  const code = [
    `import { enableHostedMode, requirePaidLicense } from ${JSON.stringify(moduleUrl)};`,
    "enableHostedMode();",
    "const grant = requirePaidLicense('safety');",
    "console.log(grant.grantedBy);",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: {
      ...process.env,
      VERIFY402_LICENSE_KEY: "",
      VERIFY402_LICENSE_BYPASS: "",
      X402_MODE: "mainnet",
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /hosted/);
});

// Keep this last: it changes module state for the rest of this process.
test("hosted mode can be enabled explicitly", () => withEnv(NO_LICENSE, () => {
  enableHostedMode();
  assert.equal(requirePaidLicense("quotecheck").grantedBy, "hosted");
}));
