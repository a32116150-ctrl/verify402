import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (name.name === "node_modules") continue;
    const rel = `${dir}/${name.name}`;
    if (name.isDirectory()) out.push(...walk(rel));
    else if (/\.(mjs|js|ts)$/.test(name.name)) out.push(rel);
  }
  return out;
}

const documented = new Set(
  [...readFileSync(join(root, ".env.example"), "utf8").matchAll(/#?\s*([A-Z_][A-Z0-9_]*)\s*=/g)]
    .map((m) => m[1])
);

const used = new Set();
for (const rel of [...walk("src"), ...walk("scripts"), ...walk("mcp-bridge")]) {
  const text = readFileSync(join(root, rel), "utf8");
  for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) used.add(m[1]);
  for (const m of text.matchAll(/process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g)) used.add(m[1]);
}

const missing = [...used].filter((name) => !documented.has(name)).sort();
assert.deepEqual(missing, [], `undocumented process.env names: ${missing.join(", ")}`);
console.log(`env-example: ${used.size} used names, ${documented.size} documented names, 0 missing`);
