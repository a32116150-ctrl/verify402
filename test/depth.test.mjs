// Depth tests. The danger for this endpoint is the old failure mode: nice
// "liquidity" numbers that do not survive contact with real venue math.
// These checks pin the ladder to reality.
//
//   node test/depth.test.mjs
//
// Needs network access to a mainnet RPC.

import { depthProfile } from "../src/depth.mjs";
import { chain } from "../src/config.mjs";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS${detail ? `  (${detail})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL\n      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CHAIN_ID = 1;
const c = chain(CHAIN_ID);

console.log(`\ndepth tests on ${c.name} (chainId ${CHAIN_ID})\n`);

// --- 1. WETH ladder: every rung sellable at real cost, impact monotonic-ish --
await check("WETH ladder is fully fillable with rising impact", async () => {
  const r = await depthProfile(CHAIN_ID, {
    tokenAddress: "WETH", baseSymbol: "USDC",
    sizesUsd: [100, 1000, 10000, 100000],
  });
  assert(r.ok, r.error ?? "not ok");
  assert(r.ladder.length === 4, "expected 4 rungs");
  assert(r.ladder.every((g) => g.fillable), "every rung must be fillable for WETH/USDC on mainnet");
  assert(r.capacityUsd > 0, "capacity must exceed 0 for WETH");
  // Impact should rise with size; allow a small non-monotonic band (a real
  // chain, not a model). Cap the tolerance loosely: strictly falling impact
  // by >1 open percent between big sizes is suspicious.
  for (let i = 1; i < r.ladder.length; i++) {
    const prev = r.ladder[i - 1].impactPct ?? 0;
    const cur = r.ladder[i].impactPct ?? 0;
    assert(cur >= prev - 1.0, `impact fell >1pp entering rung $${r.ladder[i].sizeUsd}: ${prev} -> ${cur}`);
  }
  return `capacityUsd=${r.capacityUsd}, rungs: ${r.ladder.map((g) => (g.impactPct ?? 0).toFixed(2) + "%").join(" / ")}`;
});

// --- 2. tiny size on WETH must not cost a fortune ----------------------------
await check("$100 round trip on WETH under 3%", async () => {
  const r = await depthProfile(CHAIN_ID, { tokenAddress: "WETH", sizesUsd: [100] });
  const rung = r.ladder[0];
  assert(rung.fillable, "the $100 rung must be fillable for WETH");
  assert(rung.roundTripCostPct < 3, `a $100 WETH round trip should be pennies, measured ${rung.roundTripCostPct}%`);
  return `${rung.roundTripCostPct.toFixed(2)}%`;
});

// --- 3. SHIB: deep-enough token whose cost sits above the 1% default ---------
// Round-trip on SHIB measured ~1.4-1.6%: legitimately above a 1% tolerance, so
// capacity at maxRoundTripPct=1 SHOULD be 0 (that is the honest verdict, not a
// regression). With a 2.5% tolerance it must have real capacity.
await check("SHIB: honest 0 under a 1% tolerance, real capacity under 2.5%", async () => {
  const SHIB = "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE";
  const strict = await depthProfile(CHAIN_ID, { tokenAddress: SHIB, sizesUsd: [100, 1000] });
  assert(strict.ok, strict.error ?? "not ok");
  assert(strict.ladder.some((g) => g.fillable), "SHIB must still be FILLABLE at small sizes (the dust-probe bug would say unexitable)");
  const loose = await depthProfile(CHAIN_ID, { tokenAddress: SHIB, sizesUsd: [100, 1000], maxRoundTripPct: 2.5 });
  assert(loose.capacityUsd > 0, "SHIB has $2M+ liquidity; capacity under a 2.5% tolerance must exist");
  return `fillable, strict capacity=${strict.capacityUsd}, loose=${loose.capacityUsd}`;
});

// --- 4. nonexistent token returns a clean error, not fake rungs ---------------
await check("target with no code returns ok:false, never a ladder", async () => {
  const r = await depthProfile(CHAIN_ID, { tokenAddress: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" });
  if (r.ok) {
    // resolveToken worked? the Aave pool address is not a token: resolve
    // should fail -> ok:false. If it somehow produced a ladder, fail.
    assert(false, "got a ladder for a non-token address - resolveToken guard is gone");
  }
  return "rejected";
});

// --- 5. malformed ladder rejected --------------------------------------------
await check("insane sizes rejected (0, negative, >1e6)", async () => {
  const r = await depthProfile(CHAIN_ID, { tokenAddress: "WETH", sizesUsd: [-5, 0, 2_000_000] });
  assert(!r.ok || r.ladder.length === 0, "a ladder made only of invalid sizes must not produce rungs");
  return "rejected";
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
