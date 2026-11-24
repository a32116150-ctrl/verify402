// H-5: the MCP bridge must use one high-entropy key per tool operation, keep
// it across retries, and never auto-retry a 402 or 409. The tests use a fake
// paid API, so no wallet, network, or x402 handshake is involved.

import test from "node:test";
import assert from "node:assert/strict";
import { paidPost, isRetryable } from "../paid-call.mjs";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timeoutError() {
  const e = new Error("timeout");
  e.code = "ETIMEDOUT";
  e.isAxiosError = true;
  return e;
}

function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.response = { status };
  e.isAxiosError = true;
  return e;
}

const noSleep = async () => {};

test("generates a UUID v4 key and reuses it after a timeout", async () => {
  const keys = [];
  let calls = 0;
  const api = {
    async post(_route, _body, config) {
      keys.push(config.headers["x-idempotency-key"]);
      calls++;
      if (calls === 1) throw timeoutError();
      return { status: 200, data: { ok: true, recovery: { replayed: true } } };
    },
  };

  const res = await paidPost(api, "/verify", { chainId: 1 }, { sleep: noSleep });
  assert.equal(calls, 2, "one timeout, one successful retry");
  assert.equal(keys.length, 2);
  assert.match(keys[0], UUID_V4, "the key must be crypto.randomUUID() shaped");
  assert.equal(keys[0], keys[1], "the retry must use the same key");
  assert.equal(res.data.recovery.replayed, true);
});

test("a 402 is surfaced once and never auto-retried", async () => {
  let calls = 0;
  const api = {
    async post() {
      calls++;
      throw httpError(402);
    },
  };
  await assert.rejects(() => paidPost(api, "/verify", {}, { sleep: noSleep }), /HTTP 402/);
  assert.equal(calls, 1);
});

test("a 409 is surfaced once and never auto-retried", async () => {
  let calls = 0;
  const api = {
    async post() {
      calls++;
      throw httpError(409);
    },
  };
  await assert.rejects(() => paidPost(api, "/verify", {}, { sleep: noSleep }), /HTTP 409/);
  assert.equal(calls, 1);
});

test("lost response after settlement: same key replays, only one payment", async () => {
  let requests = 0;
  let settlements = 0;
  let firstKey = null;
  const api = {
    async post(_route, _body, config) {
      const key = config.headers["x-idempotency-key"];
      requests++;
      if (requests === 1) {
        firstKey = key;
        settlements++; // the fake server settled before the response was lost
        throw timeoutError();
      }
      assert.equal(key, firstKey, "the replay must present the original key");
      return {
        status: 200,
        data: { ok: true, verdict: "no_edge", recovery: { replayed: true, replays: 1 } },
      };
    },
  };

  const res = await paidPost(api, "/verify", {}, { sleep: noSleep });
  assert.equal(requests, 2);
  assert.equal(settlements, 1, "the retry must not be a second payment");
  assert.equal(res.data.recovery.replayed, true);
});

test("503 is retried with the same key, then surfaced if it persists", async () => {
  const keys = [];
  let calls = 0;
  const api = {
    async post(_route, _body, config) {
      keys.push(config.headers["x-idempotency-key"]);
      calls++;
      throw httpError(503);
    },
  };
  await assert.rejects(() => paidPost(api, "/verify", {}, { retries: 1, sleep: noSleep }), /HTTP 503/);
  assert.equal(calls, 2);
  assert.equal(keys[0], keys[1]);
});

test("400 is not retried", async () => {
  let calls = 0;
  const api = {
    async post() {
      calls++;
      throw httpError(400);
    },
  };
  await assert.rejects(() => paidPost(api, "/verify", {}, { sleep: noSleep }), /HTTP 400/);
  assert.equal(calls, 1);
});

test("isRetryable only covers transport, timeout and gateway failures", () => {
  assert.equal(isRetryable(timeoutError()), true);
  assert.equal(isRetryable(httpError(502)), true);
  assert.equal(isRetryable(httpError(503)), true);
  assert.equal(isRetryable(httpError(504)), true);
  assert.equal(isRetryable(httpError(402)), false);
  assert.equal(isRetryable(httpError(409)), false);
  assert.equal(isRetryable(httpError(400)), false);
  assert.equal(isRetryable(new Error("programmer error")), false);
});
