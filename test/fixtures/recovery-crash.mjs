// Crash-matrix fixture for the durable recovery store.
//
// One invocation = one process doing one step, then either printing a result or
// dying at a named durable write (VERIFY402_CRASH_AT, enforced inside
// src/recovery-store.mjs with SIGKILL). The driver restarts a fresh process
// over the same SQLite file and asks what the caller would see.
//
//   node test/fixtures/recovery-crash.mjs <scenario> <key>
//
// Scenarios: success (charge + promote), hang (staged, no charge),
//            fail (staged, definitive abandon), expire (settled, clock past TTL),
//            resume (fresh-process lookup + replay).
//
// Marker files in RECOVERY_MARKER_DIR count handler runs and charges, so the
// driver can assert "at most one" across both processes.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const recovery = await import("../../src/recovery.mjs");
const {
  recordSettlement, promoteSettlement, abandonSettlement,
  lookupRecovery, replayFor, requestHash, _setNow,
} = recovery;

const [scenario, key] = process.argv.slice(2);
const BODY = { target: "WETH", base: "USDC", size: 1000 };
const ROUTE = "/verify";
const VALID_BEFORE = Math.floor(Date.now() / 1000) + 3600;
const MARKERS = process.env.RECOVERY_MARKER_DIR || "";
const CLOCK_OFFSET = Number(process.env.RECOVERY_CLOCK_OFFSET_MS || 0);

if (CLOCK_OFFSET) _setNow(() => Date.now() + CLOCK_OFFSET);

const mark = (file) => {
  if (MARKERS) appendFileSync(join(MARKERS, file), "1\n");
};
const out = (value) => process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);

const paymentRef = {
  chainId: 84532,
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payer: "0x1111111111111111111111111111111111111111",
  nonce: "0x" + "ab".repeat(32),
  validBefore: VALID_BEFORE,
  network: "eip155:84532",
};

function stage() {
  return recordSettlement(key, { ok: true, verdict: "no_edge", chainId: 84532 }, null, {
    settledNow: false,
    requestHash: requestHash(ROUTE, BODY),
    paymentRef,
  });
}

const bodyFor = (operationId) => Buffer.from(JSON.stringify({
  ok: true, verdict: "no_edge", chainId: 84532, recovery: { operationId },
}), "utf8");

const settle = {
  ok: true,
  transaction: "0x" + "f".repeat(64),
  network: "eip155:84532",
  payer: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
};

switch (scenario) {
  case "success": {
    mark("handler.log");
    const { operationId } = stage();
    mark("charge.log");
    promoteSettlement(bodyFor(operationId), settle);
    out({ operationId });
    break;
  }
  case "hang": {
    mark("handler.log");
    const { operationId } = stage();
    out({ operationId });
    break;
  }
  case "fail": {
    mark("handler.log");
    const { operationId } = stage();
    abandonSettlement(bodyFor(operationId));
    out({ operationId });
    break;
  }
  case "expire": {
    mark("handler.log");
    const { operationId } = stage();
    mark("charge.log");
    promoteSettlement(bodyFor(operationId), settle);
    _setNow(() => Date.now() + CLOCK_OFFSET + 11 * 60 * 1000);
    const hit = replayFor(key);
    out({ operationId, hit: Boolean(hit) });
    break;
  }
  case "resume": {
    const found = lookupRecovery({ key, requestHash: requestHash(ROUTE, BODY) });
    const hit = replayFor(key);
    out({
      lookup: found
        ? { hit: Boolean(found.hit), pending: found.pending ?? null, conflict: found.conflict ?? null }
        : null,
      replay: hit ? { responseHash: hit.responseHash } : null,
    });
    break;
  }
  default:
    throw new Error(`unknown scenario: ${scenario}`);
}
