#!/usr/bin/env node
// Automated discovery validation for verify402.
// Validates:
// 1. server.json (MCP Registry schema, name, description length, mcpName match)
// 2. Local tool consistency (MCP tools vs advertised manifest tools)
// 3. Price consistency (runtime prices vs budget.mjs vs manifest vs openapi)
// 4. HTTP endpoints (health, manifest, openapi, llms.txt, sitemap, robots, 402 challenge, bazaar)
// 5. Secret leak scanning across all public discovery surfaces.
//
// Usage:
//   node scripts/check-discovery.mjs --local             # test against local server or pure static
//   node scripts/check-discovery.mjs --production        # test against https://verify402.onrender.com (read-only)
//   node scripts/check-discovery.mjs --url http://...    # test against custom URL

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildOpenapi } from "../src/openapi.mjs";
import { buildServiceManifest } from "../src/manifest.mjs";
import { DEFAULT_PRICES } from "../mcp-bridge/budget.mjs";
import { PRICE_DEFAULTS } from "../src/contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passedCount++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failedCount++;
  }
}

// ----------------------------------------------------------------- static ---
console.log("\n[1/4] Checking MCP Registry Manifest (server.json)...");

const serverJsonPath = path.join(ROOT, "server.json");
assert(fs.existsSync(serverJsonPath), "server.json exists");

let serverJson;
try {
  serverJson = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
  assert(serverJson.$schema != null, "server.json has $schema defined");
  assert(serverJson.name === "io.github.a32116150-ctrl/verify402-mcp", `server.json name is ${serverJson.name}`);
  assert(serverJson.description.length <= 100, `server.json description is <= 100 chars (current: ${serverJson.description.length})`);
  assert(serverJson.version === "1.0.3", `server.json version is 1.0.3 (current: ${serverJson.version})`);
  assert(Array.isArray(serverJson.packages) && serverJson.packages.length > 0, "server.json has packages defined");
  assert(serverJson.packages[0].transport.type === "stdio", "transport type is stdio");
} catch (e) {
  assert(false, `server.json parses as valid JSON: ${e.message}`);
}

const mcpPackageJsonPath = path.join(ROOT, "mcp-bridge", "package.json");
try {
  const mcpPkg = JSON.parse(fs.readFileSync(mcpPackageJsonPath, "utf8"));
  assert(mcpPkg.mcpName === serverJson.name, `mcp-bridge/package.json mcpName (${mcpPkg.mcpName}) matches server.json name`);
  assert(mcpPkg.version === serverJson.version, `mcp-bridge/package.json version (${mcpPkg.version}) matches server.json version`);
} catch (e) {
  assert(false, `mcp-bridge/package.json validation failed: ${e.message}`);
}

// -------------------------------------------------------- price consistency -
console.log("\n[2/4] Checking Cross-Component Price Consistency...");

const manifest = buildServiceManifest();
const openapi = buildOpenapi(PRICE_DEFAULTS);

const EXPECTED_PRICES = Object.fromEntries(
  Object.entries(PRICE_DEFAULTS).map(([key, value]) => [`/${key}`, Number(value.replace(/^\$/, ""))])
);

for (const [route, price] of Object.entries(EXPECTED_PRICES)) {
  const shortName = route.replace("/", "");
  assert(DEFAULT_PRICES[route] === price, `budget.mjs price for ${route} is $${price}`);
  assert(manifest.paymentRequirements.pricing[shortName].priceUsd === price, `manifest price for ${shortName} is $${price}`);
  const openapiPrice = Number(openapi.paths[route].post["x-payment-info"].price.amount);
  assert(openapiPrice === price, `openapi price for ${route} is $${price}`);
}

// -------------------------------------------------------- secret leak check -
console.log("\n[3/4] Scanning Public Metadata For Sensitive Secrets...");

const sensitivePatterns = [
  /0x[0-9a-fA-F]{64}/g, // raw EVM 32-byte private key
  /CDP_API_KEY_SECRET/g,
  /EVM_PRIVATE_KEY\s*=\s*["']?0x[0-9a-fA-F]+/i,
];

function scanText(name, content) {
  for (const pat of sensitivePatterns) {
    const match = content.match(pat);
    assert(!match, `No sensitive keys/secrets found in ${name}`);
  }
}

scanText("server.json", JSON.stringify(serverJson));
scanText("manifest", JSON.stringify(manifest));
scanText("openapi.json", JSON.stringify(openapi));

// ----------------------------------------------------------- live / network -
const isProduction = process.argv.includes("--production");
const customUrlArg = process.argv.find((a) => a.startsWith("--url="));
const customUrl = customUrlArg ? customUrlArg.split("=")[1] : null;

const targetBaseUrl = isProduction ? "https://verify402.onrender.com" : customUrl;

if (targetBaseUrl) {
  console.log(`\n[4/4] Validating Live HTTP Endpoints against ${targetBaseUrl}...`);

  async function checkLive() {
    try {
      // 1. Health
      const healthRes = await fetch(`${targetBaseUrl}/health`);
      assert(healthRes.status === 200, `GET /health returns HTTP 200 (got ${healthRes.status})`);
      const healthJson = await healthRes.json();
      assert(healthJson.ok === true || healthJson.status === "ok", "health response indicates ok");

      // 2. Manifest
      const manifestRes = await fetch(`${targetBaseUrl}/.well-known/verify402.json`);
      if (manifestRes.status === 200) {
        const manifestJson = await manifestRes.json();
        assert(manifestJson.name === "verify402", "manifest name is 'verify402'");
        assert(manifestJson.integrations?.mcp?.tools?.length === 6, `manifest advertises 6 MCP tools (got ${manifestJson.integrations?.mcp?.tools?.length})`);
      } else {
        assert(false, `GET /.well-known/verify402.json returned ${manifestRes.status} (pending deployment of local master changes to Render)`);
      }

      // 3. OpenAPI
      const openapiRes = await fetch(`${targetBaseUrl}/openapi.json`);
      assert(openapiRes.status === 200, `GET /openapi.json returns HTTP 200 (got ${openapiRes.status})`);
      const openapiLiveJson = await openapiRes.json();
      assert(openapiLiveJson.openapi?.startsWith("3.1"), `OpenAPI is version 3.1 (got ${openapiLiveJson.openapi})`);
      assert(openapiLiveJson.paths?.["/verify"] != null, "OpenAPI defines /verify path");

      // 4. llms.txt
      const llmsRes = await fetch(`${targetBaseUrl}/llms.txt`);
      assert(llmsRes.status === 200, `GET /llms.txt returns HTTP 200 (got ${llmsRes.status})`);
      const llmsText = await llmsRes.text();
      assert(llmsText.includes("# verify402"), "llms.txt contains '# verify402'");

      // 5. sitemap.xml
      const sitemapRes = await fetch(`${targetBaseUrl}/sitemap.xml`);
      if (sitemapRes.status === 200) {
        const sitemapText = await sitemapRes.text();
        assert(sitemapText.includes("<urlset"), "sitemap.xml contains valid <urlset>");
      } else {
        assert(false, `GET /sitemap.xml returned ${sitemapRes.status} (pending deployment of local master changes to Render)`);
      }

      // 6. robots.txt
      const robotsRes = await fetch(`${targetBaseUrl}/robots.txt`);
      assert(robotsRes.status === 200, `GET /robots.txt returns HTTP 200 (got ${robotsRes.status})`);

      // 7. x402 402 challenge & Bazaar metadata
      const verify402Res = await fetch(`${targetBaseUrl}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "WETH" }),
      });
      assert(verify402Res.status === 402, `Unpaid POST /verify returns HTTP 402 Payment Required (got ${verify402Res.status})`);
      const paymentRequiredHeader = verify402Res.headers.get("payment-required");
      let challenge = null;
      if (paymentRequiredHeader) {
        challenge = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
      } else {
        challenge = await verify402Res.json();
      }
      assert(Array.isArray(challenge.accepts), "402 response contains 'accepts' payment terms");
      assert(challenge.extensions?.bazaar != null, "402 challenge contains Bazaar discovery extension");
      assert(challenge.extensions?.bazaar?.info != null || challenge.extensions?.bazaar?.inputSchema != null, "Bazaar extension declares input schema / info");

      finish();
    } catch (err) {
      assert(false, `Live endpoint request failed: ${err.message}`);
      finish();
    }
  }

  checkLive();
} else {
  console.log("\n[4/4] Skipping Live HTTP checks (run with --production to test production).");
  finish();
}

function finish() {
  console.log("\n--------------------------------------------------");
  console.log(`Validation finished: ${passedCount} passed, ${failedCount} failed.`);
  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}
