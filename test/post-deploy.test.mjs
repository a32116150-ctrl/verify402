import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function paymentRequired(network, asset, resource, timeoutSeconds = 300) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    ...(resource ? { resource: { url: resource } } : {}),
    accepts: [
      {
        scheme: "exact",
        network,
        amount: "50000",
        asset,
        payTo: DEFAULT_PAY_TO,
        maxTimeoutSeconds: timeoutSeconds,
        extra: { name: "USDC", version: "2" },
      },
    ],
  })).toString("base64");
}

function securityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
}

function json(res, body, status = 200, headers = {}) {
  res.statusCode = status;
  securityHeaders(res);
  res.setHeader("content-type", "application/json");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

function text(res, body, status = 200, type = "text/plain; charset=utf-8") {
  res.statusCode = status;
  securityHeaders(res);
  res.setHeader("content-type", type);
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body); } catch { return {}; }
}

function createMock({
  version = "1.0.9",
  mode = "testnet",
  challengeNetwork = "eip155:84532",
  challengeAsset = TESTNET_USDC,
  challengeTimeoutSeconds = 300,
  omitChallengeHeader = false,
  landingHtml = "<html><body>Public demo payments are Base Sepolia testnet USDC. Analysis reads mainnet chain data.</body></html>",
  llmsText = "# verify402\n\nPaid calls use testnet USDC on Base Sepolia (eip155:84532). Analysis reads mainnet chain data.\n",
} = {}) {
  return createServer(async (req, res) => {
    if (req.url === "/health") {
      return json(res, {
        ok: true,
        mode,
        version,
        price: "$0.05",
        preflight: "free",
        networks: mode === "testnet" ? "Base Sepolia / Solana devnet" : "Base mainnet / Solana mainnet",
        ready: "/ready",
      });
    }
    if (req.url === "/ready") return json(res, { ok: true, ready: true, blockNumber: 123, chainId: 1, latencyMs: 1 });
    if (req.url === "/info") return json(res, {
      name: "verify402",
      version,
      description: "quote-based sellability",
      prices: { verify: "$0.05", safety: "$0.10", route: "$0.03", quotecheck: "$0.05", depth: "$0.05" },
      recovery: { ttlMinutes: 10, noCompanionAlias: "no content-hash companion" },
      preflight: { defaultTtlSeconds: 90, limits: { perMinutePerIp: 60, maxInFlight: 8 } },
      state_persistence: { scope: "process-local", lostOnRestart: true, warning: "process-local restart or deploy not shared across instances" },
      chainIdRequired: "missing_chain",
      readiness: { path: "/ready" },
      hosting: { status: "Demo instance runs on a free host: first request after idle can take about a minute; testnet only." },
      mcp: { package: "verify402-mcp", version },
    });
    if (req.url === "/openapi.json") return json(res, {
      openapi: "3.1.0",
      info: { title: "verify402", version },
      paths: {
        "/verify": { post: { "x-payment-info": { price: { amount: "0.05" } } } },
        "/safety": { post: { "x-payment-info": { price: { amount: "0.10" } } } },
        "/route": { post: { "x-payment-info": { price: { amount: "0.03" } } } },
        "/quotecheck": { post: { "x-payment-info": { price: { amount: "0.05" } } } },
        "/depth": { post: { "x-payment-info": { price: { amount: "0.05" } } } },
      },
    });
    if (req.url === "/.well-known/verify402.json") return json(res, {
      version,
      operationalPolicies: {
        receipts: { defaultTtlSeconds: 90, rangeSeconds: "15-300" },
        rateLimits: { preflight: "60 requests/minute per IP, max concurrency 8" },
        idempotency: { description: "within a 600s window" },
      },
      paymentRequirements: {
        pricing: {
          verify: { priceUsd: 0.05 },
          safety: { priceUsd: 0.1 },
          route: { priceUsd: 0.03 },
          quotecheck: { priceUsd: 0.05 },
          depth: { priceUsd: 0.05 },
        },
      },
    });
    if (req.url === "/.well-known/x402") return json(res, {
      resources: [
        { url: "https://example.test/verify" },
        { url: "https://example.test/safety" },
        { url: "https://example.test/route" },
        { url: "https://example.test/quotecheck" },
        { url: "https://example.test/depth" },
      ],
    });
    if (req.url === "/llms.txt") return text(res, llmsText);
    if (req.url === "/") return text(res, landingHtml, 200, "text/html; charset=utf-8");
    if (req.url === "/.well-known/agent-card.json") {
      return json(res, { url: `http://${req.headers.host}/`, name: "verify402" });
    }
    if (req.url === "/preflight/verify") return json(res, { valid: true, reason: null });
    if (req.url === "/preflight" && req.method === "POST") {
      const body = await readJson(req);
      if (body.kind === "transaction" && !Number.isInteger(body.chainId)) {
        return json(res, { error: "missing_chain", code: "missing_chain" }, 400);
      }
      const amount = String(body.payment?.amount ?? "");
      if (amount === "1000000000") {
        return json(res, { verdict: "BLOCK", receipt: { hmac: "x" }, checked: ["a"], notChecked: ["b"] });
      }
      return json(res, { verdict: "CAUTION", sign_allowed: true, requires_ack: true, receipt: { hmac: "x" }, checked: ["a"], notChecked: ["b"] });
    }
    if (req.url === "/verify" && req.method === "POST") {
      if (req.headers["x-idempotency-key"] === "test-1") {
        return json(res, { error: "weak_idempotency_key", code: "weak_idempotency_key" }, 400);
      }
      const resource = `http://${req.headers.host}/verify`;
      const challenge = paymentRequired(challengeNetwork, challengeAsset, resource, challengeTimeoutSeconds);
      return json(
        res,
        { x402Version: 2, resource: { url: resource }, accepts: [{ scheme: "exact", network: challengeNetwork, asset: challengeAsset, payTo: DEFAULT_PAY_TO, amount: "50000", maxTimeoutSeconds: challengeTimeoutSeconds, extra: { name: "USDC", version: "2" } }] },
        402,
        omitChallengeHeader ? {} : { "payment-required": challenge },
      );
    }
    res.statusCode = 404;
    securityHeaders(res);
    res.end("{}");
  });
}

async function runPostDeploy(options = {}, env = {}) {
  const server = createMock(options);
  const requests = [];
  server.on("request", (req) => requests.push(`${req.method} ${req.url}`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, ["scripts/post-deploy-check.mjs"], {
    cwd: ROOT,
    env: { ...process.env, SMOKE_BASE_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  server.close();
  return { code, output, requests };
}

test("post-deploy prints wake result and passes against a current mock", async () => {
  const { code, output } = await runPostDeploy();
  assert.equal(code, 0, output);
  assert.match(output, /^wake: (ready|FAILED), \d+ms, \d+ attempt\(s\)$/m, output);
  assert.match(output, /release version is 1\.0\.9 \.\.\. PASS/, output);
  assert.match(output, /\/health reports mode testnet \.\.\. PASS/, output);
  assert.match(output, /402 challenge offers Base Sepolia testnet USDC \.\.\. PASS/, output);
});

test("post-deploy fails when the service is 1.0.4 but 1.0.9 is expected", async () => {
  const { code, output } = await runPostDeploy({ version: "1.0.4" });
  assert.equal(code, 1, output);
  assert.match(output, /release version is 1\.0\.9 \.\.\. FAIL/, output);
  assert.match(output, /1\.0\.4 !== 1\.0\.9/, output);
  assert.match(output, /post-deploy: FAIL/, output);
});

test("post-deploy fails when /health reports mainnet mode", async () => {
  const { code, output } = await runPostDeploy({ mode: "mainnet" });
  assert.equal(code, 1, output);
  assert.match(output, /\/health reports mode testnet \.\.\. FAIL/, output);
  assert.match(output, /mainnet !== testnet/, output);
});

test("post-deploy fails when the 402 challenge offers a mainnet-only EVM rail", async () => {
  const { code, output } = await runPostDeploy({
    challengeNetwork: "eip155:8453",
    challengeAsset: MAINNET_USDC,
  });
  assert.equal(code, 1, output);
  assert.match(output, /402 challenge offers Base Sepolia testnet USDC \.\.\. FAIL/, output);
  assert.match(output, /eip155:8453 !== eip155:84532|demo EVM payment rail is eip155:8453/, output);
});

test("post-deploy fails when the 402 challenge has no PAYMENT-REQUIRED header", async () => {
  const { code, output } = await runPostDeploy({ omitChallengeHeader: true });
  assert.equal(code, 1, output);
  assert.match(output, /402 challenge offers Base Sepolia testnet USDC \.\.\. FAIL/, output);
  assert.match(output, /could not parse a 402 challenge from the PAYMENT-REQUIRED header/, output);
});

test("post-deploy fails when the deployed 402 challenge would be refused by a payer", async () => {
  const { code, output } = await runPostDeploy({ challengeTimeoutSeconds: 86_400 });
  assert.equal(code, 1, output);
  assert.match(output, /402 challenge offers Base Sepolia testnet USDC \.\.\. FAIL/, output);
  assert.match(output, /would be refused by a payer/, output);
  assert.match(output, /maxTimeoutSeconds/, output);
});

test("post-deploy fails when /llms.txt advertises the old mainnet rail", async () => {
  const { code, output } = await runPostDeploy({
    llmsText: "# verify402\n\nPaid calls use USDC on Base mainnet or Solana.\n",
  });
  assert.equal(code, 1, output);
  assert.match(output, /\/llms\.txt describes the testnet payment rail \.\.\. FAIL/, output);
  assert.match(output, /does not say testnet|advertises mainnet/, output);
});

test("post-deploy fails when the landing page still claims Mainnet-armed", async () => {
  const { code, output } = await runPostDeploy({
    landingHtml: "<html><body>Mainnet-armed; demo payments are testnet.</body></html>",
  });
  assert.equal(code, 1, output);
  assert.match(output, /landing page no longer claims Mainnet-armed \.\.\. FAIL/, output);
  assert.match(output, /obsolete Mainnet-armed claim found/, output);
});

test("post-deploy stays free-only when the parent environment sets SMOKE_PAID=1", async () => {
  const { code, output, requests } = await runPostDeploy({}, {
    SMOKE_PAID: "1",
    EVM_PRIVATE_KEY: "0x" + "11".repeat(32),
  });

  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /paid mode guard|paid testnet/, output);
  assert.equal(
    requests.some((entry) => entry.includes("/route")),
    false,
    `paid path touched /route: ${requests.join(", ")}`,
  );
});

test("post-deploy rejects EXPECTED_MODE=mainnet before any network request", async () => {
  const { code, output, requests } = await runPostDeploy({}, { EXPECTED_MODE: "mainnet" });

  assert.equal(code, 1, output);
  assert.match(output, /unsupported EXPECTED_MODE "mainnet"/, output);
  assert.match(output, /testnet only/, output);
  assert.equal(requests.length, 0, `network requests were made: ${requests.join(", ")}`);
});

test("post-deploy rejects an unknown EXPECTED_MODE before any network request", async () => {
  const { code, output, requests } = await runPostDeploy({}, { EXPECTED_MODE: "staging" });

  assert.equal(code, 1, output);
  assert.match(output, /unsupported EXPECTED_MODE "staging"/, output);
  assert.equal(requests.length, 0, `network requests were made: ${requests.join(", ")}`);
});
