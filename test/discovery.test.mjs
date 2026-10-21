// test/discovery.test.mjs
// Validates machine-readable discovery specifications, manifests, schemas,
// cross-component price parity, and HTTP discovery endpoints.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenapi } from "../src/openapi.mjs";
import { buildServiceManifest } from "../src/manifest.mjs";
import { DEFAULT_PRICES } from "../mcp-bridge/budget.mjs";
import {
  PRICE_DEFAULTS,
  PREFLIGHT_RATE_PER_MIN,
  PREFLIGHT_MAX_IN_FLIGHT,
  HEALTH_OK_KEYS,
  READY_OK_KEYS,
  READY_FAILURE_KEYS,
  bannedClaimHits,
} from "../src/contract.mjs";
import { IDEMPOTENCY_MAX_REPLAYS, IDEMPOTENCY_TTL_MS } from "../src/recovery.mjs";
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../src/preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("discovery: server.json complies with MCP Registry specification", () => {
  const serverPath = path.join(ROOT, "server.json");
  assert.ok(fs.existsSync(serverPath), "server.json must exist in root");

  const server = JSON.parse(fs.readFileSync(serverPath, "utf8"));
  assert.equal(server.name, "io.github.a32116150-ctrl/verify402-mcp");
  assert.equal(server.version, "1.0.3");
  assert.ok(server.description.length <= 100, `description length ${server.description.length} must be <= 100 chars`);
  assert.equal(server.websiteUrl, "https://verify402.onrender.com");
  assert.ok(Array.isArray(server.packages) && server.packages.length > 0);
  assert.equal(server.packages[0].transport.type, "stdio");

  const mcpPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp-bridge", "package.json"), "utf8"));
  assert.equal(mcpPkg.mcpName, server.name, "mcp-bridge package.json mcpName must match server.json");
  assert.equal(mcpPkg.version, server.version, "mcp-bridge package.json version must match server.json");
});

test("discovery: canonical service manifest matches implemented tools and runtime pricing", () => {
  const manifest = buildServiceManifest();

  assert.equal(manifest.name, "verify402");
  assert.equal(manifest.schemaVersion, "1.0.0");
  assert.equal(manifest.canonicalUrl, "https://verify402.onrender.com");

  const tools = manifest.integrations.mcp.tools;
  assert.equal(tools.length, 6, "Must advertise exactly 6 MCP tools");

  const freeTools = tools.filter((t) => t.type === "free");
  assert.equal(freeTools.length, 1);
  assert.equal(freeTools[0].name, "preflight_gate");

  const paidTools = tools.filter((t) => t.type === "paid");
  assert.equal(paidTools.length, 5);

  const toolNames = new Set(tools.map((t) => t.name));
  const expectedTools = [
    "preflight_gate",
    "verify_arbitrage",
    "check_token_safety",
    "get_best_route",
    "verify_quote_fairness",
    "get_trade_depth",
  ];
  for (const expected of expectedTools) {
    assert.ok(toolNames.has(expected), `Manifest must include tool ${expected}`);
  }

  // Price parity comes from the same defaults the server and manifest use.
  const expectedPrices = Object.fromEntries(
    Object.entries(PRICE_DEFAULTS).map(([key, value]) => [key, Number(value.replace(/^\$/, ""))])
  );

  for (const [key, expectedUsd] of Object.entries(expectedPrices)) {
    assert.equal(manifest.paymentRequirements.pricing[key].priceUsd, expectedUsd);
    assert.equal(DEFAULT_PRICES[`/${key}`], expectedUsd);
  }
});

test("discovery: openapi specification defines all public routes and response codes", () => {
  const openapi = buildOpenapi(PRICE_DEFAULTS);

  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.info.title, "OpenAPI has title");

  const requiredPaths = [
    "/health",
    "/ready",
    "/info",
    "/findings",
    "/.well-known/verify402.json",
    "/.well-known/x402",
    "/llms.txt",
    "/sitemap.xml",
    "/preflight",
    "/preflight/verify",
    "/verify",
    "/safety",
    "/route",
    "/quotecheck",
    "/depth",
  ];

  for (const p of requiredPaths) {
    assert.ok(openapi.paths[p], `OpenAPI must describe path ${p}`);
  }

  // Paid routes must declare 402, 400, 409, 429, 503 and x-idempotency-key
  const paidRoutes = ["/verify", "/safety", "/route", "/quotecheck", "/depth"];
  for (const r of paidRoutes) {
    const postOp = openapi.paths[r].post;
    assert.ok(postOp.responses["200"], `${r} must describe 200 response`);
    assert.ok(postOp.responses["400"], `${r} must describe 400 response`);
    assert.ok(postOp.responses["402"], `${r} must describe 402 response`);
    assert.ok(postOp.responses["409"], `${r} must describe 409 response`);
    assert.ok(postOp.responses["429"], `${r} must describe 429 response`);
    assert.ok(postOp.responses["503"], `${r} must describe 503 response`);

    const paramNames = postOp.parameters.map((p) => p.name);
    assert.ok(paramNames.includes("x-idempotency-key"), `${r} must document x-idempotency-key`);
    assert.ok(paramNames.includes("x-payment"), `${r} must document x-payment header`);
  }
});

test("discovery: manifest and OpenAPI derive TTL, limits, prices, and health shapes from shared sources", () => {
  const manifest = buildServiceManifest();
  const openapi = buildOpenapi(PRICE_DEFAULTS);
  const ttlSeconds = IDEMPOTENCY_TTL_MS / 1000;

  assert.equal(manifest.operationalPolicies.receipts.defaultTtlSeconds, DEFAULT_TTL_SECONDS);
  assert.equal(manifest.operationalPolicies.receipts.rangeSeconds, `${MIN_TTL_SECONDS}-${MAX_TTL_SECONDS}`);
  assert.match(manifest.operationalPolicies.idempotency.description, new RegExp(`${ttlSeconds}s`));
  assert.match(manifest.operationalPolicies.idempotency.description, new RegExp(`max ${IDEMPOTENCY_MAX_REPLAYS} replays`));

  const idem = openapi.paths["/verify"].post.parameters.find((p) => p.name === "x-idempotency-key");
  assert.match(idem.description, new RegExp(`${ttlSeconds}s`));
  assert.match(idem.description, new RegExp(`up to ${IDEMPOTENCY_MAX_REPLAYS} times`));

  assert.match(manifest.operationalPolicies.rateLimits.preflight, new RegExp(`${PREFLIGHT_RATE_PER_MIN} requests/minute`));
  assert.match(manifest.operationalPolicies.rateLimits.preflight, new RegExp(`max concurrency ${PREFLIGHT_MAX_IN_FLIGHT}`));
  assert.match(openapi.paths["/preflight"].post.description, new RegExp(`max concurrency of ${PREFLIGHT_MAX_IN_FLIGHT}`));

  for (const route of ["verify", "safety", "route", "quotecheck", "depth"]) {
    const amount = PRICE_DEFAULTS[route].replace(/^\$/, "");
    assert.equal(manifest.paymentRequirements.pricing[route].priceUsd, Number(amount));
    assert.equal(openapi.paths[`/${route}`].post["x-payment-info"].price.amount, amount);
  }

  const healthSchema = openapi.paths["/health"].get.responses[200].content["application/json"].schema;
  assert.deepEqual([...healthSchema.required].sort(), [...HEALTH_OK_KEYS].sort());
  assert.deepEqual([...manifest.operationalPolicies.endpoints.health.fields].sort(), [...HEALTH_OK_KEYS].sort());
  const readySchema = openapi.paths["/ready"].get.responses[200].content["application/json"].schema;
  const readyFailSchema = openapi.paths["/ready"].get.responses[503].content["application/json"].schema;
  assert.deepEqual([...readySchema.required].sort(), [...READY_OK_KEYS].sort());
  assert.deepEqual([...readyFailSchema.required].sort(), [...READY_FAILURE_KEYS].sort());
  assert.deepEqual([...manifest.operationalPolicies.endpoints.ready.successFields].sort(), [...READY_OK_KEYS].sort());
  assert.deepEqual([...manifest.operationalPolicies.endpoints.ready.failureFields].sort(), [...READY_FAILURE_KEYS].sort());

  assert.deepEqual(bannedClaimHits(JSON.stringify({ manifest, openapi })), []);
});

test("discovery: no secrets leaked in public discovery outputs", () => {
  const manifest = buildServiceManifest();
  const openapi = buildOpenapi(PRICE_DEFAULTS);
  const serverJson = JSON.parse(fs.readFileSync(path.join(ROOT, "server.json"), "utf8"));

  const jsonBlobs = [JSON.stringify(manifest), JSON.stringify(openapi), JSON.stringify(serverJson)];

  const forbidden = [
    /0x[0-9a-fA-F]{64}/g, // private key
    /CDP_API_KEY_SECRET/g,
    /["']?[A-Za-z0-9+/]{43,}=?["']?/g, // base64 secrets
  ];

  for (const blob of jsonBlobs) {
    assert.doesNotMatch(blob, /0x[0-9a-fA-F]{64}/);
    assert.doesNotMatch(blob, /CDP_API_KEY_SECRET/);
  }
});

test("discovery: the published MCP package includes every local runtime import", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp-bridge/package.json"), "utf8"));
  const shipped = new Set(pkg.files || []);
  const pending = [...shipped].filter((name) => name.endsWith(".mjs"));
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = fs.readFileSync(path.join(ROOT, "mcp-bridge", name), "utf8");
    for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
      const dependency = match[1];
      assert.ok(shipped.has(dependency), `${name} imports ${dependency}, but package.json files omits it`);
      if (!seen.has(dependency)) pending.push(dependency);
    }
  }
});

test("discovery: google site verification meta tag and file are present for Search Console", () => {
  const token = "iGmI2QL110IkjnW0thU3DRZrdgQe_7mZsPWgkZVte7o";
  const expectedTag = `<meta name="google-site-verification" content="${token}">`;

  const htmlFiles = [
    path.join(ROOT, "src", "landing.html"),
    path.join(ROOT, "src", "site", "start.html"),
    path.join(ROOT, "src", "site", "checks.html"),
    path.join(ROOT, "src", "site", "preflight.html"),
    path.join(ROOT, "src", "site", "live.html"),
    path.join(ROOT, "src", "site", "proof.html"),
    path.join(ROOT, "src", "site", "docs.html"),
    path.join(ROOT, "src", "site", "donate.html"),
    path.join(ROOT, "src", "site", "mcp.html"),
  ];

  for (const f of htmlFiles) {
    assert.ok(fs.existsSync(f), `HTML file ${f} must exist`);
    const content = fs.readFileSync(f, "utf8");
    assert.ok(content.includes(expectedTag), `${path.basename(f)} must contain Google site verification tag`);
  }

  for (const t of [token, "f4013a8965ac9859"]) {
    const vf = path.join(ROOT, "src", "site", `google${t}.html`);
    assert.ok(fs.existsSync(vf), `Google verification file google${t}.html must exist`);
    const fc = fs.readFileSync(vf, "utf8");
    assert.ok(fc.includes(`google-site-verification: google${t}.html`));
  }
});

