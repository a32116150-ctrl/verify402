// Log-redaction boundary.
//
// A 503 is not enough if the provider URL or the caller's key lands in
// stdout/stderr. This test spawns a real server process, triggers an RPC
// failure, and inspects both the HTTP response and the captured logs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { redactText, idempotencyPrefix } from "../src/log.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ${name} ... PASS`);
  } catch (e) {
    failed++;
    console.log(`  ${name} ... FAIL\n      ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ${name} ... PASS`);
  } catch (e) {
    failed++;
    console.log(`  ${name} ... FAIL\n      ${e.message}`);
  }
}

console.log("\nlog redaction");

check("unit: URL paths, query strings and userinfo are stripped", () => {
  const text = redactText(
    "rpc=https://alice:password123@eth-mainnet.g.alchemy.com/v2/SECRETKEY789?apikey=SECRETKEY456",
  );
  assert.ok(!text.includes("SECRETKEY789"), text);
  assert.ok(!text.includes("SECRETKEY456"), text);
  assert.ok(!text.includes("alice"), text);
  assert.ok(!text.includes("password123"), text);
  assert.match(text, /https:\/\/eth-mainnet\.g\.alchemy\.com\/\*\*\*/);
});

check("unit: payment, signature and authorization headers are redacted", () => {
  const text = redactText(
    "x-payment: 0xdeadbeef\npayment-signature: signed-secret\nauthorization: Bearer bearer-secret",
  );
  assert.ok(!text.includes("0xdeadbeef"), text);
  assert.ok(!text.includes("signed-secret"), text);
  assert.ok(!text.includes("bearer-secret"), text);
  assert.match(text, /x-payment: \[REDACTED\]/);
});

check("unit: idempotency keys become an 8-character hash prefix", () => {
  const key = "idem-super-secret-key-1234567890";
  const prefix = idempotencyPrefix(key);
  assert.match(prefix, /^idem:[0-9a-f]{8}$/);
  const text = redactText(`x-idempotency-key: ${key}`, { idempotencyKey: key });
  assert.ok(!text.includes(key), text);
  assert.ok(text.includes(prefix), text);
});

const CHILD = `
const { app } = await import(${JSON.stringify(new URL("../src/server.mjs", import.meta.url).href)});
const server = app.listen(0, "127.0.0.1", () => {
  process.stdout.write("PORT=" + server.address().port + "\\n");
});
`;

function startServer(env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, X402_MODE: "testnet", BYPASS_PAYMENT: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = () => {
      const match = out.match(/PORT=(\d+)/);
      if (match) {
        resolve({ child, port: Number(match[1]), logs: () => out + err });
        return;
      }
      if (child.exitCode != null) {
        reject(new Error(`server exited early (${child.exitCode}):\n${out}${err}`));
        return;
      }
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        reject(new Error(`server did not report a port:\n${out}${err}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function runCase({ name, url, secrets }) {
  const idem = "idem-super-secret-key-1234567890";
  const { child, port, logs } = await startServer({ ETH_RPC_URL: url, TEST_OFFLINE_RPC_URL: url });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": idem,
      },
      body: JSON.stringify({ chainId: 1, target: "WETH", size: 1000 }),
    });
    const body = await r.text();
    assert.equal(r.status, 503, `${name}: status ${r.status}: ${body}`);
    const everything = body + logs();
    for (const secret of secrets) {
      assert.ok(!everything.includes(secret), `${name}: leaked ${secret}\n${everything}`);
    }
    assert.ok(!body.includes(idem), `${name}: full idempotency key in response`);
    assert.ok(!logs().includes(idem), `${name}: full idempotency key in logs`);
    assert.match(logs(), /idem:[0-9a-f]{8}/, `${name}: expected an 8-char idempotency prefix`);
    assert.match(logs(), /http:\/\/127\.0\.0\.1:1\/\*\*\*/, `${name}: expected a sanitized RPC URL`);
  } finally {
    await stopServer(child);
  }
}

await checkAsync("RPC path secret never reaches the response or logs", async () => {
  await runCase({
    name: "path",
    url: "http://127.0.0.1:1/SECRETKEY123",
    secrets: ["SECRETKEY123"],
  });
});

await checkAsync("query apikey and basic-auth credentials never reach the response or logs", async () => {
  await runCase({
    name: "query+auth",
    url: "http://alice:password123@127.0.0.1:1/rpc?apikey=SECRETKEY456&network=mainnet",
    secrets: ["SECRETKEY456", "alice", "password123", "network=mainnet"],
  });
});

console.log(`\nlogs: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
