// Exercises the installed MCP bridge's real x402 client path (createBridgeClientFromEnv
// from mcp-bridge/index.mjs) through requirement selection, policy, and the
// onBeforePaymentCreation guard, using a fake exact scheme as the signer.
// No wallet key material, network, or payment is used.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePaymentRequiredHeader } from "../x402-client.mjs";

process.env.EVM_PRIVATE_KEY = "0x" + "11".repeat(32);
process.env.VERIFY402_URL = "https://verify402.onrender.com";
process.env.VERIFY402_NETWORKS = "eip155:84532";
process.env.MAX_PAYMENT_USD = "0.25";

const { createBridgeClientFromEnv, createBridgePaidClient, runPaidTool, runWithPaidTool, PAID_TOOL_ROUTES } = await import("../index.mjs");
const { CLIENT_HEADERS, VERSION } = await import("../client-id.mjs");
const {
  createPaymentGuard,
  createPaymentPolicy,
  DEMO_NETWORK,
  DEMO_USDC,
  MAINNET_NETWORK,
  MAINNET_USDC,
  DEFAULT_PAY_TO,
} = await import("../payment-policy.mjs");

const SERVER_URL = "https://verify402.onrender.com";
const RESOURCE = `${SERVER_URL}/route`;
const PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";

test("the bridge identifies itself with an anonymous, versioned client label", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
  assert.equal(CLIENT_HEADERS["X-Verify402-Client"], `verify402-mcp/${pkg.version}`);
  assert.equal(CLIENT_HEADERS["User-Agent"], `verify402-mcp/${pkg.version}`);
  assert.equal(/0x[0-9a-f]{40}|private.?key|wallet/i.test(JSON.stringify(CLIENT_HEADERS)), false);
});

function makeRequirement(overrides = {}) {
  return {
    scheme: "exact",
    network: DEMO_NETWORK,
    amount: "30000",
    asset: DEMO_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

function makeChallenge(requirementOverrides = {}, challengeOverrides = {}) {
  return {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [makeRequirement(requirementOverrides)],
    ...challengeOverrides,
  };
}

function makeFakeScheme(signerCalls) {
  return {
    scheme: "exact",
    findDefaultAsset: (_asset, _network) => ({ asset: "", decimals: 6, symbol: "USDC" }),
    createPaymentPayload: async (x402Version, requirements) => {
      signerCalls.count += 1;
      return {
        x402Version,
        payload: { authorization: { requirement: requirements }, signature: "0xfake" },
      };
    },
  };
}

async function runCase({ challenge }) {
  const signerCalls = { count: 0 };
  const client = createBridgeClientFromEnv();
  client.register(DEMO_NETWORK, makeFakeScheme(signerCalls));
  let error = null;
  let result = null;
  try {
    // These cases exercise the guard for the /route tool, so run them inside
    // the same async context the real get_best_route handler uses.
    result = await runWithPaidTool("get_best_route", () => client.createPaymentPayload(challenge));
  } catch (caught) {
    error = caught;
  }
  return { error, result, signerCalls };
}

test("the installed bridge signs a valid Base Sepolia /route challenge through the real client path", async () => {
  const { error, result, signerCalls } = await runCase({ challenge: makeChallenge() });
  assert.equal(error, null);
  assert.equal(signerCalls.count, 1);
  assert.equal(result.accepted.network, DEMO_NETWORK);
});

test("the installed bridge rejects a missing maxTimeoutSeconds before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({ challenge: makeChallenge({ maxTimeoutSeconds: undefined }) });
  assert.ok(error);
  assert.match(error.message, /Payment creation aborted/);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a numeric-string maxTimeoutSeconds before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({ challenge: makeChallenge({ maxTimeoutSeconds: "300" }) });
  assert.ok(error);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a maxTimeoutSeconds above the 300s cap before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({ challenge: makeChallenge({ maxTimeoutSeconds: 301 }) });
  assert.ok(error);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a fractional, zero, or negative maxTimeoutSeconds before the fake signer runs", async () => {
  for (const value of [300.5, 0, -1]) {
    const { error, signerCalls } = await runCase({
      challenge: makeChallenge({ maxTimeoutSeconds: value }),
    });
    assert.ok(error, `expected ${value} to be refused`);
    assert.equal(signerCalls.count, 0);
  }
});

test("the installed bridge accepts exactly the 300 second maxTimeoutSeconds boundary", async () => {
  const { error, signerCalls } = await runCase({
    challenge: makeChallenge({ maxTimeoutSeconds: 300 }),
  });
  assert.equal(error, null);
  assert.equal(signerCalls.count, 1);
});

test("the installed bridge rejects an amount above the configured spend cap before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({ challenge: makeChallenge({ amount: "300001" }) });
  assert.ok(error);
  assert.match(error.message, /rejected by spendControls|USD cap/);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a wrong canonical asset before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({ challenge: makeChallenge({ asset: MAINNET_USDC }) });
  assert.ok(error);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a mainnet-only challenge before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({
    challenge: makeChallenge({ network: MAINNET_NETWORK, asset: MAINNET_USDC }),
  });
  assert.ok(error);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a query-bearing resource before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({
    challenge: makeChallenge({}, { resource: { url: `${SERVER_URL}/route?x=1` } }),
  });
  assert.ok(error);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a trailing-slash resource before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({
    challenge: makeChallenge({}, { resource: { url: `${SERVER_URL}/route/` } }),
  });
  assert.ok(error);
  assert.equal(signerCalls.count, 0);
});

test("the installed bridge rejects a Permit2 transfer method before the fake signer runs", async () => {
  const { error, signerCalls } = await runCase({
    challenge: makeChallenge({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }),
  });
  assert.ok(error);
  assert.equal(signerCalls.count, 0);
});

test("importing the bridge never loads the operator's .env wallet file", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bridgePath = path.join(here, "..", "index.mjs");
  const workDir = mkdtempSync(path.join(tmpdir(), "verify402-bridge-"));
  const sentinel = "0x" + "22".repeat(32);
  writeFileSync(
    path.join(workDir, ".env"),
    `EVM_PRIVATE_KEY=${sentinel}\nMAX_PAYMENT_USD=0.99\n`,
    { mode: 0o600 },
  );

  const script = [
    `await import(${JSON.stringify(bridgePath)});`,
    `process.stdout.write(String(process.env.EVM_PRIVATE_KEY ?? "unset"));`,
  ].join("\n");

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
    // An empty environment: the child must not inherit the operator's wallet
    // configuration either.
    env: {},
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(code, 0);
  assert.equal(
    out.trim(),
    "unset",
    "importing the bridge must not read .env from the working directory",
  );
});

test("the installed client and the shared policy guard make the same decision", async () => {
  const policy = createPaymentPolicy({
    networks: [DEMO_NETWORK],
    payTo: DEFAULT_PAY_TO,
    resourcePrefix: SERVER_URL,
    paidRoutes: ["/route"],
  });
  const guard = createPaymentGuard(policy, { expectedResource: RESOURCE, maxAmountUsd: 0.25 });
  const validChallenge = makeChallenge();
  const valid = guard({ paymentRequired: validChallenge, selectedRequirements: validChallenge.accepts[0] });
  assert.equal(valid, undefined);

  const invalidChallenge = makeChallenge({ maxTimeoutSeconds: "300" });
  const invalid = guard({
    paymentRequired: invalidChallenge,
    selectedRequirements: invalidChallenge.accepts[0],
  });
  assert.equal(invalid?.abort, true);
});

// ---------------------------------------------------------------------------
// Tool/resource binding through the real tool path.
//
// These tests drive runPaidTool -> paidPost -> the x402-wrapped axios instance
// -> the local payer's createPaymentPayload -> the shared guard -> the fake signer. The
// transport is a local axios adapter, so the complete production path is
// exercised without a socket.
// ---------------------------------------------------------------------------

function challengeAt(url) {
  return {
    x402Version: 2,
    resource: { url },
    accepts: [makeRequirement()],
  };
}

function settlementHeader() {
  return Buffer.from(
    JSON.stringify({
      success: true,
      transaction: "0x" + "ab".repeat(32),
      network: DEMO_NETWORK,
      payer: PAY_TO,
    }),
  ).toString("base64");
}

// The adapter returns one 402 carrying `challenge`, then a 200 only if the
// retry actually carries a payment signature.
function makeAdapter({ challenge, calls }) {
  const paymentRequired = encodePaymentRequiredHeader(challenge);
  return async (config) => {
    const header = (name) => (
      config.headers?.get?.(name) ?? config.headers?.[name] ?? config.headers?.[name.toLowerCase()]
    );
    const signed = Boolean(
      config.headers?.get?.("PAYMENT-SIGNATURE") ?? config.headers?.["PAYMENT-SIGNATURE"],
    );
    calls.push({
      url: config.url,
      signed,
      client: header("x-verify402-client"),
      userAgent: header("user-agent"),
    });
    if (!signed) {
      const error = new Error("Request failed with status code 402");
      error.config = config;
      error.response = {
        status: 402,
        statusText: "Payment Required",
        headers: { "payment-required": paymentRequired },
        data: { error: "Payment required" },
        config,
      };
      throw error;
    }
    return {
      data: { ok: true, path: config.url },
      status: 200,
      statusText: "OK",
      headers: { "payment-response": settlementHeader() },
      config,
    };
  };
}

async function driveTool({ tool, challenge }) {
  const signerCalls = { count: 0 };
  const client = createBridgeClientFromEnv();
  client.register(DEMO_NETWORK, makeFakeScheme(signerCalls));
  const paid = await createBridgePaidClient(client);
  const calls = [];
  paid.defaults.adapter = makeAdapter({ challenge, calls });
  let error = null;
  let result = null;
  try {
    result = await runPaidTool({ tool, client: paid, body: { probe: true } });
  } catch (caught) {
    error = caught;
  }
  return { error, result, signerCalls, calls };
}

const TOOL_ROUTE_IDS = {
  verify_arbitrage: "/verify",
  check_token_safety: "/safety",
  get_best_route: "/route",
  verify_quote_fairness: "/quotecheck",
  get_trade_depth: "/depth",
};

test("every paid tool is bound to exactly one paid route", () => {
  assert.deepEqual({ ...PAID_TOOL_ROUTES }, TOOL_ROUTE_IDS);
});

test("each paid tool accepts its own resource and completes the paid call", async () => {
  for (const [tool, route] of Object.entries(TOOL_ROUTE_IDS)) {
    const { error, result, signerCalls, calls } = await driveTool({
      tool,
      challenge: challengeAt(`${SERVER_URL}${route}`),
    });
    assert.equal(error, null, `${tool} failed: ${error?.message}`);
    assert.equal(result?.status, 200, `${tool} did not complete the paid call`);
    assert.equal(signerCalls.count, 1, `${tool} must sign exactly once`);
    assert.equal(calls.length, 2, `${tool} must send one request and one paid retry`);
    assert.equal(calls[0].url, route, `${tool} must request its own route`);
    assert.equal(calls[1].signed, true, `${tool} retry must carry a signature`);
    assert.equal(calls[0].client, CLIENT_HEADERS["X-Verify402-Client"], `${tool} label`);
    assert.equal(calls[0].userAgent, CLIENT_HEADERS["User-Agent"], `${tool} user-agent`);
  }
});

test("a challenge for another paid route is rejected before the signer runs", async () => {
  const crossRoutes = [
    ["get_best_route", "/verify"],
    ["get_best_route", "/safety"],
    ["verify_arbitrage", "/route"],
    ["check_token_safety", "/depth"],
    ["verify_quote_fairness", "/route"],
    ["get_trade_depth", "/quotecheck"],
  ];
  for (const [tool, foreignRoute] of crossRoutes) {
    const { error, signerCalls, calls } = await driveTool({
      tool,
      challenge: challengeAt(`${SERVER_URL}${foreignRoute}`),
    });
    assert.ok(error, `${tool} accepted a ${foreignRoute} challenge`);
    assert.match(error.message, /Payment creation aborted/);
    assert.equal(signerCalls.count, 0, `${tool} invoked the signer for ${foreignRoute}`);
    assert.equal(calls.length, 1, `${tool} must not retry without signing`);
  }
});

test("a fully valid challenge cannot be substituted for a different tool's request", async () => {
  const verifyChallenge = challengeAt(`${SERVER_URL}/verify`);

  // The same object is a valid payment for the tool that owns /verify.
  const owner = await driveTool({ tool: "verify_arbitrage", challenge: verifyChallenge });
  assert.equal(owner.error, null, owner.error?.message);
  assert.equal(owner.signerCalls.count, 1);

  // A different tool paying the same challenge must be refused, unsigned.
  const substituted = await driveTool({ tool: "get_best_route", challenge: verifyChallenge });
  assert.ok(substituted.error);
  assert.match(substituted.error.message, /Payment creation aborted/);
  assert.equal(substituted.signerCalls.count, 0);
  assert.equal(substituted.calls.length, 1);
});

test("query, fragment, and trailing-slash resources are rejected before the signer runs", async () => {
  for (const [tool, route] of Object.entries(TOOL_ROUTE_IDS)) {
    for (const suffix of ["?x=1", "#frag", "/"]) {
      const { error, signerCalls, calls } = await driveTool({
        tool,
        challenge: challengeAt(`${SERVER_URL}${route}${suffix}`),
      });
      assert.ok(error, `${tool} accepted a ${suffix} resource`);
      assert.match(error.message, /Payment creation aborted/);
      assert.equal(signerCalls.count, 0, `${tool} signed a ${suffix} resource`);
      assert.equal(calls.length, 1);
    }
  }
});

test("a paid call with no tool binding fails closed before the signer", async () => {
  // If a future code path ever calls the x402 client outside runPaidTool, the
  // guard must refuse instead of signing an unbound challenge.
  const signerCalls = { count: 0 };
  const client = createBridgeClientFromEnv();
  client.register(DEMO_NETWORK, makeFakeScheme(signerCalls));
  await assert.rejects(
    () => client.createPaymentPayload(challengeAt(`${SERVER_URL}/route`)),
    /no expected payment resource is bound to this call/,
  );
  assert.equal(signerCalls.count, 0);
});
