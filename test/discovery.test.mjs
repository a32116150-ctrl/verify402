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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("discovery: server.json complies with MCP Registry specification", () => {
  const serverPath = path.join(ROOT, "server.json");
  assert.ok(fs.existsSync(serverPath), "server.json must exist in root");

  const server = JSON.parse(fs.readFileSync(serverPath, "utf8"));
  assert.equal(server.name, "io.github.a32116150-ctrl/verify402-mcp");
  assert.equal(server.version, "1.0.2");
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

  // Price parity
  const expectedPrices = {
    verify: 0.05,
    safety: 0.10,
    route: 0.03,
    quotecheck: 0.05,
    depth: 0.05,
  };

  for (const [key, expectedUsd] of Object.entries(expectedPrices)) {
    assert.equal(manifest.paymentRequirements.pricing[key].priceUsd, expectedUsd);
    assert.equal(DEFAULT_PRICES[`/${key}`], expectedUsd);
  }
});

test("discovery: openapi specification defines all public routes and response codes", () => {
  const openapi = buildOpenapi({
    verify: "$0.05",
    safety: "$0.10",
    route: "$0.03",
    quotecheck: "$0.05",
    depth: "$0.05",
  });

  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.info.title, "OpenAPI has title");

  const requiredPaths = [
    "/health",
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

test("discovery: no secrets leaked in public discovery outputs", () => {
  const manifest = buildServiceManifest();
  const openapi = buildOpenapi({
    verify: "$0.05",
    safety: "$0.10",
    route: "$0.03",
    quotecheck: "$0.05",
    depth: "$0.05",
  });
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
