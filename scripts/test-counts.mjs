// Per-file, per-test offline/RPC classification.
//
// This is intentionally source-derived, not a hand-maintained number in a doc:
// the total per file comes from the check(...) / test(...) calls in the file,
// and the RPC subset comes from test/rpc-manifest.json. The script fails if a
// manifest name no longer exists.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, "test/rpc-manifest.json"), "utf8"));

function testFiles(dir) {
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join(dir, name));
}

const files = [...testFiles("test"), ...testFiles("mcp-bridge/test")];
const TEST_CALL_RE =
  /^\s*(?:await\s+)?(?:check|checkAsync|test)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gm;

function declaredTests(source) {
  return [...source.matchAll(TEST_CALL_RE)].map((m) => m[1] ?? m[2] ?? m[3]);
}

let total = 0;
let totalOffline = 0;
let totalRpc = 0;
let bad = false;

console.log("file\ttests\toffline\trpc");
for (const rel of files) {
  const source = readFileSync(join(ROOT, rel), "utf8");
  let names = declaredTests(source);
  // `usage.test.mjs` is a single script with a literal total rather than one
  // check() call per assertion. Read that declared total instead of treating
  // the file as one test.
  if (!names.length) {
    const m = source.match(/\busage:\s*(\d+)\s+passed/);
    if (m) names = Array.from({ length: Number(m[1]) }, (_, i) => `usage-check-${i + 1}`);
  }
  const rpcNames = manifest[rel] || [];
  const missing = rpcNames.filter((name) => !names.includes(name));
  if (missing.length) {
    bad = true;
    console.error(`\n${rel}: manifest names not found: ${missing.map((n) => JSON.stringify(n)).join(", ")}`);
  }
  const rpc = rpcNames.length;
  const offline = names.length - rpc;
  total += names.length;
  totalOffline += offline;
  totalRpc += rpc;
  console.log(`${rel}\t${names.length}\t${offline}\t${rpc}`);
}

console.log(`${"\u2500".repeat(20)}`);
console.log(`TOTAL\t${total}\t${totalOffline}\t${totalRpc}`);
console.log(`\nRPC-required tests (${totalRpc}):`);
for (const [rel, names] of Object.entries(manifest)) {
  if (!names.length) continue;
  console.log(`\n${rel}`);
  for (const name of names) console.log(`  - ${name}`);
}

if (bad) process.exit(1);
