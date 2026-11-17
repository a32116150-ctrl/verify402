// Unit tests for the daily paid-route health check.
//
// These pin the two defects that actually happened, so the check itself cannot
// regress into silence: a description one character over CDP's limit, and a
// challenge with no declared bazaar extension.

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkChallenge,
  decodeChallenge,
  listedPaths,
  MAX_DESCRIPTION,
} from "../scripts/bazaar-health.mjs";

const ORIGIN = "https://verify402.onrender.com";

function challengeFor(path, overrides = {}) {
  return {
    x402Version: 2,
    resource: {
      url: `${ORIGIN}${path}`,
      description: "A short, honest description of what this route measures.",
    },
    accepts: [{ scheme: "exact", network: "eip155:84532", payTo: "0xabc", asset: "0xdef", amount: "50000" }],
    extensions: { bazaar: { info: { input: { type: "http", method: "POST", bodyType: "json", body: {} } } } },
    ...overrides,
  };
}

test("a well-formed challenge produces no problems", () => {
  assert.deepEqual(checkChallenge("/verify", ORIGIN, challengeFor("/verify")), []);
});

test("a description over CDP's limit is caught with its actual length", () => {
  const c = challengeFor("/safety", {
    resource: {
      url: `${ORIGIN}/safety`,
      description: "x".repeat(MAX_DESCRIPTION + 1),
    },
  });
  const problems = checkChallenge("/safety", ORIGIN, c);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`${MAX_DESCRIPTION + 1} chars`));
  assert.match(problems[0], /rejected/);
});

test("exactly at the limit is allowed", () => {
  const c = challengeFor("/safety", {
    resource: { url: `${ORIGIN}/safety`, description: "x".repeat(MAX_DESCRIPTION) },
  });
  assert.deepEqual(checkChallenge("/safety", ORIGIN, c), []);
});

test("a missing bazaar extension is caught: a settle there can never be cataloged", () => {
  const c = challengeFor("/route", { extensions: undefined });
  const problems = checkChallenge("/route", ORIGIN, c);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /extensions\.bazaar/);
});

test("a bazaar extension without info.input is caught", () => {
  const c = challengeFor("/route", { extensions: { bazaar: { info: {} } } });
  assert.match(checkChallenge("/route", ORIGIN, c)[0], /info\.input/);
});

test("a resource that does not match the route is caught", () => {
  const c = challengeFor("/verify", { resource: { url: `${ORIGIN}/route`, description: "x" } });
  const problems = checkChallenge("/verify", ORIGIN, c);
  assert.ok(problems.some((p) => /resource is/.test(p)));
});

test("an empty accepts array is caught", () => {
  const c = challengeFor("/depth", { accepts: [] });
  assert.ok(checkChallenge("/depth", ORIGIN, c).some((p) => /accepts/.test(p)));
});

test("a challenge that is not base64 JSON decodes to null rather than throwing", () => {
  assert.equal(decodeChallenge("not-a-header"), null);
  assert.equal(decodeChallenge(""), null);
  const good = Buffer.from(JSON.stringify({ x402Version: 2 }), "utf8").toString("base64");
  assert.deepEqual(decodeChallenge(good), { x402Version: 2 });
});

test("the catalog reader counts only our paid routes on our origin", () => {
  const resources = [
    { resource: { url: `${ORIGIN}/verify` } },
    { resource: `${ORIGIN}/safety` },
    { resource: { url: "https://someone-else.example/verify" } },
    { resource: { url: `${ORIGIN}/findings` } },
  ];
  const listed = listedPaths(resources, ORIGIN);
  assert.deepEqual([...listed].sort(), ["/safety", "/verify"]);
});
