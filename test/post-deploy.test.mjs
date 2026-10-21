import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
  res.end(JSON.stringify(body));
}

test("post-deploy prints wake result", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/health") return json(res, { ok: true, mode: "testnet" });
    if (req.url === "/ready") return json(res, { ok: true, ready: true, blockNumber: 123, chainId: 1, latencyMs: 1 });
    if (req.url === "/info") return json(res, {
      name: "verify402",
      description: "quote-based sellability",
      prices: { verify: "$0.05", safety: "$0.10", route: "$0.03", quotecheck: "$0.05", depth: "$0.05" },
      recovery: { ttlMinutes: 10, noCompanionAlias: "no content-hash companion" },
      preflight: { defaultTtlSeconds: 90, limits: { perMinutePerIp: 60, maxInFlight: 8 } },
      state_persistence: { scope: "process-local", lostOnRestart: true, warning: "process-local restart or deploy not shared across instances" },
      chainIdRequired: "missing_chain",
      readiness: { path: "/ready" },
      hosting: { status: "Demo instance runs on a free host: first request after idle can take about a minute; testnet only." },
    });
    if (req.url === "/openapi.json") return json(res, { openapi: "3.1.0", info: { title: "verify402" }, paths: { "/verify": { post: { "x-payment-info": { price: { amount: "0.05" } } } }, "/safety": { post: { "x-payment-info": { price: { amount: "0.10" } } } }, "/route": { post: { "x-payment-info": { price: { amount: "0.03" } } } }, "/quotecheck": { post: { "x-payment-info": { price: { amount: "0.05" } } } }, "/depth": { post: { "x-payment-info": { price: { amount: "0.05" } } } } } });
    if (req.url === "/.well-known/verify402.json") return json(res, { operationalPolicies: { receipts: { defaultTtlSeconds: 90, rangeSeconds: "15-300" }, rateLimits: { preflight: "60 requests/minute per IP, max concurrency 8" }, idempotency: { description: "within a 600s window" } }, paymentRequirements: { pricing: { verify: { priceUsd: 0.05 }, safety: { priceUsd: 0.1 }, route: { priceUsd: 0.03 }, quotecheck: { priceUsd: 0.05 }, depth: { priceUsd: 0.05 } } } });
    if (req.url === "/.well-known/x402") return json(res, { resources: [{ url: "https://example.test/verify" }, { url: "https://example.test/safety" }, { url: "https://example.test/route" }, { url: "https://example.test/quotecheck" }, { url: "https://example.test/depth" }] });
    if (req.url === "/llms.txt") return res.end("quote-based sellability");
    if (req.url.startsWith("/preflight")) return json(res, { verdict: "CAUTION", receipt: { hmac: "x" }, checked: ["a"], notChecked: ["b"], valid: true });
    if (req.url === "/verify") return json(res, {}, 402);
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, ["scripts/post-deploy-check.mjs"], {
    cwd: ROOT,
    env: { ...process.env, SMOKE_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  server.close();
  assert.equal(code, 0, output);
  assert.match(output, /^wake: (ready|FAILED), \d+ms, \d+ attempt\(s\)$/m, output);
});
