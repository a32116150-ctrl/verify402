// /safety with {"network":"solana"}: the public server forwards the mint to the
// private engine ("solana-safety"), returns its verdict with the honesty
// arrays, and signs the answer. A local fake engine stands in for the private
// service.

import assert from "node:assert/strict";
import http from "node:http";

process.env.X402_MODE = "testnet";
process.env.BYPASS_PAYMENT = "1";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const seen = [];
const engine = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    const mint = body.opts?.mint;
    const out = mint === MINT
      ? { ok: true, network: "solana", mint, program: "spl-token", verdict: "AVOID", reasons: [{ code: "permanent_delegate", severity: "avoid", message: "x" }], checked: ["mint authority"], notChecked: ["whether the token can actually be sold"] }
      : { ok: false, kind: "bad_request", error: "this address is not a token mint" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => engine.listen(0, "127.0.0.1", r));
process.env.VERIFY402_ENGINE_URL = `http://127.0.0.1:${engine.address().port}`;
process.env.VERIFY402_ENGINE_TOKEN = "test-engine-token-not-a-secret";

const { verifySignedResponse } = await import("../src/signing.mjs");
const { app } = await import("../src/server.mjs");
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (body) => {
  const r = await fetch(`${base}/safety`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ${name} ... PASS`); }
  catch (e) { failed++; console.log(`  ${name} ... FAIL\n      ${e.message}`); }
}

console.log("\n/safety on Solana");

await check("a Solana mint is checked by the engine, needs no chainId, and the answer is signed", async () => {
  const r = await post({ network: "solana", tokenAddress: MINT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.verdict, "AVOID");
  assert.equal(r.body.network, "solana");
  assert.ok(Array.isArray(r.body.notChecked) && r.body.notChecked.length > 0);
  const last = seen.at(-1);
  assert.equal(last.path, "/internal/engine/solana-safety");
  assert.equal(last.body.opts.mint, MINT);
  const key = await (await fetch(`${base}/.well-known/verify402-signing-key`)).json();
  assert.deepEqual(verifySignedResponse(r.body, key.publicKeySpkiBase64), { ok: true });
});

await check("a missing mint is 400 before any engine call", async () => {
  const before = seen.length;
  const r = await post({ network: "solana" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "missing_tokenAddress", JSON.stringify(r.body));
  assert.equal(seen.length, before);
});

await check("an engine bad_request becomes a 400 with the reason", async () => {
  const r = await post({ network: "solana", tokenAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /not a token mint/);
});

await check("EVM /safety still requires a chainId", async () => {
  const r = await post({ tokenAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "missing_chain", JSON.stringify(r.body));
});

server.close();
engine.close();
console.log(`\nsolana-safety-route: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
