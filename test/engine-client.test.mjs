// The private-engine client: BigInt-safe transport, auth, fail-closed errors,
// and the engine wiring that chooses remote over local computation.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { remoteEngine, remoteEngineConfigured } from "../src/engine-client.mjs";

function withEnv(values, fn) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("no private service configured means local fallback", async () => {
  await withEnv({ VERIFY402_ENGINE_URL: null, VERIFY402_ENGINE_TOKEN: null }, async () => {
    assert.equal(remoteEngineConfigured(), false);
    assert.equal(await remoteEngine("verify", 1, {}), null);
  });
});

test("BigInt options and results survive the round trip with bearer auth", async () => {
  let request;
  await withServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      request = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, amount: { $$bigint: "42" } }));
    });
  }, async (url) => {
    await withEnv({ VERIFY402_ENGINE_URL: `${url}/`, VERIFY402_ENGINE_TOKEN: "test-token" }, async () => {
      assert.equal(remoteEngineConfigured(), true);
      const result = await remoteEngine("verify", 8453, { size: 10n, base: "USDC" });
      assert.equal(result.ok, true);
      assert.equal(result.amount, 42n);
      assert.equal(request.url, "/internal/engine/verify");
      assert.equal(request.auth, "Bearer test-token");
      assert.deepEqual(request.body, {
        chainId: 8453,
        opts: { size: { $$bigint: "10" }, base: "USDC" },
      });
    });
  });
});

test("a failing private service is typed and does not fall back silently", async () => {
  await withServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}');
  }, async (url) => {
    await withEnv({ VERIFY402_ENGINE_URL: url, VERIFY402_ENGINE_TOKEN: "bad" }, async () => {
      await assert.rejects(() => remoteEngine("depth", 1, {}), (error) =>
        error.code === "engine_service_unavailable" && error.status === 401);
    });
  });
});

test("engines send paid work to the private service when configured", async () => {
  const calls = [];
  await withServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      calls.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, engine: req.url.split("/").pop() }));
    });
  }, async (url) => {
    await withEnv({
      VERIFY402_ENGINE_URL: url,
      VERIFY402_ENGINE_TOKEN: "test-token",
      VERIFY402_LICENSE_BYPASS: "1",
    }, async () => {
      const { measureRoundTrip } = await import("../src/measure.mjs");
      const { preTradeCheck } = await import("../src/safety.mjs");
      const { fairQuoteCheck, bestRouteBook } = await import("../src/quotecheck.mjs");
      const { depthProfile } = await import("../src/depth.mjs");
      assert.equal((await measureRoundTrip(1, { size: 5n })).engine, "verify");
      assert.equal((await preTradeCheck(1, {})).engine, "safety");
      assert.equal((await fairQuoteCheck(1, {})).engine, "quotecheck");
      assert.equal((await bestRouteBook(null, 1, { amountIn: 7n })).engine, "route");
      assert.equal((await depthProfile(1, {})).engine, "depth");
      assert.deepEqual(calls.map((c) => c.url), [
        "/internal/engine/verify",
        "/internal/engine/safety",
        "/internal/engine/quotecheck",
        "/internal/engine/route",
        "/internal/engine/depth",
      ]);
      assert.deepEqual(calls[3].body.opts, { amountIn: { $$bigint: "7" } });
    });
  });
});

test("the license gate still runs before any private engine call", async () => {
  let called = false;
  await withServer((_req, res) => {
    called = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }, async (url) => {
    await withEnv({
      VERIFY402_ENGINE_URL: url,
      VERIFY402_ENGINE_TOKEN: "test-token",
      VERIFY402_LICENSE_BYPASS: null,
      VERIFY402_LICENSE_KEY: null,
      X402_MODE: "testnet",
    }, async () => {
      const { measureRoundTrip } = await import("../src/measure.mjs");
      await assert.rejects(() => measureRoundTrip(1, {}), (error) => error.code === "license_required");
      assert.equal(called, false);
    });
  });
});
