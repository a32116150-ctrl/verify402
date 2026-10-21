// C-3 claims regression: public descriptions must not overstate what was
// measured. This test fails if the removed claims reappear.
//
//   node test/claims.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bannedClaimHits, PREFLIGHT_MAX_IN_FLIGHT } from "../src/contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, "utf8");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

// Historical quotes are allowed only in the audit trail and changelog.
const ALLOWLIST = new Set(["AUDIT.md", "CHANGELOG.md"]);
const BINARY_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf", ".tgz", ".zip", ".ico", ".woff", ".woff2"]);
const tracked = execSync("git ls-files -z", { cwd: root, encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((f) => !/(^|\/)node_modules\//.test(f))
  .filter((f) => !/(^|\/)package-lock\.json$/.test(f))
  .filter((f) => !/(^|\/)skills-lock\.json$/.test(f))
  .filter((f) => !BINARY_EXT.has(f.slice(f.lastIndexOf("."))))
  .filter((f) => !ALLOWLIST.has(f));

const PUBLIC_TEXT = tracked;

// The banned list is shared with the live /info, OpenAPI, and manifest checks.


console.log("\npublic claims");

check("banned overclaims are absent from every public surface", () => {
  const hits = [];
  for (const file of PUBLIC_TEXT) {
    for (const pattern of bannedClaimHits(read(file))) hits.push(`${file}: ${pattern}`);
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
  assert.equal(PREFLIGHT_MAX_IN_FLIGHT, 8);
  assert.match(openapi, /PREFLIGHT_MAX_IN_FLIGHT/);
  assert.match(read("docs/service-manifest.md"), /concurrency cap of 8/);
});

check("recovery documentation no longer advertises a companion alias", () => {
  for (const file of ["README.md", "src/openapi.mjs", "src/manifest.mjs", "src/site/docs.html"]) {
    const text = read(file);
    assert.ok(!/double" + "-keying|companion key/i.test(text), file);
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
