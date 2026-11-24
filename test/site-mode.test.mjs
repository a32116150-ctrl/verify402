import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderSiteHtml, withCanonical } from "../src/site-mode.mjs";

const read = (name) => readFileSync(new URL(`../src/site/${name}`, import.meta.url), "utf8");

test("testnet mode is byte-for-byte unchanged", () => {
  const raw = read("checks.html");
  assert.equal(renderSiteHtml(raw, { mode: "testnet", path: "/checks" }), raw);
});

test("mainnet mode removes the testnet payment claims from page copy", () => {
  const pages = {
    "/checks": read("checks.html"),
    "/activity": read("activity.html"),
    "/testers": read("testers.html"),
    "/start": read("start.html"),
    "/mcp": read("mcp.html"),
    "/preflight": read("preflight.html"),
  };
  for (const [path, raw] of Object.entries(pages)) {
    const out = renderSiteHtml(raw, { mode: "mainnet", path });
    assert.ok(!/demo payments are testnet/.test(out), `${path} still says demo payments are testnet`);
    assert.ok(!/testnet USDC for the public demo/.test(out), `${path} still prices the demo in testnet USDC`);
    assert.ok(!/payment rail is testnet-only/.test(out), `${path} still calls the rail testnet-only`);
  }
});

test("mainnet mode rewrites the site-wide footer and the sample intents", () => {
  const raw = read("inspect.html");
  const out = renderSiteHtml(raw, { mode: "mainnet", path: "/inspect" });
  assert.ok(out.includes("This instance settles real USDC on Base mainnet / Solana mainnet over x402."));
  assert.ok(out.includes("paid in USDC over x402"));
  const start = renderSiteHtml(read("start.html"), { mode: "mainnet", path: "/start" });
  assert.ok(start.includes('"network": "eip155:8453"'));
  assert.ok(start.includes("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
});

test("blog bodies keep their historical rail; only their footer is rewritten", () => {
  const raw = read("blog/verify402-cdp-facilitator-testnet.html");
  const out = renderSiteHtml(raw, { mode: "mainnet", path: "/blog/verify402-cdp-facilitator-testnet" });
  assert.ok(out.includes("testnet USDC"), "the historical post must still describe its testnet settlement");
  assert.ok(!out.includes("Analysis reads mainnet chain data; demo payments are testnet."));
  assert.ok(out.includes("This instance settles real USDC on Base mainnet / Solana mainnet over x402."));
});

test("withCanonical pins public pages to the mainnet origin without duplicating a canonical", () => {
  const plain = read("start.html");
  const out = withCanonical(plain, "/start");
  assert.equal((out.match(/rel="canonical"/g) || []).length, 1);
  assert.ok(out.includes('<link rel="canonical" href="https://vex402.online/start">'));

  const already = withCanonical(read("blog/what-public-402s-look-like.html"), "/blog/what-public-402s-look-like");
  assert.equal((already.match(/rel="canonical"/g) || []).length, 1);
  assert.ok(already.includes('<link rel="canonical" href="https://vex402.online/blog/what-public-402s-look-like">'));

  const htmlExtension = withCanonical(plain, "/start.html");
  assert.ok(htmlExtension.includes('<link rel="canonical" href="https://vex402.online/start">'));
});
