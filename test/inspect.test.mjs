import test from "node:test";
import assert from "node:assert/strict";

import {
  isPublicIp, resolvePublicUrl, extractChallenge, acceptToPayment,
  summarizeAccept, inspectPaymentChallenge, inspectUrl, InspectError, resourceUrlOf,
} from "../src/inspect.mjs";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function challenge(overrides = {}) {
  return {
    x402Version: 2,
    resource: "https://example.com/paid",
    accepts: [{
      scheme: "exact",
      network: "eip155:84532",
      asset: USDC_BASE_SEPOLIA,
      amount: "30000",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
    }],
    ...overrides,
  };
}

test("isPublicIp rejects loopback, private, link-local, CGNAT and ULA", () => {
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("127.0.0.1"), false);
  assert.equal(isPublicIp("10.1.2.3"), false);
  assert.equal(isPublicIp("172.16.0.1"), false);
  assert.equal(isPublicIp("172.31.255.255"), false);
  assert.equal(isPublicIp("172.32.0.1"), true);
  assert.equal(isPublicIp("192.168.1.1"), false);
  assert.equal(isPublicIp("169.254.169.254"), false);
  assert.equal(isPublicIp("100.64.0.1"), false);
  assert.equal(isPublicIp("224.0.0.1"), false);
  assert.equal(isPublicIp("::1"), false);
  assert.equal(isPublicIp("::"), false);
  assert.equal(isPublicIp("fe80::1"), false);
  assert.equal(isPublicIp("fc00::1"), false);
  assert.equal(isPublicIp("::ffff:127.0.0.1"), false);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("resolvePublicUrl refuses localhost, credentials, non-http and private DNS answers", async () => {
  await assert.rejects(() => resolvePublicUrl("http://localhost:3000/x"), (e) => e instanceof InspectError && e.code === "blocked_host");
  await assert.rejects(() => resolvePublicUrl("file:///etc/passwd"), (e) => e.code === "invalid_url");
  await assert.rejects(() => resolvePublicUrl("https://user:pass@example.com/x"), (e) => e.code === "invalid_url");
  await assert.rejects(
    () => resolvePublicUrl("https://evil.example", { resolveHost: async () => [{ address: "127.0.0.1", family: 4 }] }),
    (e) => e.code === "blocked_host",
  );
  const ok = await resolvePublicUrl("https://example.com/x", {
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(ok.address, "93.184.216.34");
});

test("extractChallenge reads the v2 header, a body challenge, and refuses junk", () => {
  const payload = Buffer.from(JSON.stringify(challenge())).toString("base64");
  assert.equal(extractChallenge({ header: payload }).accepts.length, 1);
  assert.equal(extractChallenge({ body: JSON.stringify(challenge()) }).resource, "https://example.com/paid");
  assert.throws(() => extractChallenge({ body: '{"hello":true}' }), (e) => e.code === "no_challenge");
  assert.throws(() => extractChallenge({ body: "not json" }), (e) => e.code === "invalid_challenge");
});

test("extractChallenge refuses a header and body that disagree, and accepts a matching pair", () => {
  const same = challenge();
  const header = Buffer.from(JSON.stringify(same)).toString("base64");
  // Matching bytes, only key order differs: not a mismatch.
  const reordered = {
    ...same,
    accepts: [{ maxTimeoutSeconds: 60, payTo: same.accepts[0].payTo, amount: "30000", asset: same.accepts[0].asset, network: "eip155:84532", scheme: "exact" }],
  };
  assert.equal(extractChallenge({ header, body: JSON.stringify(reordered) }).accepts[0].payTo, same.accepts[0].payTo);

  // Same shape, one field swapped: the case a swapped-payee attack produces.
  const swapped = { ...same, accepts: [{ ...same.accepts[0], payTo: "0x2222222222222222222222222222222222222222" }] };
  assert.throws(
    () => extractChallenge({ header, body: JSON.stringify(swapped) }),
    (e) => e instanceof InspectError && e.code === "challenge_mismatch",
  );

  // Prose or a stub next to a valid header is normal for HTML 402s: keep the header.
  assert.equal(extractChallenge({ header, body: "Payment required" }).accepts.length, 1);
  assert.equal(extractChallenge({ header, body: '{"error":"Payment required"}' }).accepts.length, 1);

  // Same accepts; the body just omits the wrapper resource (echoes the header
  // terms next to its own error prose). That is not a contradiction — and it
  // is what mainstream 402 sellers send.
  const bodyNoResource = JSON.stringify({
    x402Version: 2,
    accepts: same.accepts,
    error: "Payment Required",
  });
  assert.equal(extractChallenge({ header, body: bodyNoResource }).accepts[0].payTo, same.accepts[0].payTo);

  // Same terms in the v1 dialect the header echoes as v2 is not a contradiction
  // either — real sellers announce the demand in both dialects (a v1 body
  // beside a v2 header, sharing amount/asset/payTo/chain spelling differences).
  const v1Mirror = {
    x402Version: 1,
    error: "Payment Required",
    accepts: [{
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "30000",
      resource: "https://example.com/paid",
      payTo: same.accepts[0].payTo,
      maxTimeoutSeconds: 60,
      asset: same.accepts[0].asset,
    }],
  };
  assert.equal(extractChallenge({ header, body: JSON.stringify(v1Mirror) }).accepts[0].payTo, same.accepts[0].payTo);

  // A v1 mirror with its payee swapped is still a contradiction.
  const v1Swapped = JSON.parse(JSON.stringify(v1Mirror));
  v1Swapped.accepts[0].payTo = "0x2222222222222222222222222222222222222222";
  assert.throws(
    () => extractChallenge({ header, body: JSON.stringify(v1Swapped) }),
    (e) => e instanceof InspectError && e.code === "challenge_mismatch",
  );

  // Same accepts; the wrapper resource differs from the claim side. Still not
  // a contradiction: accepts are the contract.
  const bodyOtherResource = JSON.stringify({ x402Version: 2, resource: "https://other.example/x", accepts: same.accepts });
  assert.equal(extractChallenge({ header, body: bodyOtherResource }).accepts[0].network, "eip155:84532");
});

test("acceptToPayment maps the accept fields and keeps the resource", () => {
  const payment = acceptToPayment(challenge().accepts[0], "https://example.com/paid");
  assert.equal(payment.network, "eip155:84532");
  assert.equal(payment.amount, "30000");
  assert.equal(payment.resource, "https://example.com/paid");
});

test("summarizeAccept prices canonical USDC and leaves unknown tokens unpriced", () => {
  const clean = summarizeAccept(challenge().accepts[0], "https://example.com/paid");
  assert.equal(clean.priceUsd, 0.03);
  const odd = summarizeAccept({ ...challenge().accepts[0], asset: "0xdead000000000000000000000000000000000000" }, null);
  assert.equal(odd.priceUsd, null);
});

test("inspectPaymentChallenge passes a clean challenge bound to the inspected URL", async () => {
  const result = await inspectPaymentChallenge({ challenge: challenge(), targetUrl: "https://example.com/paid" });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.sign_allowed, true);
  assert.equal(result.challenge.accepts[0].priceUsd, 0.03);
  assert.ok(result.receipt?.signature, "an inspection must carry a receipt");
});

test("without a target URL the resource cannot be bound, so the verdict is CAUTION", async () => {
  const result = await inspectPaymentChallenge({ challenge: challenge() });
  assert.equal(result.verdict, "CAUTION");
  assert.ok(result.reasons.some((r) => r.code === "resource_identity_unverified"));
});

test("a challenge naming a different host raises resource_host_mismatch", async () => {
  const result = await inspectPaymentChallenge({ challenge: challenge(), targetUrl: "https://other.example/paid" });
  assert.equal(result.verdict, "CAUTION");
  assert.ok(result.reasons.some((r) => r.code === "resource_host_mismatch"));
});

test("two payees on the same network raise multiple_payees", async () => {
  const two = challenge();
  two.accepts.push({ ...two.accepts[0], payTo: "0x2222222222222222222222222222222222222222" });
  const result = await inspectPaymentChallenge({ challenge: two, targetUrl: "https://example.com/paid" });
  assert.ok(result.reasons.some((r) => r.code === "multiple_payees"));
});

test("a multi-rail challenge pays one address per rail and is not flagged", async () => {
  const multi = challenge();
  multi.accepts.push({
    ...multi.accepts[0],
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    payTo: "BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ",
  });
  const result = await inspectPaymentChallenge({ challenge: multi, targetUrl: "https://example.com/paid" });
  assert.equal(result.reasons.some((r) => r.code === "multiple_payees"), false);
  assert.equal(result.options.length, 2);
});

test("the v2 resource object is read as a URL", async () => {
  const v2 = challenge({ resource: { url: "https://example.com/paid", mimeType: "application/json" } });
  assert.equal(resourceUrlOf(v2), "https://example.com/paid");
  const result = await inspectPaymentChallenge({ challenge: v2, targetUrl: "https://example.com/paid" });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.challenge.resource, "https://example.com/paid");
});

test("a challenge with no options is refused", async () => {
  await assert.rejects(
    () => inspectPaymentChallenge({ challenge: { accepts: [] } }),
    (e) => e.code === "no_accepts",
  );
});

test("inspectUrl fetches once, reads the header, and flags a non-402 answer", async () => {
  const header = Buffer.from(JSON.stringify(challenge())).toString("base64");
  const ok = await inspectUrl("https://example.com/paid", {
    fetchImpl: async () => ({ status: 402, headers: { "payment-required": header }, body: "" }),
  });
  assert.equal(ok.status, 402);
  assert.equal(ok.verdict, "PASS");

  const odd = await inspectUrl("https://example.com/page", {
    fetchImpl: async () => ({ status: 200, headers: { "payment-required": header }, body: "" }),
  });
  assert.equal(odd.verdict, "CAUTION");
  assert.ok(odd.reasons.some((r) => r.code === "not_402"));
});
