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

import { promoteSettlement, abandonSettlement, markSettling } from "./recovery.mjs";

// Only a real pending result is ambiguous. The other two strings the SDK uses
// as fallbacks ("Settlement failed", "unknown reason") still come from an
// explicit facilitator failure response, so they are definitive here.
const NON_DEFINITIVE_REASONS = new Set([
  "settlement_pending",
]);

// The server's SettleError is a distinct class from the one exported by
// @x402/core/types (both bundles define their own copy), and our FacilitatorClient
// wraps thrown SDK errors in FacilitatorResponseError with the original in
// `cause`. Identify the actual settle failure by shape anywhere in that chain.
function findSettleError(error) {
  let current = error;
  while (current && typeof current === "object") {
    if (current.name === "SettleError"
        && typeof current.statusCode === "number"
        && typeof current.errorReason === "string"
        && "transaction" in current) return current;
    current = current.cause;
  }
  return null;
}

export function isDefinitiveSettlementFailure(error) {
  const settleError = findSettleError(error);
  if (!settleError) return false;

  const reason = settleError.errorReason.trim();
  if (!reason || NON_DEFINITIVE_REASONS.has(reason)) return false;

  // A transaction hash means value may already be moving on-chain. Even a
  // failed-looking result is ambiguous then; never abandon the staged record.
  if (typeof settleError.transaction === "string" && settleError.transaction.trim()) return false;

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

/**
 * Write-ahead settlement boundary (spec 0.9, §5.1(7) / control 11).
 *
 * Runs immediately BEFORE the facilitator call. Records `settling` on the
 * operation so a crash between here and `onAfterSettle` cannot leave a record
 * that reads as never-attempted — that record is the only copy of the paid
 * response and must never be evictable on a timer.
 *
 * Returns `{ abort, reason, message }` when the record cannot be written or the
 * attempt is ambiguous. Aborting keeps the caller from paying for an
 * unrecorded settlement; the staged record still exists, so the caller's retry
 * is answered `409 operation_in_flight` rather than charged again.
 */
export function recoveryBeforeSettle(ctx, { logWarn = console.warn } = {}) {
  if (ctx?.phase !== "after-handler") return null;
  try {
    const result = markSettling(ctx);
    if (result?.matched === 0 && result.hadUnresolved) {
      // An unresolved record existed and this settlement did not match it:
      // the payload shape is one we cannot attribute. Counted and logged.
      logWarn("[recovery] a settlement could not be attributed to any unresolved operation");
    }
    return null;
  } catch (e) {
    logWarn(`[recovery] refusing to settle without a recorded attempt: ${e?.message ?? e}`);
    return {
      abort: true,
      reason: "settling_write_failed",
      message: "the settlement attempt could not be durably recorded; retry the same payment with the same idempotency key",
    };
  }
}

export function registerRecoveryHooks(resourceServer, { logError = console.error } = {}) {
  resourceServer.onBeforeSettle(async (ctx) => {
    // No try/catch: an abort here is the point. An exception inside the hook
    // is the SDK's business; this function returns a typed abort instead.
    return recoveryBeforeSettle(ctx);
  });
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
