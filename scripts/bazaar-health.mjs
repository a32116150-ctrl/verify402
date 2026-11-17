#!/usr/bin/env node
// Daily health check for the paid routes and their Bazaar listings.
//
// Free by design: no wallet, no payment, no API key. It answers one question —
// "can an agent still find and buy these five routes?" — and exits non-zero when
// the answer is no.
//
// Why this exists. Two defects each broke a paid route for every payer and
// neither produced an alert:
//   * the payer never sent `extensions.bazaar`, so settled payments were never
//     submitted for cataloging (weeks of "indexing lag" that was not lag);
//   * /safety's resource description was 501 characters, one over the limit at
//     which CDP's facilitator rejects verify and settle, so that route answered
//     502 to everybody.
// Both are visible without spending money: the first in the 402 challenge +
// CDP's public /validate, the second in the same description length. The 30-day
// listing expiry is visible in the public merchant catalog.
//
// Usage:
//   node scripts/bazaar-health.mjs                      # check the live service
//   node scripts/bazaar-health.mjs --url http://127.0.0.1:3999
//                                                       # check a local build's 402s,
//                                                       # still validating against the
//                                                       # public origin for CDP steps
// Exit code 0 = every route is challengeable, valid, and listed. 1 = something is not.

import { pathToFileURL } from "node:url";

export const LIVE_ORIGIN = "https://verify402.onrender.com";
export const CDP_BASE = "https://api.cdp.coinbase.com/platform/v2/x402";
export const DEFAULT_PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
export const PAID_PATHS = ["/verify", "/safety", "/route", "/quotecheck", "/depth"];

// CDP rejects verify/settle when the resource description is longer than this.
export const MAX_DESCRIPTION = 500;

/** Decode a payment challenge header. Returns null when it is not JSON/base64. */
export function decodeChallenge(header) {
  const raw = String(header || "").trim();
  if (!raw) return null;
  try {
    const candidates = [raw, Buffer.from(raw, "base64").toString("utf8")];
    for (const text of candidates) {
      if (!text.trim().startsWith("{")) continue;
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Assert the 402 challenge is buyable and catalogable.
 * Returns an array of human-readable problems; empty means good.
 */
export function checkChallenge(pathname, origin, challenge) {
  const problems = [];
  if (!challenge) return [`${pathname}: no decodable PAYMENT-REQUIRED challenge`];
  if (challenge.x402Version !== 2) problems.push(`${pathname}: x402Version is ${challenge.x402Version}, expected 2`);
  if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
    problems.push(`${pathname}: accepts[] is empty`);
  }

  const url = challenge.resource?.url ?? challenge.resource;
  const expected = `${origin}${pathname}`;
  if (url !== expected) problems.push(`${pathname}: resource is ${url}, expected ${expected}`);

  const description = String(challenge.resource?.description ?? "");
  if (!description) {
    problems.push(`${pathname}: resource has no description; the catalog has nothing to show an agent`);
  } else if (description.length > MAX_DESCRIPTION) {
    problems.push(
      `${pathname}: description is ${description.length} chars, over CDP's ${MAX_DESCRIPTION}-char limit — every verify and settle on this route is rejected`,
    );
  }

  // Discovery is submitted from the challenge's declared extension; without it
  // a settlement buys the answer and never lists the resource.
  if (!challenge.extensions?.bazaar) {
    problems.push(`${pathname}: challenge declares no extensions.bazaar; a settle here cannot be cataloged`);
  } else if (!challenge.extensions.bazaar.info?.input) {
    problems.push(`${pathname}: extensions.bazaar has no info.input; an agent cannot construct a call`);
  }
  return problems;
}

/** Routes present in the merchant catalog. */
export function listedPaths(resources, origin) {
  const seen = new Set();
  for (const entry of resources || []) {
    const url = entry?.resource?.url ?? entry?.resource;
    if (typeof url !== "string" || !url.startsWith(origin)) continue;
    const path = url.slice(origin.length);
    if (PAID_PATHS.includes(path)) seen.add(path);
  }
  return seen;
}

async function getJson(url, { method = "GET", body, attempts = 3 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* left null */ }
      return { status: res.status, headers: res.headers, json, text };
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastError;
}

async function main() {
  const args = process.argv.slice(2);
  const urlFlag = args.indexOf("--url");
  const probeOrigin = urlFlag >= 0 && args[urlFlag + 1]
    ? args[urlFlag + 1].replace(/\/+$/, "")
    : LIVE_ORIGIN;
  const publicOrigin = LIVE_ORIGIN;
  const payTo = process.env.VERIFY402_PAY_TO || DEFAULT_PAY_TO;

  const problems = [];
  console.log(`probing 402s at ${probeOrigin}`);
  console.log(`validating listings at ${publicOrigin} (CDP)\n`);

  for (const path of PAID_PATHS) {
    const res = await getJson(`${probeOrigin}${path}`, { method: "POST", body: {} }).catch((e) => ({ error: e }));
    if (res.error) {
      problems.push(`${path}: could not reach the service (${res.error.message})`);
      console.log(`  ${path.padEnd(12)} unreachable`);
      continue;
    }
    if (res.status !== 402) {
      problems.push(`${path}: answered ${res.status} instead of 402 — an unpaid call must be challenged, not served`);
      console.log(`  ${path.padEnd(12)} ${res.status} (expected 402)`);
      continue;
    }
    const challenge = decodeChallenge(res.headers.get("payment-required"));
    const found = checkChallenge(path, probeOrigin, challenge);
    problems.push(...found);

    // CDP's own validator, free and keyless, on the public origin.
    const validated = await getJson(`${CDP_BASE}/validate`, {
      method: "POST",
      body: { resource: `${publicOrigin}${path}`, method: "POST" },
    }).catch((e) => ({ error: e }));
    if (validated.error) {
      problems.push(`${path}: CDP /validate failed (${validated.error.message})`);
    } else if (validated.json?.valid !== true) {
      const failed = (validated.json?.preflight || []).filter((c) => !c.passed && c.severity === "required");
      problems.push(
        `${path}: CDP /validate says invalid — ${failed.map((c) => c.check).join(", ") || "no detail"}`,
      );
    }

    const ok = found.length === 0 ? "ok" : `${found.length} problem(s)`;
    console.log(`  ${path.padEnd(12)} ${ok}${validated.json?.valid === true ? " · CDP valid" : ""}`);
  }

  const catalogue = await getJson(
    `${CDP_BASE}/discovery/merchant?payTo=${encodeURIComponent(payTo)}&limit=50`,
  ).catch((e) => ({ error: e }));
  if (catalogue.error) {
    problems.push(`catalog: merchant lookup failed (${catalogue.error.message})`);
  } else {
    const listed = listedPaths(catalogue.json?.resources, publicOrigin);
    for (const path of PAID_PATHS) {
      if (!listed.has(path)) {
        problems.push(
          `${path}: not in the Bazaar catalog — a resource with no settlement in 30 days is removed; settle it once to relist`,
        );
      }
    }
    console.log(`\ncatalog: ${listed.size}/${PAID_PATHS.length} listed`);
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nevery paid route is challengeable, CDP-valid, and listed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
