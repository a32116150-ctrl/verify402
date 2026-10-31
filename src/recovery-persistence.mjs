// How recovery state is persisted in THIS process — one source of truth.
//
// The durable store (src/recovery-store.mjs) is optional: with
// RECOVERY_DB_PATH unset the service keeps the historical memory-only
// behaviour. Every machine-readable surface (/info, /openapi.json,
// /.well-known/verify402.json, /llms.txt) must describe the mode the process
// is actually running in, or the contract drifts from the product.
//
// server.mjs calls setDurableRecovery() once at boot, after the store has been
// opened by recovery.mjs. This module deliberately imports nothing so it stays
// cheap to import from the document builders.

let durable = false;

export function setDurableRecovery(on) {
  durable = on === true;
}

export function durableRecovery() {
  return durable;
}

// `/info` -> state_persistence, manifest -> operationalPolicies.statePersistence
export function statePersistence() {
  if (durable) {
    return {
      scope: "durable-single-instance",
      lostOnRestart: false,
      appliesTo: ["/usage"],
      warning:
        "Recovery records are journaled to a durable SQLite store (write-ahead, committed before settlement) and survive a restart or deploy: a previously settled idempotency key is replayed, not charged again. /usage counters remain process-local and reset on restart. One server process per database file: state is not shared across instances.",
    };
  }
  return {
    scope: "process-local",
    lostOnRestart: true,
    appliesTo: ["recovery", "/usage"],
    warning:
      "Recovery records and /usage counters are process-local: they live only in this process and are lost on restart or deploy. A previously settled idempotency key may be charged again, and usage counts reset. State is not shared across instances.",
  };
}

// `/info` -> recovery.doesNotGuarantee
export function recoveryDoesNotGuarantee() {
  if (durable) {
    return "Recovery is durable for the verdict record and its replay budget only, and only within one database file served by one server process. /usage counters stay process-local. It does not prove payment, refund a failed call, replay after the TTL/cap, cross instances, or help if the caller lost the key.";
  }
  return "Recovery is not a durable ledger and does not survive a restart; recovery and usage state are process-local and lost on restart/deploy, so it does not prove payment, refund a failed call, cross instances, or replay after the TTL/cap, and it cannot help if the caller lost the key.";
}

// One-line form for /llms.txt and other plain-text surfaces.
export function persistenceLine() {
  return durable
    ? "Recovery records are journaled to a durable SQLite store and survive a restart; /usage counters remain process-local."
    : "Recovery records and /usage counters are process-local and lost on restart/deploy; state is not shared across instances.";
}
