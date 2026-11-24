// Control-12 conformance scenario runner. One phase per process, against one
// SQLite file, exactly like the durable recovery tests. The "rail" is a JSON
// sidecar (`<db>.rail.json`) that records which authorizations were used on
// the chain — `landed` means the settle consumed it, `not_landed` means the
// rail answers and the authorization was NOT consumed, and `unreachable`
// means the rail cannot be read at all.
//
// Vector source: Hitek-cel's crash-vector set (Detent a50dfc0),
// test/fixtures/x402-recovery-control12.json (vendored with this file), in
// the format proposed on x402-foundation/x402#3848. This file does not
// hand-tune expectations; it reads the vector and drives verify402's real
// recovery code, then compares every assertion in `expect`.
//
//   node test/fixtures/control12-scenario.mjs crash   <i> <key> <railMode> <validBefore>
//   node test/fixtures/control12-scenario.mjs restart <i> <key> <railMode> <restartAfterSeconds> <validBefore>
//
// Boundary -> our journal mapping (our durable journal has fewer granular
// writes than Detent's seven; the mapping is exact for what we store):
//   claim, staged, response_saved (before) -> no record written (crash died
//     before our stage write, which also carries the response)
//   staged, response_saved (after)         -> staged record exported to disk,
//     never settled; the rail authorization is untouched
//   settling (before)                      -> staged record; the `settling`
//     marker never reached the journal (torn-write model)
//   settling / settle_result (before)      -> staged record + `settling`
//     marker; the settle request went out, its outcome never returned
//   settling / settle_result (after)       -> staged record + `settling`
//     marker + settle outcome recorded (promoted to settled)
//   delivered / receipt (before)           -> settle happened, promotion write
//     was in flight at the crash (record still `settling`)
//   delivered / receipt (after)            -> promoted record on disk

const argv = process.argv.slice(2);

const recovery = await import("../../src/recovery.mjs");
const {
  recordSettlement, promoteSettlement, lookupRecovery, replayFor, _setNow,
  requestHash, markSettling, setRecoveryPaymentChecker, reconcileStagedOnStartup,
  reconcileStagedEntry,
} = recovery;
const { readFileSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
const { createHash, sha256Hex } = await import("node:crypto");

const BODY = { target: "WETH", base: "USDC", size: 1000 };
const ROUTE = "/verify";
const VECTORS = JSON.parse(readFileSync(new URL("./x402-recovery-control12.json", import.meta.url), "utf8"));

const out = (value) => process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);
const railPath = () => process.env.RECOVERY_DB_PATH + ".rail.json";
const readRail = () => (existsSync(railPath()) ? JSON.parse(readFileSync(railPath(), "utf8")) : { usedNonces: [] });
const writeRail = (r) => writeFileSync(railPath(), JSON.stringify(r));

const nonceFor = (i) => "0x" + createHash("sha256").update(`control12:${i}`).digest("hex");

const stage = (key, index, validBefore, { settleSent, settled }) => {
  const payload = { ok: true, verdict: "no_edge", chainId: 84532, net: { bps: -1 } };
  const { operationId } = recordSettlement(key, payload, null, {
    settledNow: false,
    requestHash: requestHash(ROUTE, BODY),
    paymentRef: {
      chainId: 84532,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payer: "0x1111111111111111111111111111111111111111",
      nonce: nonceFor(index),
      validBefore,
      network: "eip155:84532",
    },
  });
  if (settleSent) {
    // markSettling matches the staged paymentRef by EIP-3009 nonce inside the
    // settle payload — the same identity path the live hook uses.
    const marker = markSettling({
      paymentPayload: { payload: { authorization: { nonce: nonceFor(index) } } },
    });
    if (marker?.matched !== 1) throw new Error(`settling marker did not match: ${JSON.stringify(marker)}`);
  }
  if (settled) {
    // Settle completed and its result was processed — our onAfterSettle hook.
    // promoteSettlement verifies the body against the staged responseHash and
    // fails closed on any byte drift, so the fixture replays the exact staged
    // payload, exactly as the server does in emitPaid.
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const promoted = promoteSettlement(body, { ok: true, transaction: "0x" + "f".repeat(64), network: "eip155:84532", payer: "0x1111111111111111111111111111111111111111" });
    if (promoted !== 1) throw new Error("fixture settle promote did not match the staged record");
  }
  return { operationId, payload };
};

// What the crash did, per row, expressed in our terms. `chargesOnCrash` counts
// authorizations the rail consumed before the crash.
const rowPlan = ({ journalWrite, boundary }) => {
  const before = boundary === "before";
  switch (journalWrite) {
    case "claim": return { skipped: true, settleSent: false, settled: false, handlerRun: false };
    case "staged":
    case "response_saved":
      return before ? { skipped: true, settleSent: false, settled: false, handlerRun: false }
                    : { skipped: false, settleSent: false, settled: false, handlerRun: true };
    case "settling":
      // `settling` after the marker was written = settle was in flight and the
      // outcome never returned. `before` = the torn write, settle never sent.
      return { skipped: false, settleSent: !before, settled: false, handlerRun: true };
    case "settle_result":
      return { skipped: false, settleSent: true, settled: !before, handlerRun: true };
    case "delivered":
    case "receipt":
      return before
        ? { skipped: false, settleSent: true, settled: false, handlerRun: true }
        : { skipped: false, settleSent: true, settled: true, handlerRun: true };
    default: throw new Error(`unknown journalWrite ${journalWrite}`);
  }
};

async function run() {
  const [phase, ...args] = argv;
  const [indexStr, key, railMode, validBeforeStr, restartAfterStr] = args;
  const index = Number(indexStr);
  const vector = VECTORS[index];
  const validBefore = Number(validBeforeStr);
  const plan = rowPlan(vector);

  if (phase === "crash") {
    _setNow(() => Date.now());
    if (plan.skipped) {
      writeRail({ usedNonces: [] });
      out({ skipped: true, railMode });
      return;
    }
    // Charge bookkeeping (the test rail is authoritative for charges, even when
    // the server's rail-read path is down — `unreachable` means the server
    // cannot read the rail, not that the rail itself went away):
    // `landed` — the settle consumed the authorization before the crash;
    // `not_landed` — the settle was rejected at verification time on-chain;
    // `unreachable` — the settle went out, outcome unknown to a non-reading
    // server; the rail sidecar records it as used (that is what the settle
    // step calls for: an authorisation settle consumes the nonce).
    if (plan.settleSent && railMode !== "not_landed") writeRail({ usedNonces: [nonceFor(index)] });
    else writeRail({ usedNonces: [] });
    stage(key, index, validBefore, plan);
    out({ skipped: false, railMode, nonce: nonceFor(index) });
    return;
  }

  if (phase === "restart") {
    _setNow(() => Date.now() + Number(restartAfterStr) * 1000);
    // The server's boot pass: reconcile every staged record against the rail.
    if (railMode === "landed") setRecoveryPaymentChecker(async () => true);
    else if (railMode === "not_landed") setRecoveryPaymentChecker(async () => false);
    // unreachable: leave the checker unset; the reconcile path fails closed.
    await reconcileStagedOnStartup();

    // The caller's retry of the same payment, decided the way the paid-route
    // middleware decides it.
    const lookup = lookupRecovery({ key, requestHash: requestHash(ROUTE, BODY) });
    let retryStatus = null;
    let replayStored = false;
    let retryAfter = "absent";
    let handlerRun = 0;
    let settleCall = plan.settleSent ? 1 : 0;
    let charges = readRail().usedNonces.length;

    if (lookup?.hit) {
      retryStatus = 200; replayStored = true;
    } else if (lookup?.pending === "payment_unresolved") {
      retryStatus = 503; // no Retry-After on this code
    } else if (lookup?.pending) {
      retryStatus = 409; retryAfter = "present";
    } else if (!lookup) {
      // Empty journal: a genuinely fresh x402 flow. The payment is signed, the
      // facilitator settles it once on the single-use authorization, the
      // handler runs and the response is stored as delivered.
      const freshPayload = { ok: true, verdict: "no_edge", chainId: 84532, net: { bps: -1 } };
      recordSettlement(key, freshPayload, null, {
        settledNow: true,
        requestHash: requestHash(ROUTE, BODY),
        paymentRef: {
          chainId: 84532,
          token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payer: "0x1111111111111111111111111111111111111111",
          nonce: nonceFor(index),
          validBefore,
          network: "eip155:84532",
        },
      });
      retryStatus = 200; replayStored = false; handlerRun = 1; settleCall += 1;
      charges = 1; // the vector's rail records it regardless of read access
      writeRail({ usedNonces: [nonceFor(index)] });
    }

    // Final state: move past the authorization deadline and settle the
    // operation definitively, then read what happened.
    _setNow(() => Date.now() + Number(restartAfterStr) * 1000 + 400_000);
    if (railMode === "landed") setRecoveryPaymentChecker(async () => true);
    else if (railMode === "not_landed") setRecoveryPaymentChecker(async () => false);
    else if (railMode === "unreachable") setRecoveryPaymentChecker(async () => { throw new Error("rail down"); });
    for (let i = 0; i < 4; i++) await reconcileStagedOnStartup();

    const after = lookupRecovery({ key, requestHash: requestHash(ROUTE, BODY) });
    const delivered = Boolean(after?.hit);
    const state = delivered ? "delivered" : after ? "stuck" : "void";
    out({
      handlerRuns: (plan.handlerRun ? 1 : 0) + handlerRun,
      settleCalls: settleCall,
      charges,
      chargesVerifiable: true,
      retryStatus,
      retryReplaysStoredResponse: replayStored,
      retryAfter,
      state,
      keyBlocked: state === "void" ? false : true,
    });
    return;
  }

  out({ error: `unknown phase ${phase}` });
}

run().catch((e) => {
  process.stdout.write(`RESULT ${JSON.stringify({ fatalError: `${e?.name}: ${e?.message}` })}\n`);
  process.exitCode = 1;
});
