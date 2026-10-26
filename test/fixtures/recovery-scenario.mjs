// Scenario runner for the durable recovery store tests.
//
// Each invocation runs ONE scenario in a FRESH process against ONE SQLite file
// (RECOVERY_DB_PATH), which is how a real restart is simulated: recovery.mjs
// boots from the database in its module bootstrap, exactly like the server.
// The driver (test/recovery-durable.test.mjs) spawns this fixture with a
// scenario name + args and asserts on the printed JSON (last stdout line).
//
//   node test/fixtures/recovery-scenario.mjs <scenario> [...args]
//
// Scenarios:
//   stage-settled <key>            stage + promote (facilitator result) -> { opId, responseHash }
//   stage-only <key> <validBefore> stage with paymentRef, never promoted -> { opId }
//   lookup <key> <route> <bodyJson> fresh-process lookup -> { result }
//   replay <key>                   fresh-process replayFor -> { hit }
//   tombstone <key>                fresh-process expiredRecoveryInfo -> { info }
//   set-now <msOffset> <fn>...     advance the injected clock, then run `replay <key>` / `tombstone <key>`
//   reconcile <key> <opId> <mode>  inject checker (consumed|unconsumed|error),
//                                  reconcile the staged op -> { r, lookup }
//   health                         -> recoveryStoreHealth + whether stage throws

const [scenario, ...args] = process.argv.slice(2);

const recovery = await import("../../src/recovery.mjs");
const {
  recordSettlement, promoteSettlement, lookupRecovery, replayFor,
  expiredRecoveryInfo, requestHash, _setNow, recoveryStoreHealth,
  setRecoveryPaymentChecker, reconcileStagedEntry,
} = recovery;

function out(value) {
  process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);
}

const BODY = { target: "WETH", base: "USDC", size: 1000 };
const ROUTE = "/verify";

const stage = (key, { validBefore = null, settledNow = false } = {}) => {
  const payload = { ok: true, verdict: "no_edge", chainId: 84532 };
  const { responseHash, operationId } = recordSettlement(key, payload, null, {
    settledNow,
    requestHash: requestHash(ROUTE, BODY),
    paymentRef: validBefore === null ? null : {
      chainId: 84532,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payer: "0x1111111111111111111111111111111111111111",
      nonce: `0x${"ab".repeat(32)}`,
      validBefore,
      network: "eip155:84532",
    },
  });
  return { responseHash, operationId, payload };
};

try {
  switch (scenario) {
    case "stage-settled": {
      const [key] = args;
      const { responseHash, operationId } = stage(key, { settledNow: false });
      // Promote with a facilitator-shaped settle result through the same hook
      // path the x402 onAfterSettle hook uses (body buffer + settlement).
      const body = Buffer.from(JSON.stringify({
        ok: true, verdict: "no_edge", chainId: 84532,
        recovery: { operationId },
      }), "utf8");
      const promoted = promoteSettlement(body, {
        ok: true, transaction: "0x" + "f".repeat(64), network: "eip155:84532", payer: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
      });
      out({ opId: operationId, promoted, responseHash });
      break;
    }
    case "stage-only": {
      const [key, validBefore] = args;
      const { operationId } = stage(key, { validBefore: Number(validBefore) });
      out({ opId: operationId });
      break;
    }
    case "lookup": {
      const [key, route, bodyJson] = args;
      const found = lookupRecovery({ key, requestHash: requestHash(route, JSON.parse(bodyJson)) });
      out({ result: found ?? null });
      break;
    }
    case "replay": {
      const [key] = args;
      const hit = replayFor(key);
      out({ hit: hit ?? null });
      break;
    }
    case "tombstone": {
      const [key] = args;
      out({ info: expiredRecoveryInfo(key) });
      break;
    }
    case "set-now": {
      const [msOffset, next, key] = args;
      const offset = Number(msOffset);
      _setNow(() => Date.now() + offset);
      if (next === "replay") {
        out({ hit: replayFor(key) ?? null });
      } else if (next === "tombstone") {
        out({ info: expiredRecoveryInfo(key) });
      } else if (next === "lookup") {
        const found = lookupRecovery({ key, requestHash: requestHash(ROUTE, BODY) });
        out({ result: found ?? null });
      } else {
        out({ error: `unknown set-now target ${next}` });
      }
      break;
    }
    case "reconcile": {
      const [key, opId, mode] = args;
      if (mode === "consumed") {
        setRecoveryPaymentChecker(async () => true);
      } else if (mode === "unconsumed") {
        setRecoveryPaymentChecker(async () => false);
      } else if (mode === "error") {
        setRecoveryPaymentChecker(async () => { throw new Error("rpc down"); });
      } else if (mode === "absent") {
        // no checker wired at all
      }
      const r = await reconcileStagedEntry(opId);
      const found = lookupRecovery({ key, requestHash: requestHash(ROUTE, BODY) });
      out({ r, lookup: found ?? null });
      break;
    }
    case "health": {
      const [key] = args;
      let threw = null;
      try {
        stage(key ?? "health-key", { settledNow: false });
      } catch (e) {
        threw = { name: e.name, code: e.code };
      }
      out({ health: recoveryStoreHealth(), threw });
      break;
    }
    case "stage-and-hold": {
      // Stage, print the marker, then stay alive until the driver SIGKILLs the
      // process — proving the committed row survives an abrupt death.
      const [key, validBefore] = args;
      const { operationId } = stage(key, { validBefore: Number(validBefore) });
      process.stdout.write(`HOLDING ${operationId}\n`);
      setInterval(() => {}, 1 << 30);
      break;
    }
    default:
      out({ error: `unknown scenario ${scenario}` });
      process.exitCode = 2;
  }
} catch (e) {
  out({ fatalError: `${e?.name}: ${e?.message}` });
  process.exitCode = 1;
}
