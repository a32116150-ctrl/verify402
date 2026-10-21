// H-1 honesty-contract tests: every paid route, success or typed failure,
// must ship non-empty checked[]/notChecked[], and a failure must not claim the
// work that did not run.
//
//   node test/honesty.test.mjs

import assert from "node:assert/strict";
import {
  PAID_ROUTES, PAID_ROUTE_LIMITS, paidHonesty, honestFailure, unconfiguredVenues,
} from "../src/honesty.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((s) => typeof s === "string" && s.trim());

console.log("\nhonesty contract");

check("all five paid routes are declared", () => {
  assert.deepEqual(PAID_ROUTES.sort(), ["/depth", "/quotecheck", "/route", "/safety", "/verify"]);
});

check("success honesty is non-empty and names real limits on every paid route", () => {
  for (const route of PAID_ROUTES) {
    const h = paidHonesty(route, { checked: [], notChecked: [] });
    assert.ok(nonEmpty(h.checked), `${route} checked[]`);
    assert.ok(nonEmpty(h.notChecked), `${route} notChecked[]`);
    assert.ok(h.notChecked.some((s) => /venues not in config|unconfigured|Aerodrome|Curve/i.test(s)),
      `${route} must name unconfigured venues`);
  }
});

check("typed failure is non-empty but only claims request validation", () => {
  for (const route of PAID_ROUTES) {
    const h = honestFailure(route, "transport");
    assert.ok(nonEmpty(h.checked) && nonEmpty(h.notChecked), `${route} arrays`);
    assert.deepEqual(h.checked, ["request validation"], `${route} must not claim work that did not run`);
    assert.ok(h.notChecked.some((s) => /could not be read/i.test(s)), `${route} names the transport gap`);
    assert.ok(h.notChecked.some((s) => /venues not in config|unconfigured|Aerodrome|Curve/i.test(s)),
      `${route} keeps its static limits`);
  }
});

check("decode failure uses the decode wording, not a market claim", () => {
  const h = honestFailure("/quotecheck", "decode");
  assert.ok(h.notChecked.some((s) => /undecodable|decode/i.test(s)));
  assert.ok(!h.notChecked.some((s) => /no_pool|illiquid/i.test(s)));
});

check("/safety declares quote-based sellability and the untested transfer restrictions", () => {
  const h = PAID_ROUTE_LIMITS["/safety"];
  assert.ok(h.checked.includes("quote-based sellability at a USD-sized probe"));
  assert.ok(!h.checked.includes("sellability"), "the old ambiguous label is gone");
  for (const t of [
    "actual token transfer or sell execution",
    "transfer tax / fee-on-transfer",
    "blacklist / allowlist restrictions",
    "pause / trading-disable switches",
    "max-transaction / max-wallet limits",
  ]) assert.ok(h.notChecked.includes(t), `missing: ${t}`);
});

check("unconfigured venues are named per chain, not hand-waved", () => {
  assert.match(unconfiguredVenues(1), /Curve|Balancer|Pancake/i);
  assert.match(unconfiguredVenues(8453), /Aerodrome|V4/i);
  assert.match(unconfiguredVenues(42161), /Camelot|Trader Joe/i);
});

console.log(`\nhonesty: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
