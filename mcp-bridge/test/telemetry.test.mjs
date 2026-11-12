// The bridge's telemetry is opt-in and anonymous by construction.
//
// These tests pin the three properties that make it safe to ship:
//   1. it is OFF unless VERIFY402_TELEMETRY=1 (the default),
//   2. it sends only { tool, ok } through the same axios instance that already
//      carries the client header (so no body fields beyond the two above),
//   3. a telemetry failure never changes the tool's answer.

import test from "node:test";
import assert from "node:assert/strict";

process.env.VERIFY402_TELEMETRY = "1";
process.env.VERIFY402_URL = "https://verify402.onrender.com";

const { pingUsage } = await import("../index.mjs");

test("pingUsage sends only { tool, ok } through the bridge HTTP client", () => {
  const sent = [];
  const poster = (body) => {
    sent.push(body);
    return Promise.resolve({ status: 202 });
  };
  assert.equal(pingUsage("preflight_gate", true, { post: poster }), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { tool: "preflight_gate", ok: true });
  assert.deepEqual(Object.keys(sent[0]).sort(), ["ok", "tool"]);
});

test("pingUsage never throws, even when the poster throws synchronously", () => {
  const poster = () => {
    throw new Error("network down");
  };
  assert.equal(pingUsage("directory_402", false, { post: poster }), false);
});

test("pingUsage reports failures as ok: false without extra fields", () => {
  const sent = [];
  const poster = (body) => {
    sent.push(body);
    return Promise.reject(new Error("upstream 500"));
  };
  assert.equal(pingUsage("inspect_402", false, { post: poster }), true);
  assert.deepEqual(sent[0], { tool: "inspect_402", ok: false });
  assert.deepEqual(Object.keys(sent[0]).sort(), ["ok", "tool"]);
});
