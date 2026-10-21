// C-3 claims regression: public descriptions must not overstate what was
// measured. This test fails if the removed claims reappear.
//
//   node test/claims.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, "utf8");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

const siteFiles = readdirSync(`${root}src/site`).filter((f) => f.endsWith(".html")).map((f) => `src/site/${f}`);
const docsFiles = readdirSync(`${root}docs`).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);

const PUBLIC_TEXT = [
  "README.md",
  "mcp-bridge/README.md",
  "mcp-bridge/index.mjs",
  "src/openapi.mjs",
  "src/manifest.mjs",
  "src/landing.html",
  "src/server.mjs",
  "server.json",
  ...siteFiles,
  ...docsFiles,
];

// Claims that were removed as part of C-3 / C-1. Case-insensitive.
const BANNED = [
  /honeypot test/i,
  /honeypot probe/i,
  /every venue\b/i,
  /sell probe across every venue/i,
  /double-keying/i,
  /content-hash companion key/i,
  /scope_mismatch/i,
  /shared between the caller key/i,
  /different payer/i,
];

console.log("\npublic claims");

check("banned overclaims are absent from every public surface", () => {
  const hits = [];
  for (const file of PUBLIC_TEXT) {
    const text = read(file);
    for (const re of BANNED) {
      if (re.test(text)) hits.push(`${file}: ${re}`);
    }
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

check("quote-based sellability is the current name in every surface that describes /safety", () => {
  assert.match(read("README.md"), /quote-based sellability/i);
  assert.match(read("src/openapi.mjs"), /quote-based sellability/i);
  assert.match(read("src/manifest.mjs"), /quote-based/i);
  assert.match(read("mcp-bridge/index.mjs"), /quote-based sellability/i);
  assert.match(read("src/landing.html"), /quote-based/i);
  assert.match(read("src/site/checks.html"), /quote-based/i);
  assert.match(read("src/site/mcp.html"), /quote-based/i);
  assert.match(read("docs/ai-agent-guide.md"), /quote-based/i);
});

check("the untested transfer restrictions are stated, not implied away", () => {
  for (const file of ["README.md", "src/openapi.mjs", "src/manifest.mjs"]) {
    const text = read(file);
    assert.match(text, /transfer tax|transfer restriction|blacklist/i, file);
    assert.match(text, /notChecked/i, file);
  }
});

check("chainId has no silent default in OpenAPI or the MCP bridge", () => {
  const openapi = read("src/openapi.mjs");
  const chainBlock = openapi.match(/const chainId = \{[\s\S]*?\n\};/)?.[0] ?? "";
  assert.ok(chainBlock.length > 0, "chainId schema found");
  assert.ok(!/default:\s*1/.test(chainBlock), "OpenAPI must not default chainId to 1");
  assert.match(openapi, /missing_chain/);
  const mcp = read("mcp-bridge/index.mjs");
  assert.ok(!/chainId:\s*args\.chainId\s*\?\?\s*1/.test(mcp), "MCP bridge must not default chainId to 1");
  assert.match(mcp, /REQUIRED/);
  assert.match(openapi, /kind: \{ const: "transaction" \}[\s\S]*?required: \["chainId"\]/,
    "transaction preflight schema must conditionally require chainId");
  assert.match(openapi, /concurrency of 8/);
  assert.match(read("docs/service-manifest.md"), /concurrency cap of 8/);
});

check("recovery documentation no longer advertises a companion alias", () => {
  for (const file of ["README.md", "src/openapi.mjs", "src/manifest.mjs", "src/site/docs.html"]) {
    const text = read(file);
    assert.ok(!/double-keying|companion key/i.test(text), file);
    assert.match(text, /600|10 minutes|idempotency/i, file);
  }
});

check("the public service description names transport/decode as failures, not verdicts", () => {
  const text = read("src/server.mjs");
  assert.match(text, /transport\/decode|transport.*decode/i);
  assert.match(text, /no verdict/i);
});

console.log(`\nclaims: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
