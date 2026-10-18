// Per-day client-side budget for the verify402 MCP bridge.
//
// MAX_PAYMENT_USD caps ONE payment. That answered "how much can one talked-
//into prompt drain?" but an operator on MoltJobs (vegachiefofstaff) asked the
// sharper question and was right: nothing stopped a long-running task from
// opening a fresh client and resetting the cap. This module adds the missing
// layer, enforced client-side with a persisted ledger:
//
//   MAX_DAILY_USD (optional, off by default) caps the TOTAL spent per UTC day,
//   across process restarts, via a small JSON ledger file. A attempted charge
//   is recorded BEFORE the payment is constructed: for a spending guard the
//   conservative direction is to over-count, never to under-count.
//
// Disabled when MAX_DAILY_USD is unset/0 — the bridge then behaves exactly as
// before, which is also what pure-local testing wants.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const DEFAULT_PRICES = {
  "/verify": 0.05,
  "/safety": 0.10,
  "/route": 0.03,
  "/quotecheck": 0.05,
  "/depth": 0.05,
};

const dayKey = () => new Date().toISOString().slice(0, 10);

function loadLedger(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof j.totalUsd === "number" && j.day === dayKey()) return j;
  } catch { /* fresh day or fresh file */ }
  return { day: dayKey(), totalUsd: 0 };
}

export function createDailyBudget({ maxDailyUsd, ledgerPath, pricesOverride } = {}) {
  const cap = Number(maxDailyUsd || 0);
  if (!(cap > 0)) return { enabled: false, assert: () => ({ charged: 0, totalUsd: null, remaining: null }) };

  const file = ledgerPath || path.join(path.dirname(fileURLToPath(import.meta.url)), ".spend-ledger.json");
  const prices = { ...DEFAULT_PRICES, ...(pricesOverride || {}) };

  function assert(route) {
    let price = prices[route];
    if (price == null) price = prices.default ?? 0;
    const ledger = loadLedger(file);
    const next = Math.round((ledger.totalUsd + price) * 1e6) / 1e6;
    if (next > cap + 1e-9) {
      throw new Error(
        `daily budget exhausted: $${ledger.totalUsd} of $${cap} spent today; refusing ${route} ($${price}). ` +
        `Raise MAX_DAILY_USD in the bridge .env or wait for the next UTC day.`,
      );
    }
    ledger.totalUsd = next;
    ledger.lastRoute = route;
    ledger.lastAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
    return { charged: price, totalUsd: next, remaining: Math.max(0, cap - next) };
  }

  return { enabled: true, cap, file, assert };
}
