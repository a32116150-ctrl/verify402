// Recovery + evidence-bundle tests. No framework, like the rest of the suite.
// These are OFFLINE on purpose: the contract is deterministic store/hash logic,
// and the paid path is already covered by the engine tests.
//
//   node test/recovery.test.mjs

import {
  canonicalStable, requestHash, recordSettlement, replayFor,
  evidenceBundle, expiredRecoveryInfo, IDEMPOTENCY_TTL_MS, IDEMPOTENCY_MAX_REPLAYS,
  sha256Hex, _setNow,
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

// TTL expiry + tombstone + remeasure + companion-key behavior
let T0 = 1_000_000;
_setNow(() => T0);
check("companion key replays when the caller mints a fresh id (double-keying)", () => {
  const payload = { verdict: "edge", net: { bps: 7.5 } };
  recordSettlement("op-key-1", payload, "request-hash-1");
  const h = replayFor("request-hash-1");                 // fresh id would miss; companion hit
  assert(h && h.payload.verdict === "edge", "companion key must carry the verdict");
  assert(replayFor("op-key-1") !== null, "explicit key still works too");
});

check("expired verdict is typed, not silent: tombstone returns the lost hash", () => {
  recordSettlement("op-key-2", { verdict: "no_edge" }, "request-hash-2");
  T0 += IDEMPOTENCY_TTL_MS + 1;                          // past the replay window
  assert(replayFor("op-key-2") === null, "past TTL there is no free replay");
  assert(replayFor("request-hash-2") === null, "past TTL there is no free replay (companion too)");
  const info = expiredRecoveryInfo("op-key-2") || expiredRecoveryInfo("request-hash-2");
  assert(info && info.previousResponseHash && info.expiredAt, "the tombstone must tell the caller what it lost");
});

check("a fresh settlement re-opens the window and clears the tombstone", () => {
  const { responseHash: freshHash } = recordSettlement("op-key-2", { verdict: "no_edge", n: 2 }, "request-hash-2");
  assert(expiredRecoveryInfo("op-key-2") === null, "tombstone must clear on re-settlement");
  const h = replayFor("op-key-2");
  assert(h && h.payload.n === 2, "fresh verdict is replayable again");
});

check("tombstone itself expires after REMEASURE window", () => {
  recordSettlement("op-key-3", { v: 1 });
  T0 += IDEMPOTENCY_TTL_MS + 1 + (6 * 60 * 60 * 1000);   // replay window + remeasure window
  assert(expiredRecoveryInfo("op-key-3") === null, "old tombstones vanish; recovery contract has limits and says so");
  _setNow(() => Date.now());
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
