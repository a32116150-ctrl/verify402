// Offline readiness-registry tests. No public RPC is contacted: these
// assertions pin the chain map that /ready uses, including readiness-only Base
// Sepolia, and use loopback servers for the transport paths.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { READINESS_CHAINS, readinessChain } from "../src/config.mjs";
import { readinessClientFor, readinessProbe } from "../src/measure.mjs";

// These tests must never touch a public endpoint. The readiness client reads
// this flag at call time; the local mocks below are loopback only.
process.env.TEST_OFFLINE = "1";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test("readiness supports the measurement chains and Base Sepolia", () => {
  for (const id of [1, 42161, 8453, 84532]) {
    assert.ok(READINESS_CHAINS[id], `chain ${id} must be readable by /ready`);
    assert.ok(readinessChain(id).viemChain, `chain ${id} needs a viem chain`);
  }
  const baseSepolia = readinessChain(84532);
  assert.equal(baseSepolia.name, "base-sepolia");
  assert.equal(baseSepolia.viemChain, "baseSepolia");
  assert.equal(baseSepolia.rpcDefault, "https://sepolia.base.org");
  assert.equal(baseSepolia.rpcEnv, "BASE_SEPOLIA_RPC_URL");
});

test("an unsupported READY_CHAIN_ID fails closed with a clear error", () => {
  assert.throws(() => readinessChain(999), /not a supported readiness chain/);
  assert.throws(() => readinessClientFor(999), /not a supported readiness chain/);
});

test("readinessProbe checks eth_chainId before reading a block", async () => {
  const calls = [];
  const client = {
    async getChainId() { calls.push("chain"); return 8453; },
    async getBlockNumber() { calls.push("block"); return 42n; },
  };
  assert.deepEqual(await readinessProbe(8453, { client }), {
    chainId: 8453,
    rpcChainId: 8453,
    blockNumber: 42,
  });
  assert.deepEqual(calls, ["chain", "block"]);
});

test("readinessProbe fails closed when the RPC is on the wrong chain", async () => {
  let blockCalls = 0;
  const client = {
    async getChainId() { return 1; },
    async getBlockNumber() { blockCalls++; return 42n; },
  };
  await assert.rejects(
    () => readinessProbe(84532, { client }),
    /reports chain 1, expected 84532/,
  );
  assert.equal(blockCalls, 0, "a wrong-chain RPC must not be asked for a block");
});

test("readinessProbe bounds a hanging chain-ID call", async () => {
  const client = {
    getChainId() { return new Promise(() => {}); },
    async getBlockNumber() { return 42n; },
  };
  const started = Date.now();
  await assert.rejects(
    () => readinessProbe(8453, { client, timeoutMs: 25 }),
    /exceeded 25ms/,
  );
  assert.ok(Date.now() - started < 1_000, "the probe must not wait on the RPC transport timeout");
});

test("readiness reads a block from a configured local RPC without a live call", async () => {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let id = 1;
      let method = "";
      try {
        const request = JSON.parse(raw);
        id = request.id ?? id;
        method = request.method;
      } catch { /* keep defaults */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: method === "eth_chainId" ? "0x2105" : "0x2a",
      }));
    });
  });
  const port = await listen(server);
  const previousOffline = process.env.TEST_OFFLINE;
  const previousUrl = process.env.READY_RPC_URL;
  process.env.TEST_OFFLINE = "0";
  process.env.READY_RPC_URL = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await readinessProbe(8453), {
      chainId: 8453,
      rpcChainId: 8453,
      blockNumber: 42,
    });
  } finally {
    if (previousOffline === undefined) delete process.env.TEST_OFFLINE;
    else process.env.TEST_OFFLINE = previousOffline;
    if (previousUrl === undefined) delete process.env.READY_RPC_URL;
    else process.env.READY_RPC_URL = previousUrl;
    await close(server);
  }
});

test("readiness RPC timeout is bounded, not an unbounded hang", async () => {
  const server = http.createServer(() => { /* intentionally never responds */ });
  const port = await listen(server);
  const previous = process.env.TEST_OFFLINE_RPC_URL;
  process.env.TEST_OFFLINE = "1";
  process.env.TEST_OFFLINE_RPC_URL = `http://127.0.0.1:${port}`;
  try {
    const client = readinessClientFor(84532);
    const started = Date.now();
    await assert.rejects(() => client.getBlockNumber());
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_000 && elapsed < 8_000, `expected a ~3s timeout, got ${elapsed}ms`);
  } finally {
    if (previous === undefined) delete process.env.TEST_OFFLINE_RPC_URL;
    else process.env.TEST_OFFLINE_RPC_URL = previous;
    await close(server);
  }
});

test("Base Sepolia is readiness-only, not a paid measurement chain", async () => {
  const { CHAINS } = await import("../src/config.mjs");
  assert.equal(CHAINS[84532], undefined, "readiness must not widen the paid-route chain registry");
  // The client was constructed by the timeout test; this does not connect.
  const client = readinessClientFor(84532);
  assert.equal(typeof client.getBlockNumber, "function");
});
