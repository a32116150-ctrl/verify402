// Shared mode helpers for the three live-RPC suites.
//
// TEST_OFFLINE=1        skip tests listed as RPC-required in rpc-manifest.json.
// TEST_RPC_ONLY=1       run only those tests (used by `npm run test:rpc`).
//
// A direct `node test/quotecheck.test.mjs` runs everything, which is useful
// when debugging one suite.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const IS_OFFLINE = process.env.TEST_OFFLINE === "1";
export const IS_RPC_ONLY = process.env.TEST_RPC_ONLY === "1";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./rpc-manifest.json", import.meta.url), "utf8"));

export function rpcSetFor(fileUrl) {
  const abs = fileURLToPath(fileUrl);
  const rel = abs.startsWith(ROOT) ? abs.slice(ROOT.length) : abs;
  return new Set(manifest[rel] || []);
}

export function testMode(isRpc) {
  if (IS_OFFLINE && isRpc) return "skip-rpc";
  if (IS_RPC_ONLY && !isRpc) return "skip-offline";
  return "run";
}
