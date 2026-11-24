// Additive offline vectors for the default payment cap and the sign-in gate.
// Existing tests are untouched; this file only adds coverage for new findings.

import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  preflight,
  verifyReceipt,
  PreflightError,
  SELLER_TERMS_MANIFEST_SPEC,
} from "../src/preflight.mjs";
import { canonicalStable } from "../src/recovery.mjs";

const NOW = 1_700_000_000_000;
const FROM = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";
const PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://vex402.online/verify";
const SELLER_SIGNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const DEFAULT_CAP_MESSAGE =
  "no price cap supplied; amount exceeds the x402 SDK default per-payment cap of $1; set policy.maxAmountUsd to override";

function fakeClient() {
  return {
    async getBlock() {
      return { number: 123n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(NOW / 1000) };
    },
    async getCode() {
      return "0x6000";
    },
    async call() {
      return { data: "0x" };
    },
    async readContract({ functionName }) {
      if (functionName === "balanceOf") return 10_000_000n;
      if (functionName === "decimals") return 6;
      if (functionName === "symbol") return "USDC";
      return 0n;
    },
  };
}

function run(input, opts = {}) {
  return preflight(input, {
    clientFactory: () => fakeClient(),
    now: NOW,
    resolveHost: async () => ["93.184.216.34"],
    ...opts,
  });
}

function paymentIntent({ amount = "10000", policy = {} } = {}) {
  return {
    kind: "payment",
    payment: {
      scheme: "exact",
      network: "eip155:8453",
      asset: USDC,
      amount,
      payTo: PAY_TO,
      resource: RESOURCE,
      maxTimeoutSeconds: 60,
    },
    from: FROM,
    policy: {
      allowedResourceHosts: ["vex402.online"],
      ...policy,
    },
  };
}

async function termsManifest(amount) {
  const payload = {
    spec: SELLER_TERMS_MANIFEST_SPEC,
    seller: "seller.example",
    chainId: 8453,
    terms: [{
      resource: RESOURCE,
      network: "eip155:8453",
      asset: USDC,
      amount,
      maxTimeoutSeconds: 60,
    }],
    issuedAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    signer: SELLER_SIGNER.address,
  };
  const signature = await SELLER_SIGNER.signMessage({ message: canonicalStable(payload) });
  return { ...payload, signature };
}

function signIn({ fields = {}, expected = {} } = {}) {
  return {
    kind: "sign-in",
    signIn: {
      domain: "api.example",
      address: FROM,
      uri: "https://api.example/login",
      version: "1",
      chainId: "1",
      nonce: "abcdefgh1234",
      issuedAt: new Date(NOW - 1_000).toISOString(),
      expirationTime: new Date(NOW + 3_600_000).toISOString(),
      ...fields,
    },
    expected: {
      host: "api.example",
      chainId: 1,
      address: FROM,
      ...expected,
    },
  };
}

function codes(result) {
  return result.reasons.map((reason) => reason.code);
}

test("payment: over $1 with no cap or seller terms is CAUTION amount_above_default_cap", async () => {
  const out = await run(paymentIntent({ amount: "1000001" }));
  assert.equal(out.verdict, "CAUTION");
  const reason = out.reasons.find((r) => r.code === "amount_above_default_cap");
  assert.ok(reason, "expected the new default-cap finding");
  assert.equal(reason.severity, "caution");
  assert.equal(reason.message, DEFAULT_CAP_MESSAGE);
});

test("payment: exactly $1 with no cap stays PASS with no default-cap finding", async () => {
  const out = await run(paymentIntent({ amount: "1000000" }));
  assert.equal(out.verdict, "PASS");
  assert.equal(codes(out).includes("amount_above_default_cap"), false);
});

test("payment: an explicit cap keeps the existing BLOCK/PASS behaviour", async () => {
  const allowed = await run(paymentIntent({ amount: "1000001", policy: { maxAmountUsd: 2 } }));
  assert.equal(allowed.verdict, "PASS");
  assert.equal(codes(allowed).includes("amount_above_default_cap"), false);

  const blocked = await run(paymentIntent({ amount: "1000001", policy: { maxAmountUsd: 0.5 } }));
  assert.equal(blocked.verdict, "BLOCK");
  assert.ok(codes(blocked).includes("amount_over_policy"));
  assert.equal(codes(blocked).includes("amount_above_default_cap"), false);
});

test("payment: a seller terms manifest suppresses the default-cap caution", async () => {
  const manifest = await termsManifest("1000001");
  const out = await run(
    paymentIntent({
      amount: "1000001",
      policy: {
        sellerTermsManifest: {
          url: "https://seller.example/terms.json",
          expectedSigner: SELLER_SIGNER.address,
        },
      },
    }),
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(manifest),
      }),
    },
  );
  assert.equal(codes(out).includes("amount_above_default_cap"), false);
  assert.ok(out.termsBinding || out.reasons.some((r) => r.code === "seller_terms_unlisted_resource"));
});

test("sign-in: clean structured message is PASS with a verifiable receipt", async () => {
  const body = signIn();
  const out = await run(body);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.sign_allowed, true);
  assert.equal(out.requires_ack, false);
  assert.equal(out.receipt.kind, "sign-in");
  assert.equal(verifyReceipt(out.receipt, { now: NOW, intent: out.intent, request: body }).valid, true);
  for (const phrase of [
    "whether the site is legitimate",
    "whether the nonce was issued by the server",
    "replay state",
    "what the login grants",
  ]) {
    assert.ok(out.notChecked.includes(phrase), `notChecked must name: ${phrase}`);
  }
});

test("sign-in: raw EIP-4361 message text is parsed and PASSes", async () => {
  const body = {
    kind: "sign-in",
    message: [
      "api.example wants you to sign in with your Ethereum account:",
      FROM,
      "",
      "Sign in to verify402.",
      "",
      "URI: https://api.example/login",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: abcdefgh1234",
      `Issued At: ${new Date(NOW - 1_000).toISOString()}`,
      `Expiration Time: ${new Date(NOW + 3_600_000).toISOString()}`,
    ].join("\n"),
    expected: { host: "api.example", chainId: 1, address: FROM },
  };
  const out = await run(body);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.intent.signIn.domain, "api.example");
  assert.equal(out.intent.signIn.address, FROM.toLowerCase());
  assert.equal(out.intent.signIn.nonce, "abcdefgh1234");
  assert.equal(out.intent.source, "message");
});

test("sign-in: domain different from expected.host BLOCKs", async () => {
  const out = await run(signIn({ expected: { host: "good.example" } }));
  assert.equal(out.verdict, "BLOCK");
  assert.ok(codes(out).includes("siwx_domain_mismatch"));
});

test("sign-in: URI host different from message domain BLOCKs", async () => {
  const out = await run(signIn({ fields: { uri: "https://evil.example/login" } }));
  assert.equal(out.verdict, "BLOCK");
  assert.ok(codes(out).includes("siwx_uri_origin_mismatch"));
});

test("sign-in: no expected host is CAUTION siwx_domain_unbound", async () => {
  const out = await run(signIn({ expected: { host: null } }));
  assert.equal(out.verdict, "CAUTION");
  assert.ok(codes(out).includes("siwx_domain_unbound"));
});

test("sign-in: missing, short, or non-alphanumeric nonces are CAUTION", async () => {
  for (const nonce of [null, "abc", "abc-12345"]) {
    const out = await run(signIn({ fields: { nonce } }));
    assert.equal(out.verdict, "CAUTION");
    assert.ok(codes(out).includes("siwx_nonce_missing_or_weak"), `expected weak-nonce finding for ${nonce}`);
  }
});

test("sign-in: expired, future-issued, and >24h messages are CAUTION", async () => {
  const cases = [
    {
      issuedAt: new Date(NOW - 7_200_000).toISOString(),
      expirationTime: new Date(NOW - 3_600_000).toISOString(),
    },
    {
      issuedAt: new Date(NOW + 3_600_000).toISOString(),
      expirationTime: new Date(NOW + 7_200_000).toISOString(),
    },
    {
      issuedAt: new Date(NOW - 3_600_000).toISOString(),
      expirationTime: new Date(NOW + 90_000_000).toISOString(),
    },
  ];
  for (const timeFields of cases) {
    const out = await run(signIn({ fields: timeFields }));
    assert.equal(out.verdict, "CAUTION");
    assert.ok(codes(out).includes("siwx_expired_or_stale"));
  }
});

test("sign-in: expected chain and address mismatches are CAUTION", async () => {
  const chain = await run(signIn({ expected: { chainId: 8453 } }));
  assert.equal(chain.verdict, "CAUTION");
  assert.ok(codes(chain).includes("siwx_chain_mismatch"));

  const address = await run(signIn({ expected: { address: SPENDER } }));
  assert.equal(address.verdict, "CAUTION");
  assert.ok(codes(address).includes("siwx_address_mismatch"));
});

test("sign-in: missing message and fields fail closed with invalid_sign_in", async () => {
  await assert.rejects(
    () => run({ kind: "sign-in", signIn: {} }),
    (error) => error instanceof PreflightError && error.code === "invalid_sign_in",
  );
});
