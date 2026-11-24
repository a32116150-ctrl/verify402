// Proves TEST_OFFLINE=1 is a real switch: one closed endpoint, no public
// fallback. This test is intentionally offline and uses no chain access.

import assert from "node:assert/strict";
import { clientFor } from "../src/measure.mjs";

process.env.TEST_OFFLINE = "1";
process.env.TEST_OFFLINE_RPC_URL = "http://127.0.0.1:1/offline-rpc";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ${name} ... PASS`);
  } catch (e) {
    failed++;
    console.log(`  ${name} ... FAIL\n      ${e.message}`);
  }
}

console.log("\noffline mode");

await check("TEST_OFFLINE=1 uses one closed endpoint with no public fallback", async () => {
  const client = clientFor(1);
  assert.equal(client.transport.url, "http://127.0.0.1:1/offline-rpc");
  assert.ok(!/llamarpc|drpc|merkle|publicnode|base\.org/.test(client.transport.url));
  await assert.rejects(() => client.getBlockNumber());
});

console.log(`\noffline-mode: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
