import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { normalizeBaseUrl, parsePaymentChallenge, runSmoke, wakeService } from "../scripts/smoke.mjs";
import { encodePaymentRequiredHeader } from "@x402/core/http";

const BASE = "http://example.test";
const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";

const TESTNET = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "30000",
  asset: TESTNET_USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};
const MAINNET = {
  ...TESTNET,
  network: "eip155:8453",
  asset: MAINNET_USDC,
};

const PAID_ENV = {
  SMOKE_PAID: "1",
  EVM_PRIVATE_KEY: "0x" + "11".repeat(32),
  AGENT_URL: BASE,
};

function jsonResponse(status, body, headers = {}) {
  const map = new Map();
  for (const [k,v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    map.set(String(k).toLowerCase(), v);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: map,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

// Map-like headers support .get
function withGet(res) {
  const map = res.headers instanceof Map ? res.headers : new Map(Object.entries(res.headers));
  res.headers = {
    get: (name) => {
      if (!name) return null;
      const k = String(name).toLowerCase();
      return map.get(k) ?? map.get(name) ?? null;
    },
    set: (name, value) => map.set(String(name).toLowerCase(), value),
  };
  return res;
}

function challenge(accepts, resource) {
  return { x402Version: 2, resource: { url: resource }, accepts };
}

/**
 * A permissive mocked service that passes every free smoke check. Tests
 * override only the piece they are attacking, so a paid-path assertion cannot
 * accidentally pass because an unrelated free check failed first.
 */
function makePassingFetch({
  healthMode = "testnet",
  routeChallenge,
  routeStatus = 402,
  failPath = null,
  onRoute = null,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method || "GET", body: init?.body, headers: init?.headers });
    if (failPath && u.endsWith(failPath)) return withGet(jsonResponse(500, { ok: false }));
    if (u.endsWith("/health")) return withGet(jsonResponse(200, { ok: true, mode: healthMode }));
    if (u.endsWith("/ready")) {
      return withGet(jsonResponse(200, { ok: true, ready: true, blockNumber: 123 }));
    }
    if (u.includes("/preflight/verify")) return withGet(jsonResponse(200, { valid: true }));
    if (u.includes("/preflight")) {
      const bodyText = String(init?.body || "");
      if (bodyText.includes("1000000000")) {
        return withGet(jsonResponse(200, {
          verdict: "BLOCK",
          receipt: { hmac: "x" },
          checked: ["a"],
          notChecked: ["b"],
        }));
      }
      if (bodyText.includes('"kind":"transaction"')) {
        return withGet(jsonResponse(400, { code: "missing_chain" }));
      }
      return withGet(jsonResponse(200, {
        verdict: "CAUTION",
        receipt: { hmac: "x" },
        checked: ["a"],
        notChecked: ["b"],
      }));
    }
    if (u.endsWith("/.well-known/agent-card.json")) return withGet(jsonResponse(200, BASE));
    if (u.endsWith("/verify")) {
      if (init?.headers?.["x-idempotency-key"] === "test-1") {
        return withGet(jsonResponse(400, { code: "weak_idempotency_key" }));
      }
      const ch = challenge([TESTNET], `${BASE}/verify`);
      const hdr = encodePaymentRequiredHeader(ch);
      return withGet(jsonResponse(402, { error: "Payment required" }, { "payment-required": hdr }));
    }
    if (u.endsWith("/route")) {
      if (onRoute) return onRoute({ url: u, init });
      const ch = routeChallenge ?? challenge([TESTNET], `${BASE}/route`);
      if (routeStatus === 402) {
        const hdr = encodePaymentRequiredHeader(ch);
        return withGet(jsonResponse(402, { error: "Payment required" }, { "payment-required": hdr }));
      }
      return withGet(jsonResponse(routeStatus, ch));
    }
    return withGet(jsonResponse(404, {}));
  };
  return { fetchImpl, calls };
}

function fakeSpawn({ code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", code, null));
    return child;
  };
  return { spawnImpl, calls };
}

const calledRoute = (calls) => calls.some((call) => call.url.endsWith("/route"));

test("normalizeBaseUrl strips trailing slashes and defaults", () => {
  assert.equal(normalizeBaseUrl("http://example.com/"), "http://example.com");
  assert.equal(normalizeBaseUrl("http://example.com///"), "http://example.com");
  assert.equal(normalizeBaseUrl(""), "https://verify402.onrender.com");
});

test("runSmoke returns ok:false when a check fails", async () => {
  const failingFetch = async (url) => {
    if (url.endsWith("/health")) return withGet(jsonResponse(500, { ok: false }));
    return withGet(jsonResponse(200, {
      ok: true,
      ready: true,
      blockNumber: 1,
      verdict: "CAUTION",
      receipt: {},
      checked: [],
      notChecked: [],
    }));
  };
  const result = await runSmoke({ baseUrl: BASE, env: {}, fetchImpl: failingFetch, log: () => {} });
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
});

test("runSmoke returns ok:true when all mocked checks pass", async () => {
  const { fetchImpl } = makePassingFetch();
  const result = await runSmoke({
    baseUrl: BASE,
    env: { AGENT_URL: BASE },
    fetchImpl,
    log: () => {},
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test("wakeService retries until /health succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("cold");
    return withGet(jsonResponse(200, { ok: true }));
  };
  const result = await wakeService({ baseUrl: BASE, fetchImpl, retryDelayMs: 0, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test("wakeService returns ok:false when all attempts fail", async () => {
  const fetchImpl = async () => { throw new Error("still cold"); };
  const result = await wakeService({ baseUrl: BASE, fetchImpl, retries: 2, retryDelayMs: 0, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});

test("runSmoke with allowPaid:false never enters paid mode or spawns a payer", async () => {
  const { fetchImpl, calls } = makePassingFetch();
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: false,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(spawnCalls.length, 0);
  assert.equal(calledRoute(calls), false, "paid route must not be requested");
});

test("allowPaid:true with a mainnet /health never requests the paid route or spawns the payer", async () => {
  const { fetchImpl, calls } = makePassingFetch({ healthMode: "mainnet" });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.equal(calledRoute(calls), false, "no paid challenge may be requested for a mainnet target");
  const failure = result.failures.find((entry) => entry.name === "paid mode preflight");
  assert.ok(failure, "paid preflight must record a blocking failure");
  assert.match(failure.error, /expected testnet/);
});

test("allowPaid:true with a testnet /health but a mainnet 402 challenge never spawns the payer", async () => {
  const { fetchImpl } = makePassingFetch({
    routeChallenge: challenge([MAINNET], `${BASE}/route`),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /not an allowed EVM network/,
  );
});

test("a mixed Base Sepolia + Base mainnet challenge is rejected by the paid smoke policy", async () => {
  const { fetchImpl } = makePassingFetch({
    routeChallenge: challenge([TESTNET, MAINNET], `${BASE}/route`),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /not an allowed EVM network/,
  );
});

test("an unexpected recipient is rejected before the payer is spawned", async () => {
  const { fetchImpl } = makePassingFetch({
    routeChallenge: challenge(
      [{ ...TESTNET, payTo: "0x1111111111111111111111111111111111111111" }],
      `${BASE}/route`,
    ),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /payee/,
  );
});

test("an explicitly empty expected payee fails closed instead of falling back", async () => {
  const { fetchImpl } = makePassingFetch();
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: { ...PAID_ENV, SMOKE_EXPECTED_PAY_TO: "" },
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /no valid expected payee/,
  );
});

test("a resource other than the requested /route endpoint is rejected", async () => {
  const { fetchImpl } = makePassingFetch({
    routeChallenge: challenge([TESTNET], `${BASE}/verify`),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /not the expected/,
  );
});

test("a malformed or missing network field fails closed", async () => {
  const { fetchImpl } = makePassingFetch({
    routeChallenge: challenge([{ ...TESTNET, network: undefined }], `${BASE}/route`),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /no valid network/,
  );
});

test("an amount above MAX_PAYMENT_USD is rejected before the payer is spawned", async () => {
  const { fetchImpl } = makePassingFetch({
    routeChallenge: challenge([{ ...TESTNET, amount: "60000" }], `${BASE}/route`),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /USD cap/,
  );
});

test("a failed free check stops the paid path before the challenge is requested", async () => {
  const { fetchImpl, calls } = makePassingFetch({ failPath: "/ready" });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.equal(calledRoute(calls), false);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /required free checks failed/,
  );
});

test("a valid mocked Base Sepolia challenge reaches the payer invocation path", async () => {
  const { fetchImpl } = makePassingFetch();
  const { spawnImpl, calls: spawnCalls } = fakeSpawn({ code: 0 });

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(spawnCalls.length, 1);

  const [command, args, options] = spawnCalls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, ["first-payment.mjs"]);
  assert.equal(options.cwd.endsWith("mcp-bridge"), true);
  assert.equal(options.env.VERIFY402_NETWORKS, "eip155:84532");
  assert.equal(options.env.VERIFY402_PAY_TO, PAY_TO);
  assert.equal(options.env.VERIFY402_RESOURCE_PREFIX, BASE);
  assert.equal(options.env.MAX_PAYMENT_USD, "0.03");
  assert.equal(options.env.SMOKE_PAID, "1");
});

// --- the 402 challenge comes from the header, never from the body -------------

test("a mainnet PAYMENT-REQUIRED header wins over a testnet body and aborts before the payer spawns", async () => {
  const body = challenge([TESTNET], `${BASE}/route`);
  const header = encodePaymentRequiredHeader(challenge([MAINNET], `${BASE}/route`));
  const { fetchImpl } = makePassingFetch({
    onRoute: () => withGet(jsonResponse(402, body, { "payment-required": header })),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /not an allowed EVM network/,
  );
});

test("a testnet PAYMENT-REQUIRED header is authoritative even when the body claims mainnet", async () => {
  const body = challenge([MAINNET], `${BASE}/route`);
  const header = encodePaymentRequiredHeader(challenge([TESTNET], `${BASE}/route`));
  const { fetchImpl } = makePassingFetch({
    onRoute: () => withGet(jsonResponse(402, body, { "payment-required": header })),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(spawnCalls.length, 1);
});

test("a 402 with only a body and no PAYMENT-REQUIRED header fails closed", async () => {
  const body = challenge([TESTNET], `${BASE}/route`);
  const { fetchImpl } = makePassingFetch({
    onRoute: () => withGet(jsonResponse(402, body)),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /no parseable 402 challenge/,
  );
});

test("a malformed PAYMENT-REQUIRED header fails closed instead of falling back to the body", async () => {
  const body = challenge([TESTNET], `${BASE}/route`);
  const { fetchImpl } = makePassingFetch({
    onRoute: () =>
      withGet(jsonResponse(402, body, { "payment-required": "not-a-valid-header!!" })),
  });
  const { spawnImpl, calls: spawnCalls } = fakeSpawn();

  const result = await runSmoke({
    baseUrl: BASE,
    env: PAID_ENV,
    allowPaid: true,
    fetchImpl,
    spawnImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
  assert.match(
    result.failures.find((entry) => entry.name === "paid mode preflight")?.error,
    /no parseable 402 challenge/,
  );
});

// --- strict PAYMENT-REQUIRED decoding ---------------------------------------
//
// The 402 challenge is base64 JSON in one header. Only canonical standard
// base64 is accepted, so an unparseable or non-canonical header aborts before
// a payer is spawned. The response body is never consulted.

function challengeHeader() {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: `${BASE}/route` },
    accepts: [TESTNET],
  });
}

test("402 parsing accepts the canonical header the service actually sends", () => {
  const parsed = parsePaymentChallenge(challengeHeader(), undefined, undefined);
  assert.ok(parsed, "canonical header must parse");
  assert.equal(parsed.x402Version, 2);
  assert.equal(parsed.accepts[0].network, "eip155:84532");
});

test("402 parsing rejects base64url encoding", () => {
  // A non-ASCII byte in the JSON guarantees the standard encoding contains a
  // "+" or "/", so the base64url fixture really differs from canonical base64.
  const json = JSON.stringify({
    x402Version: 2,
    resource: { url: `${BASE}/route` },
    accepts: [TESTNET],
    note: "\u00ff",
  });
  const canonical = Buffer.from(json).toString("base64");
  const urlSafe = Buffer.from(json).toString("base64url");
  assert.match(canonical, /[+/]/, "fixture must exercise the standard alphabet");
  assert.match(urlSafe, /[-_]/, "fixture must exercise the base64url alphabet");
  assert.equal(parsePaymentChallenge(urlSafe, undefined, undefined), null);
  // The same JSON in standard base64 is accepted, so the alphabet is the only
  // difference between the two inputs.
  assert.ok(parsePaymentChallenge(canonical, undefined, undefined));
});

test("402 parsing rejects trailing garbage", () => {
  const canonical = challengeHeader();
  assert.equal(parsePaymentChallenge(`${canonical}!!!`, undefined, undefined), null);
  assert.equal(parsePaymentChallenge(`${canonical}AAAA`, undefined, undefined), null);
});

test("402 parsing rejects malformed padding", () => {
  const canonical = challengeHeader();
  const unpadded = canonical.replace(/=+$/, "");
  for (const fixture of [unpadded, `${canonical}=`, `${unpadded}===`, "===="]) {
    assert.equal(parsePaymentChallenge(fixture, undefined, undefined), null, fixture);
  }
});

test("402 parsing rejects non-canonical trailing bits", () => {
  // "e31=" decodes to "{}" under a lenient decoder but does not re-encode to
  // itself, so it is not the byte string the service sent.
  assert.equal(parsePaymentChallenge("e31=", undefined, undefined), null);
});

test("402 parsing rejects invalid decoded JSON", () => {
  const fixture = Buffer.from("this is not json").toString("base64");
  assert.equal(parsePaymentChallenge(fixture, undefined, undefined), null);
});

test("402 parsing rejects a decoded object without an accepts array", () => {
  const fixture = Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64");
  assert.equal(parsePaymentChallenge(fixture, undefined, undefined), null);
  const arrayFixture = Buffer.from(JSON.stringify([])).toString("base64");
  assert.equal(parsePaymentChallenge(arrayFixture, undefined, undefined), null);
});

test("402 parsing never falls back to the response body", () => {
  const body = {
    x402Version: 2,
    resource: { url: `${BASE}/route` },
    accepts: [TESTNET],
  };
  assert.equal(parsePaymentChallenge(undefined, body, JSON.stringify(body)), null);
  assert.equal(parsePaymentChallenge(null, body, JSON.stringify(body)), null);
  assert.equal(parsePaymentChallenge("", body, JSON.stringify(body)), null);
});
