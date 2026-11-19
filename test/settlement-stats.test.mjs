import test from "node:test";
import assert from "node:assert/strict";

import { formatUsdc, summarizeSettlements } from "../src/settlement-stats.mjs";

const OPERATOR = "0x9a48474b06554c25258b4bc3def5a637cbf5ad4b";
const OUTSIDE = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";

test("USDC amounts are formatted without floating point", () => {
  assert.equal(formatUsdc("0"), "0");
  assert.equal(formatUsdc("30000"), "0.03");
  assert.equal(formatUsdc("100000"), "0.1");
  assert.equal(formatUsdc("370041"), "0.370041");
});

test("operator tests and outside payers are counted separately", () => {
  const rows = [
    { from: OPERATOR, amountRaw: "30000" },
    { from: OPERATOR, amountRaw: "30000" },
    { from: OPERATOR, amountRaw: "100000" },
    { from: OUTSIDE, amountRaw: "30000" },
  ];
  const summary = summarizeSettlements(rows, [OPERATOR]);
  assert.equal(summary.paidCalls, 4);
  assert.equal(summary.usdc, "0.19");
  assert.equal(summary.operatorCalls, 3);
  assert.equal(summary.outsideCalls, 1);
  assert.equal(summary.outsideUsdc, "0.03");
  assert.equal(summary.outsidePayers, 1);
  assert.equal(summary.repeatOutsidePayers, 0);
  assert.equal(summary.uniquePayers, 2);
});

test("a repeat outside payer is visible", () => {
  const summary = summarizeSettlements([
    { from: OUTSIDE, amountRaw: "30000" },
    { from: OUTSIDE, amountRaw: "30000" },
  ], [OPERATOR]);
  assert.equal(summary.outsidePayers, 1);
  assert.equal(summary.repeatOutsidePayers, 1);
});
