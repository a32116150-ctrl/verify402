// Local paid engines must fail closed without a signed license, and the hosted
// server must remain unaffected. Uses a throwaway keypair; never the real one.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  LicenseRequiredError,
  enableHostedMode,
  requirePaidLicense,
  verifyLicenseToken,
} from "../src/license.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

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
  const other = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "der" }).toString("base64");
  const token = mint();
  assert.equal(verifyLicenseToken(token, { publicKey: other }).reason, "bad_signature");
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
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
