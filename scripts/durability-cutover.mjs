// Durable-recovery cutover check.
//
//   node scripts/durability-cutover.mjs
//   VERIFY402_URL=https://verify402.onrender.com node scripts/durability-cutover.mjs
//
// Answers one question, from the outside: is the deployed process journaling
// paid settlements to a durable store, or is it still memory-only?
//
// Exit 0  -> durable (a restart replays a settled idempotency key, no second charge)
// Exit 1  -> memory-only, or the check itself failed
//
// It is deliberately read-only. It never deploys, never changes an env var, and
// never touches a wallet. The cutover itself is a dashboard action because it
// needs a paid instance and a disk (see DEPLOY.md 3.1/3.2).

const BASE = (process.env.VERIFY402_URL || process.env.SMOKE_BASE_URL || "https://verify402.onrender.com").replace(/\/+$/, "");
const TIMEOUT_MS = 20_000;

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

function line(label, value) {
  console.log(`  ${label.padEnd(18)} ${value}`);
}

let health;
let info;
try {
  health = await getJson("/health");
  info = await getJson("/info");
} catch (e) {
  console.error(`durability: could not read ${BASE}: ${e.message}`);
  process.exit(1);
}

const store = health.recoveryStore;
const persistence = info?.state_persistence ?? info?.operationalPolicies?.statePersistence ?? info?.statePersistence ?? null;
const durable = store === "ok" || persistence?.lostOnRestart === false;

console.log(`\nverify402 durability check — ${BASE}\n`);
line("version", info?.version ?? "unknown");
line("mode", health.mode ?? info?.mode ?? "unknown");
line("recoveryStore", store ?? "unknown");
line("statePersistence", persistence?.scope ?? "unreported");
line("lostOnRestart", persistence?.lostOnRestart ?? "unreported");

if (durable) {
  console.log("\nPASS: settlement recovery is durable. A restart replays a settled");
  console.log("idempotency key instead of charging the caller again.\n");
  process.exit(0);
}

console.log("\nFAIL: settlement recovery is memory-only. A retried paid call after a");
console.log("restart or deploy can be charged twice. The product says so on /health;\n");
console.log("this script exists so it is not discovered by a buyer first.\n");
console.log("Cutover (one-time, needs the paid instance + a disk):\n");
console.log("  1. Render dashboard -> the verify402 service -> Settings -> Instance Type:");
console.log("     move off Free to Starter (free instances cannot attach disks and");
console.log("     spin down, which loses in-memory recovery by definition).");
console.log("  2. Add a Disk: name recovery, mount path /var/data, size 1 GB");
console.log("     ($0.25/GB/mo). One service instance only — SQLite is single-writer.");
console.log("  3. Add env var RECOVERY_DB_PATH=/var/data/recovery/recovery.sqlite");
console.log("     (Render creates the directory; do not point it at a dev path).");
console.log("  4. Deploy, then re-run: npm run check:durability");
console.log("     Expect: recoveryStore ok, statePersistence durable-single-instance.");
console.log("  5. Confirm one paid retry replays with no second settlement.\n");
console.log("Reference: DEPLOY.md sections 3.1 and 3.2. Until this passes, keep the");
console.log("service labelled testnet; mainnet mode refuses to boot without a store.\n");
process.exit(1);
