// Recovery + evidence-bundle tests. No framework, like the rest of the suite.
//
//   node test/recovery.test.mjs
//
// v3 (post-SameDayDesk): recordSettlement STAGES; records become replayable
// only after promoteSettlement() — which server.mjs wires to the official
// x402 `onAfterSettle` hook, i.e. ONLY after the facilitator confirms the
// settle. A failed/pending settlement must never leave a free replay.

import {
  canonicalStable, requestHash, recordSettlement, promoteSettlement, replayFor,
  lookupRecovery, evidenceBundle, expiredRecoveryInfo,
  IDEMPOTENCY_TTL_MS, IDEMPOTENCY_MAX_REPLAYS, sha256Hex, _setNow,
} from "../src/recovery.mjs";

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// simulates the effective response: stage under a key, then settle-confirm via
// the bytes the caller would receive (this is exactly what the onAfterSettle
// hook does with transportContext.responseBody).
const affirm = (key, payload, companion = null) => {
  recordSettlement(key, payload, companion);                  // stage
  promoteSettlement(JSON.stringify(payload), { ok: true, transaction: "tx-1" }); // settle confirmed
};
const affirmNow = (key, payload, companion = null) => {
  const r = recordSettlement(key, payload, companion, { settledNow: true });
  return r;
};

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

// --- SameDayDesk trace, claim 1: settlement gating -------------------------

check("STAGED record is NOT replayable — a failed settlement leaves nothing free", () => {

  recordSettlement("fail-key", { verdict: "no_edge", n: 1 }, "fail-companion");
  assert(replayFor("fail-key") === null, "unpromoted key must be inert");
  assert(replayFor("fail-companion") === null, "unpromoted companion must be inert");
  assert(expiredRecoveryInfo("fail-key") === null, "nothing settled -> no tombstone");

});

check("promotion keyed on the ACTUAL response bytes unlocks the replay", () => {

  const payload = { verdict: "edge", net: { bps: 7.5 } };
  recordSettlement("ok-key", payload, "ok-companion");
  const n = promoteSettlement(JSON.stringify(payload), { ok: true, transaction: "tx-1" });  // Buffer, like the middleware
  assert(n === 1, "one operation (two aliases, one entry) promoted");
  const h = replayFor("ok-key");
  assert(h && h.payload.verdict === "edge" && h.replays === 1, "promoted entry replays");

});

check("promotion of an unrelated/mismatched body promotes nothing", () => {

  recordSettlement("mm-key", { verdict: "no_edge" });
  assert(promoteSettlement(JSON.stringify({ verdict: "no_edge", net: { bps: 999 } }), { ok: true, transaction: "tx-1" }) === 0, "bytes must match");
  assert(replayFor("mm-key") === null, "still inert");

});

check("staged entries age out silently: no tombstone, no free anything", () => {

  let T = 5_000_000;
  _setNow(() => T);
  recordSettlement("stale-staged", { verdict: "no_edge" });
  T += 5 * 60 * 1000 + 1;                                     // past IDEMPOTENCY_STAGE_TTL_MS
  replayFor("stale-staged");                                  // triggers the silent sweep
  assert(expiredRecoveryInfo("stale-staged") === null, "an unsettled verdict is not a lost verdict");
  _setNow(() => Date.now());

});

// --- replay mechanics (settled entries) -----------------------------------

check("replay returns the same payload and counts replays", () => {

  const payload = { verdict: "no_edge", net: { bps: -24.7 } };
  affirmNow("k1", payload);
  const h1 = replayFor("k1");
  const h2 = replayFor("k1");
  assert(h1 && h2, "replays should be returned");
  assert(h1.responseHash === h2.responseHash, "hash must match recorded");
  assert(JSON.stringify(h1.payload) === JSON.stringify(payload), "payload must be the settled verdict, unchanged");
  assert(h2.replays === 2, "replay counter must increment");

});

check("replay cap deletes the key after MAX_REPLAYS", () => {

  affirmNow("k2", { n: 1 });
  for (let i = 0; i < IDEMPOTENCY_MAX_REPLAYS; i++) assert(replayFor("k2"), `replay ${i + 1} allowed`);
  assert(replayFor("k2") === null, "after the cap the replay must stop (charge the next call normally)");

});

check("companion alias SHARES the operation's replay cap (3 total, not 3+3)", () => {

  affirmNow("cap-key", { verdict: "edge" }, "cap-companion");
  let reads = 0;
  while (replayFor("cap-key") !== null) reads++;
  while (replayFor("cap-companion") !== null) reads++;        // fresh-id retry path
  assert(reads === IDEMPOTENCY_MAX_REPLAYS, `one operation, one cap: reads=${reads}`);

});

check("unknown or unknown-format keys return null without throwing", () => {

  assert(replayFor("never-set") === null);

});

// --- hash projection (SameDayDesk, claim 2) -------------------------------

check("responseHash is recomputable from the RAW response bytes by the documented recipe", () => {

  // a full paid response exactly as the wire sees it (as JSON bytes)
  const body = {
    verdict: "no_edge", answer: "test-correct",
    cache: { hit: false, pinnedBlock: 42 }, elapsedMs: 12,
    evidence_bundle: { junk: true }, recovery: { remeasured: false },
  };
  const { responseHash } = recordSettlement("k3", JSON.parse(JSON.stringify(body)));
  // receiver recipe from the docs: strip the four projected keys, canonicalize, sha256
  const core = JSON.parse(JSON.stringify(body));
  delete core.evidence_bundle;
  delete core.recovery;
  delete core.elapsedMs;
  delete core.cache;
  assert(sha256Hex(canonicalStable(core)) === responseHash, "a receiver following the docs must get the same hash");

});

check("ONE projection everywhere: evidenceBundle.responseHash == recordSettlement.responseHash", () => {

  const payload = { verdict: "no_edge", net: { bps: -1.2 }, cache: { hit: false, pinnedBlock: 7 }, elapsedMs: 8 };
  const bundle = evidenceBundle({ route: "/verify", body: { target: "WETH" }, pinnedBlock: 7, payload });
  const { responseHash } = recordSettlement("k-proj", { ...payload, evidence_bundle: bundle });
  assert(bundle.responseHash === responseHash, "first response, replay and ledger must agree on one number");

});

// --- operation identity, settlement reference, scope binding ---------------
// Controls requested by NSPG13 on x402-foundation/x402#3848: output equality
// does not identify an operation, so promotion must key on the operation's own
// identity + its settlement, and a reused key under changed content or scope
// must be rejected before payment or replay.

check("CONTROL: two staged ops with byte-identical output do not cross-promote", () => {

  const bytes = { verdict: "no_match", reason: "below_threshold" };
  const a = recordSettlement("idem-op-A", { ...bytes }, null);   // staged: assigns opId_A
  const b = recordSettlement("idem-op-B", { ...bytes }, null);   // staged: assigns opId_B
  assert(a.responseHash === b.responseHash, "the two operations genuinely produce identical projections");
  assert(a.operationId !== b.operationId, "…yet they remain distinct operation identities");

  // the facilitator confirms A's settle; only A's own body is in hand
  const nA = promoteSettlement(
    JSON.stringify({ ...bytes, recovery: { operationId: a.operationId } }),
    { ok: true, transaction: "tx-A" });
  assert(nA === 1, "A is promoted by its own operation identity");
  assert(replayFor("idem-op-A") !== null, "A is replayable");
  assert(replayFor("idem-op-B") === null, "B stays inert — settling A must not promote failed/pending B");

  // B only becomes replayable on ITS own settlement
  const nB = promoteSettlement(
    JSON.stringify({ ...bytes, recovery: { operationId: b.operationId } }),
    { ok: true, transaction: "tx-B" });
  assert(nB === 1 && replayFor("idem-op-B") !== null, "B promotes only on its own settlement");

});

check("CONTROL: promotion refused unless settlement is confirmed with a transaction", () => {

  const p = { verdict: "edge", net: { bps: 3 } };
  const { operationId } = recordSettlement("idem-gate", { ...p });
  const body = JSON.stringify({ ...p, recovery: { operationId } });
  assert(promoteSettlement(body, { ok: false, transaction: "tx" }) === 0, "failed settlement promotes nothing");
  assert(promoteSettlement(body, { ok: true }) === 0, "missing transaction promotes nothing");
  assert(promoteSettlement(body, { ok: true, transaction: "" }) === 0, "empty transaction promotes nothing");
  assert(replayFor("idem-gate") === null, "still inert after three refused promotions");
  assert(promoteSettlement(body, { ok: true, transaction: "tx-gate" }) === 1, "confirmed settlement promotes");

});

check("CONTROL: promotion requires the response to name its operation identity", () => {

  recordSettlement("idem-noop", { verdict: "no_edge" });
  // a reviewable body that omits recovery.operationId cannot promote, even with a good settle
  assert(promoteSettlement(JSON.stringify({ verdict: "no_edge" }), { ok: true, transaction: "tx" }) === 0, "no operationId -> no promotion");
  assert(replayFor("idem-noop") === null, "still inert");

});

const SCOPE_A = "0xaaeef086dd4e436c69d6d0f684b4c9f43392df9cb";
const SCOPE_B = "0xbb00000000000000000000000000000000000001";

check("CONTROL: same key + changed request content is a conflict, not an answer", () => {

  const rh1 = requestHash("/verify", { target: "WETH" });
  const rh2 = requestHash("/verify", { target: "USDC" });
  const { operationId } = recordSettlement("idem-conflict", { verdict: "no_edge" }, null,
    { requestHash: rh1, scope: SCOPE_A });
  promoteSettlement(JSON.stringify({ verdict: "no_edge", recovery: { operationId } }),
    { ok: true, transaction: "tx-c", payer: SCOPE_A });

  const mismatch = lookupRecovery({ key: "idem-conflict", requestHash: rh2, scope: SCOPE_A });
  assert(mismatch?.conflict === "request_mismatch", "different content under the same key must conflict");
  assert(lookupRecovery({ key: "idem-conflict", requestHash: rh2, scope: SCOPE_A }).hit === undefined, "no replay leaks through a conflict");
  const ok = lookupRecovery({ key: "idem-conflict", requestHash: rh1, scope: SCOPE_A });
  assert(ok?.hit, "same content + same scope still replays");

});

check("CONTROL: same key under a different authorization scope is a conflict", () => {

  const rh = requestHash("/verify", { target: "WETH" });
  const { operationId } = recordSettlement("idem-scope", { verdict: "no_edge" }, null,
    { requestHash: rh, scope: SCOPE_A });
  promoteSettlement(JSON.stringify({ verdict: "no_edge", recovery: { operationId } }),
    { ok: true, transaction: "tx-s", payer: SCOPE_A });

  const other = lookupRecovery({ key: "idem-scope", requestHash: rh, scope: SCOPE_B });
  assert(other?.conflict === "scope_mismatch", "another payer must not replay this key");

});

check("CONTROL: promotion refuses a settlement whose payer does not match the scope", () => {

  const { operationId } = recordSettlement("idem-scope-gate", { verdict: "no_edge" }, null,
    { requestHash: requestHash("/verify", {}), scope: SCOPE_A });
  const body = JSON.stringify({ verdict: "no_edge", recovery: { operationId } });
  assert(promoteSettlement(body, { ok: true, transaction: "tx-x", payer: SCOPE_B }) === 0, "wrong payer must not promote");
  assert(replayFor("idem-scope-gate") === null, "still inert");
  assert(promoteSettlement(body, { ok: true, transaction: "tx-y", payer: SCOPE_A }) === 1, "right payer promotes");

});

check("CONTROL: the content companion is not a public cache — the scope must match", () => {

  const rh = requestHash("/verify", { target: "WETH" });
  const { operationId } = recordSettlement("idem-main", { verdict: "edge" }, "idem-companion",
    { requestHash: rh, scope: SCOPE_A });
  promoteSettlement(JSON.stringify({ verdict: "edge", recovery: { operationId } }),
    { ok: true, transaction: "tx-p", payer: SCOPE_A });

  // fresh caller id + equal content, but no declared scope: equal content is not permission
  assert(lookupRecovery({ key: "brand-new-id", companionKey: "idem-companion", requestHash: rh }) === null,
    "equal content alone does not establish permission");
  // a different account presenting the same content must not read this result
  assert(lookupRecovery({ key: "brand-new-id", companionKey: "idem-companion", requestHash: rh, scope: SCOPE_B }) === null,
    "another account's scope must not read this result");
  // the same caller (same scope) recovers via the companion
  const ok = lookupRecovery({ key: "brand-new-id", companionKey: "idem-companion", requestHash: rh, scope: SCOPE_A });
  assert(ok?.hit && ok.hit.payload.verdict === "edge", "the same caller recovers via the content companion");

});

// --- TTL expiry + tombstone + remeasure + companion-key behavior -----------

let T0 = 1_000_000;
_setNow(() => T0);

check("companion key replays when the caller mints a fresh id (double-keying)", () => {

  affirmNow("op-key-1", { verdict: "edge", net: { bps: 7.5 } }, "request-hash-1");
  const h = replayFor("request-hash-1");                 // fresh id would miss; companion hit
  assert(h && h.payload.verdict === "edge", "companion key must carry the verdict");
  assert(replayFor("op-key-1") !== null, "explicit key still works too");

});

check("expired verdict is typed, not silent: tombstone returns the lost hash", () => {

  affirmNow("op-key-2", { verdict: "no_edge" }, "request-hash-2");
  T0 += IDEMPOTENCY_TTL_MS + 1;                          // past the replay window
  assert(replayFor("op-key-2") === null, "past TTL there is no free replay");
  assert(replayFor("request-hash-2") === null, "past TTL there is no free replay (companion too)");
  const info = expiredRecoveryInfo("op-key-2") || expiredRecoveryInfo("request-hash-2");
  assert(info && info.previousResponseHash && info.expiredAt, "the tombstone must tell the caller what it lost");

});

check("a fresh settlement re-opens the window and clears the tombstone", () => {

  affirmNow("op-key-2", { verdict: "no_edge", n: 2 }, "request-hash-2");
  assert(expiredRecoveryInfo("op-key-2") === null, "tombstone must clear on re-settlement");
  const h = replayFor("op-key-2");
  assert(h && h.payload.n === 2, "fresh verdict is replayable again");

});

check("tombstone itself expires after REMEASURE window", () => {

  affirmNow("op-key-3", { v: 1 });
  T0 += IDEMPOTENCY_TTL_MS + 1 + (6 * 60 * 60 * 1000);   // replay window + remeasure window
  assert(expiredRecoveryInfo("op-key-3") === null, "old tombstones vanish; recovery contract has limits and says so");
  _setNow(() => Date.now());

});

// --- evidence bundle ------------------------------------------------------

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
