// Graceful shutdown is part of the paid-service contract: a deploy must stop
// accepting new work, let an in-flight paid call finish, and exit. If draining
// exceeds the deadline the process fails loudly instead of hanging forever.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ${name} ... PASS`);
  } catch (e) {
    failed++;
    console.log(`  ${name} ... FAIL\n      ${e.stack || e.message}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function startFakeRpc({ delayMs = 0, hangBlockNumber = false } = {}) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = {}; }
      const one = Array.isArray(payload) ? payload[0] : payload;
      const id = one?.id ?? null;
      const method = one?.method ?? "";
      const reply = (result) => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (method === "eth_blockNumber") {
        if (hangBlockNumber) return;
        setTimeout(() => reply("0x100"), delayMs);
        return;
      }
      if (method === "eth_chainId") return reply("0x1");
      if (method === "eth_getBlockByNumber") return reply(null);
      return reply("0x0");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close() {
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

async function startApp({ rpcPort, shutdownTimeoutMs }) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      X402_MODE: "testnet",
      BYPASS_PAYMENT: "1",
      AGENT_URL: "https://fixed.example",
      ETH_RPC_URL: `http://127.0.0.1:${rpcPort}`,
      TEST_OFFLINE: "0",
      TEST_OFFLINE_RPC_URL: `http://127.0.0.1:${rpcPort}`,
      READY_CHAIN_ID: "1",
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  return { child, port, logs, exit };
}

async function waitForHealth(port, child, logs) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode != null) throw new Error(`server exited early:\n${logs.join("")}`);
    try {
      const r = await httpRequest(port, "/health");
      if (r.status === 200) return;
    } catch { /* not listening yet */ }
    await sleep(50);
  }
  throw new Error(`server did not become healthy:\n${logs.join("")}`);
}

function httpRequest(port, requestPath, { method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      agent: false,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error("request timeout")));
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

console.log("\ngraceful shutdown");

await check("SIGTERM drains an in-flight request, refuses new connections, then exits 0", async () => {
  const fake = await startFakeRpc({ delayMs: 600 });
  const app = await startApp({ rpcPort: fake.port, shutdownTimeoutMs: 5_000 });
  try {
    await waitForHealth(app.port, app.child, app.logs);
    const inFlight = httpRequest(app.port, "/verify", {
      method: "POST",
      body: { chainId: 1, target: "WETH", size: 1000 },
    });
    await sleep(120);
    app.child.kill("SIGTERM");
    await sleep(150);
    assert.equal(app.child.exitCode, null, "must not exit while a request is in flight");
    await assert.rejects(
      () => httpRequest(app.port, "/health"),
      /ECONNREFUSED|ECONNRESET|socket hang up/i,
      "new connections must be refused after SIGTERM",
    );
    const response = await inFlight;
    assert.ok(response.status >= 400, "the in-flight call still gets its typed failure");
    assert.equal(await app.exit, 0, "drained process exits 0");
    const logs = app.logs.join("");
    assert.match(logs, /received SIGTERM; draining in-flight requests/);
    assert.match(logs, /graceful shutdown complete/);
  } finally {
    if (app.child.exitCode == null) app.child.kill("SIGKILL");
    fake.close();
  }
});

await check("SIGTERM forces exit 1 when the drain deadline expires", async () => {
  const fake = await startFakeRpc({ hangBlockNumber: true });
  const app = await startApp({ rpcPort: fake.port, shutdownTimeoutMs: 400 });
  try {
    await waitForHealth(app.port, app.child, app.logs);
    const inFlight = httpRequest(app.port, "/verify", {
      method: "POST",
      body: { chainId: 1, target: "WETH", size: 1000 },
    }).catch(() => null);
    await sleep(120);
    app.child.kill("SIGTERM");
    assert.equal(await app.exit, 1, "a drain timeout is a nonzero exit");
    const logs = app.logs.join("");
    assert.match(logs, /graceful shutdown timed out after 400ms/);
    await inFlight;
  } finally {
    if (app.child.exitCode == null) app.child.kill("SIGKILL");
    fake.close();
  }
});

console.log(`\nshutdown: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
