// Public-safe coverage for the free error classifier kept in measure.mjs.
// Engine internals are tested in the private verify402-engine repository.

import test from "node:test";
import assert from "node:assert/strict";
import { classifyQuoteError, isHardQuoteFailure } from "../src/measure.mjs";

test("classifyQuoteError separates market facts from transport failures", () => {
  assert.equal(classifyQuoteError(new Error("execution reverted")).kind, "revert");
  assert.equal(classifyQuoteError(new Error("The operation timed out")).kind, "transport");
  assert.equal(classifyQuoteError(new Error("429 Too Many Requests")).reason, "rate_limited");
  assert.equal(isHardQuoteFailure({ ok: false, kind: "transport" }), true);
  assert.equal(isHardQuoteFailure({ ok: false, kind: "revert" }), false);
});
