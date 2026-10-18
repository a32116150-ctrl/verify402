// Recovery + evidence-bundle tests. No framework, like the rest of the suite.
// These are OFFLINE on purpose: the contract is deterministic store/hash logic,
// and the paid path is already covered by the engine tests.
//
//   node test/recovery.test.mjs

import {
  canonicalStable, requestHash, recordSettlement, replayFor,
  evidenceBundle, IDEMPOTENCY_TTL_MS, IDEMPOTENCY_MAX_REPLAYS, sha256Hex,
} from "../src/recovery.mjs";

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log("\nrecovery contract");

check("canonicalStable sorts keys recursively and has no whitespace", () => {
  assert(canonicalStable({ b: 1, a: { d: 2, c: [3, { z: 4, y: 5 }] } }) === '{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}');
});

check("requestHash is stable across key order", () => {
  assert(requestHash("/verify", { target: "WETH", size: 1000 }) === requestHash("/verify", { size: 1000, target: "WETH" }));
});

check("requestHash differs across route or body", () => {
  assert(requestHash("/verify", { target: "WETH" }) !== requestHash("/safety", { target: "WETH" }));
  assert(requestHash("/verify", { target: "WETH" }) !== requestHash("/verify", { target: "USDC" }));
});

check("replay returns the same payload and counts replays", () => {
  const payload = { verdict: "no_edge", net: { bps: -24.7 } };
  const { responseHash } = recordSettlement("k1", payload);
  const h1 = replayFor("k1");
  const h2 = replayFor("k1");
  assert(h1 && h2, "replays should be returned");
  assert(h1.responseHash === responseHash && h2.responseHash === responseHash, "hash must match recorded");
  assert(JSON.stringify(h1.payload) === JSON.stringify(payload), "payload must be the settled verdict, unchanged");
  assert(h2.replays === 2, "replay counter must increment");
});

check("replay cap deletes the key after MAX_REPLAYS", () => {
  recordSettlement("k2", { n: 1 });
  for (let i = 0; i < IDEMPOTENCY_MAX_REPLAYS; i++) assert(replayFor("k2"), `replay ${i + 1} allowed`);
  assert(replayFor("k2") === null, "after the cap the replay must stop (charge the next call normally)");
});

check("unknown or unknown-format keys return null without throwing", () => {
  assert(replayFor("never-set") === null);
});

check("responseHash is recomputable from the stored payload by the documented recipe", () => {
  const payload = { verdict: "no_edge", cache: { hit: false, pinnedBlock: 42 }, elapsedMs: 12, evidence_bundle: { junk: true }, recovery: { replayed: false } };
  const { responseHash } = recordSettlement("k3", payload);
  const hit = replayFor("k3");
  const core = { ...hit.payload };
  delete core.evidence_bundle;
  delete core.recovery;
  delete core.elapsedMs;
  delete core.cache;
  assert(sha256Hex(canonicalStable(core)) === responseHash, "a receiver following the docs must get the same hash");
});

check("evidenceBundle has the promised fields and hashes tie out", () => {
  const payload = { verdict: "no_edge", net: { bps: -1.2 } };
  const bundle = evidenceBundle({ route: "/verify", body: { target: "WETH" }, pinnedBlock: 123, payload });
  assert(bundle.spec === "verify402/evidence-bundle@1", "spec version");
  assert(bundle.route === "/verify" && bundle.pinnedBlock === 123, "route + pinned block");
  assert(bundle.requestHash === requestHash("/verify", { target: "WETH" }), "requestHash must be recomputable");
  assert(typeof bundle.responseHash === "string" && bundle.responseHash.length === 64, "responseHash present");
  assert(typeof bundle.createdAt === "string" && bundle.createdAt.includes("T"), "timestamp present");
  assert(bundle.payment.protocol === "x402", "payment info present");
});

console.log(`\nrecovery: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
