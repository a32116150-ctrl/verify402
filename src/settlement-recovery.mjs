// Recovery hooks for the official x402 settlement lifecycle.
//
// A staged response becomes replayable only in `onAfterSettle` (the
// facilitator confirmed THIS settlement), and is abandoned early only in
// `onSettleFailure` when the failure is definitive. Everything else — timeout,
// transport failure, pending settlement, a failure carrying a transaction
// hash, or an unknown error — is ambiguous: the staged record stays pending
// until its TTL so a retry cannot silently charge twice.
//
// The hooks are intentionally tiny and dependency-free apart from recovery.mjs
// so the real @x402/express middleware can exercise the exact registration path
// in tests.

import { promoteSettlement, abandonSettlement } from "./recovery.mjs";

const NON_DEFINITIVE_REASONS = new Set([
  "settlement_pending",
  "Settlement failed", // synthetic fallback for a failed settle with no reason
  "unknown reason",
]);

// The server's SettleError is a distinct class from the one exported by
// @x402/core/types (both bundles define their own copy), so identify it by
// shape rather than by `instanceof` across module boundaries.
function isSettleError(error) {
  return Boolean(
    error
    && typeof error === "object"
    && error.name === "SettleError"
    && typeof error.statusCode === "number"
    && typeof error.errorReason === "string"
    && "transaction" in error,
  );
}

export function isDefinitiveSettlementFailure(error) {
  if (!isSettleError(error)) return false;

  const reason = error.errorReason.trim();
  if (!reason || NON_DEFINITIVE_REASONS.has(reason)) return false;

  // A transaction hash means value may already be moving on-chain. Even a
  // failed-looking result is ambiguous then; never abandon the staged record.
  if (typeof error.transaction === "string" && error.transaction.trim()) return false;

  return true;
}

export function recoveryAfterSettle(ctx) {
  if (ctx?.phase !== "after-handler") return;
  if (ctx?.result?.success !== true) return;
  const responseBody = ctx?.transportContext?.responseBody ?? null;
  promoteSettlement(responseBody, {
    ok: true,
    transaction: ctx?.result?.transaction ?? null,
    network: ctx?.result?.network ?? null,
    payer: ctx?.result?.payer ?? null,
  });
}

export function recoverySettleFailure(ctx) {
  if (ctx?.phase !== "after-handler") return;
  if (!isDefinitiveSettlementFailure(ctx?.error)) return;
  // Deliberately only the staged record is abandoned. Ambiguous outcomes keep
  // it pending so a retry cannot reach the paywall and pay twice; the
  // process-local reservation is not evidence that settlement failed.
  const responseBody = ctx?.transportContext?.responseBody ?? null;
  abandonSettlement(responseBody);
}

export function registerRecoveryHooks(resourceServer, { logError = console.error } = {}) {
  resourceServer.onAfterSettle(async (ctx) => {
    try {
      recoveryAfterSettle(ctx);
    } catch (e) {
      logError("[recovery] settlement result handling failed", e);
    }
  });
  resourceServer.onSettleFailure(async (ctx) => {
    try {
      recoverySettleFailure(ctx);
    } catch (e) {
      logError("[recovery] settlement failure handling failed", e);
    }
  });
  return resourceServer;
}
