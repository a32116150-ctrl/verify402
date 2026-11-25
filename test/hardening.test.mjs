// Small hardening rules: who the free-gate limit counts, and where the
// private-engine bearer token may be sent.
//
//   node --test test/hardening.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { rateLimitSubject } from "../src/rate-limit.mjs";
import { engineUrlProblem, remoteEngine } from "../src/engine-client.mjs";

test("IPv4 is counted per address", () => {
  assert.equal(rateLimitSubject("203.0.113.7"), "203.0.113.7");
  assert.equal(rateLimitSubject("::ffff:203.0.113.7"), "203.0.113.7");
});

test("IPv6 addresses in one /64 share a single limit", () => {
  const a = rateLimitSubject("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  const b = rateLimitSubject("2001:db8:1:2::1");
  const c = rateLimitSubject("2001:0db8:0001:0002:ffff::9");
  assert.equal(a, "2001:db8:1:2::/64");
  assert.equal(b, a);
  assert.equal(c, a);
  assert.notEqual(rateLimitSubject("2001:db8:1:3::1"), a, "a different /64 is a different subject");
});

test("missing or odd addresses never throw", () => {
  assert.equal(rateLimitSubject(undefined), "unknown");
  assert.equal(rateLimitSubject("::1"), "0:0:0:0::/64");
  assert.equal(rateLimitSubject("fe80::1%en0"), "fe80:0:0:0::/64");
});

test("engine URL: https anywhere, plain http only to this machine", () => {
  assert.equal(engineUrlProblem("https://engine.example.internal"), null);
  assert.equal(engineUrlProblem("http://127.0.0.1:8500"), null);
  assert.equal(engineUrlProblem("http://localhost:8500"), null);
  assert.equal(engineUrlProblem("http://[::1]:8500"), null);
  assert.match(engineUrlProblem("http://10.0.0.5:8500"), /https/);
  assert.match(engineUrlProblem("http://engine.example.com"), /https/);
  assert.match(engineUrlProblem("https://user:pw@engine.example.com"), /credentials/);
  assert.match(engineUrlProblem("not a url"), /valid/);
});

test("engine token is never sent to a refused URL", async () => {
  const saved = { url: process.env.VERIFY402_ENGINE_URL, token: process.env.VERIFY402_ENGINE_TOKEN };
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    process.env.VERIFY402_ENGINE_URL = "http://engine.example.com";
    process.env.VERIFY402_ENGINE_TOKEN = "secret-token";
    await assert.rejects(remoteEngine("safety", 8453, {}), (e) => {
      assert.equal(e.code, "engine_service_unavailable");
      assert.ok(!e.message.includes("secret-token"));
      assert.ok(!e.message.includes("engine.example.com"), "the URL is not echoed");
      return true;
    });
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.url === undefined) delete process.env.VERIFY402_ENGINE_URL; else process.env.VERIFY402_ENGINE_URL = saved.url;
    if (saved.token === undefined) delete process.env.VERIFY402_ENGINE_TOKEN; else process.env.VERIFY402_ENGINE_TOKEN = saved.token;
  }
});
