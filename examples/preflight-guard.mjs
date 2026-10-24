// Reference preflight executor.
//
// The gate is only useful if something refuses to sign without it. This module
// is the smallest honest version of that refusal: it calls POST /preflight,
// rejects BLOCK (and CAUTION without an explicit acknowledgement), verifies the
// receipt with POST /preflight/verify, checks that the receipt is bound to the
// same intent, and only then calls the signer you supply.
//
// It is deliberately not a wallet. It holds no key, it cannot send a
// transaction, and it cannot stop a signer that ignores its arguments. The
// enforcement is the ordering: sign() is unreachable until the checks pass.
//
// Trust boundary: the receipt is HMAC-signed by the verify402 instance and
// checked through its free /preflight/verify endpoint. If you do not want to
// trust the public instance, run your own and pin `baseUrl` to it. A PASS is
// not a guarantee of safety; it means the checks listed in the response passed
// at that block. Read `notChecked` before you treat it as more.
//
// Receipt verification is mandatory. There is deliberately no `verify:false`
// switch: a caller-controlled option must not be able to reach the signer
// without the receipt and both bindings being checked.

import { preflightRequestHash } from "../src/preflight.mjs";

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export class PreflightGuardError extends Error {
  constructor(message, { verdict = null, reasons = [], response = null, status = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.verdict = verdict;
    this.reasons = reasons;
    this.response = response;
    this.status = status;
  }
}

export class PreflightBlockedError extends PreflightGuardError {}
export class PreflightUnavailableError extends PreflightGuardError {}

async function requestJson(fetchImpl, baseUrl, path, body, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(new URL(path, baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new PreflightUnavailableError(`preflight request failed: ${e.message}`, { status: null });
  }

  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw new PreflightUnavailableError(`preflight response could not be read: ${e.message}`, { status: res.status });
  }

  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok || parsed == null) {
    const detail = parsed?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new PreflightUnavailableError(`preflight returned ${res.status}: ${detail}`, {
      status: res.status,
      response: parsed,
    });
  }
  return parsed;
}

/**
 * Convert an x402 v2 challenge plus its selected requirement into the payment
 * intent the free gate expects. This is deliberately local: the hook never
 * trusts the 402 to name a different resource, payee, asset, or amount than the
 * one the caller is about to sign.
 *
 * @param {object} options
 * @param {object} options.paymentRequired  The decoded 402 challenge.
 * @param {object} options.requirements     The selected requirement (defaults to accepts[0]).
 * @param {string} [options.from]           Payer address, for simulation/balance checks.
 * @returns {object} preflight intent
 */
export function x402PaymentIntent({ paymentRequired, requirements, from } = {}) {
  if (!paymentRequired || typeof paymentRequired !== "object" || Array.isArray(paymentRequired)) {
    throw new TypeError("paymentRequired must be an x402 challenge object");
  }
  const selected = requirements ?? paymentRequired.accepts?.[0];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw new TypeError("the x402 challenge has no selected payment requirement");
  }
  const amount = selected.amount ?? selected.maxAmountRequired;
  if (selected.scheme == null || selected.network == null || selected.asset == null || selected.payTo == null || amount == null) {
    throw new TypeError("the selected requirement is missing scheme/network/asset/payTo/amount");
  }

  const resource = paymentRequired.resource?.url ?? paymentRequired.resource;
  const payment = {
    scheme: String(selected.scheme),
    network: String(selected.network),
    asset: String(selected.asset),
    amount: String(amount),
    payTo: String(selected.payTo),
    ...(resource ? { resource: String(resource) } : {}),
    ...(selected.maxTimeoutSeconds != null ? { maxTimeoutSeconds: selected.maxTimeoutSeconds } : {}),
  };
  const extra = {};
  for (const key of ["validAfter", "validBefore", "facilitator"]) {
    if (selected.extra?.[key] != null) extra[key] = selected.extra[key];
  }
  if (Object.keys(extra).length > 0) payment.extra = extra;

  const chain = /^eip155:(\d+)$/.exec(String(selected.network));
  return {
    kind: "payment",
    ...(chain ? { chainId: Number(chain[1]) } : {}),
    ...(from ? { from: String(from) } : {}),
    payment,
  };
}

/**
 * Guard a signature with the free preflight gate.
 *
 * @param {object} options
 * @param {object} options.intent       The payment or transaction intent.
 * @param {object} [options.policy]     Optional operator policy (caps/allowlists).
 * @param {Function} options.sign       Your signer. Called only after the checks pass.
 * @param {string} [options.baseUrl]    verify402 instance (default: public mainnet).
 * @param {boolean} [options.acknowledgeCaution] Must be true to sign a CAUTION.
 * @param {Function} [options.fetchImpl] Injected fetch (tests / custom runtime).
 * @param {number} [options.timeoutMs]  Per-request timeout (default 70s).
 * @returns {Promise<{verdict: string, receipt: object, result: any, response: object}>}
 */
export async function guardAndSign(options = {}) {
  const {
    intent,
    policy,
    sign,
    baseUrl = "https://verify402.onrender.com",
    acknowledgeCaution = false,
    fetchImpl = globalThis.fetch,
    timeoutMs = 70_000,
  } = options;

  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw new TypeError("intent must be an object");
  }
  if (typeof sign !== "function") throw new TypeError("sign must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable; pass fetchImpl");

  // Freeze exactly what will be gated, then give that same object to the
  // signer. A caller that mutates the intent after the gate cannot silently
  // sign something the receipt never covered.
  const frozenIntent = deepFreeze(clone(intent));
  // Keep the exact body sent to the gate. The receipt signs a hash of it, so
  // verification can bind the receipt to the caller's request without
  // reimplementing the gate's canonicalisation.
  const preflightBody = { ...frozenIntent, policy };
  const pre = await requestJson(fetchImpl, baseUrl, "/preflight", preflightBody, timeoutMs);

  if (pre.verdict === "BLOCK" || pre.sign_allowed !== true) {
    throw new PreflightBlockedError(pre.summary || "preflight returned BLOCK; do not sign", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }
  if (pre.verdict === "CAUTION" && acknowledgeCaution !== true) {
    throw new PreflightBlockedError(
      "preflight returned CAUTION; read the reasons and pass acknowledgeCaution:true to proceed",
      { verdict: pre.verdict, reasons: pre.reasons, response: pre },
    );
  }
  if (pre.verdict !== "PASS" && pre.verdict !== "CAUTION") {
    throw new PreflightBlockedError(`unknown preflight verdict ${String(pre.verdict)}`, {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }
  if (!pre.receipt || typeof pre.receipt !== "object") {
    throw new PreflightBlockedError("preflight returned no receipt; do not sign", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }

  const expiresAt = Date.parse(pre.receipt.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new PreflightBlockedError("preflight receipt is expired; call the gate again", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }

  if (!pre.intent || typeof pre.intent !== "object" || Array.isArray(pre.intent)) {
    throw new PreflightBlockedError("preflight returned no canonical intent; cannot bind the receipt", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }

  // Recompute the request binding locally. The remote verifier can only say
  // "bound"; it must not be able to override a receipt that names bytes other
  // than the ones this caller actually sent.
  let localRequestHash;
  try {
    localRequestHash = preflightRequestHash(preflightBody);
  } catch {
    throw new PreflightBlockedError("preflight request body cannot be canonicalised; do not sign", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }
  if (pre.receipt.requestHash !== localRequestHash) {
    throw new PreflightBlockedError("receipt request hash does not match the request sent to the gate", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }

  const checked = await requestJson(fetchImpl, baseUrl, "/preflight/verify", {
    receipt: pre.receipt,
    intent: pre.intent,
    request: preflightBody,
  }, timeoutMs);
  if (checked.valid !== true) {
    throw new PreflightBlockedError(`receipt verification failed: ${checked.reason || "invalid"}`, {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }
  if (checked.intentBound !== true || checked.requestBound !== true) {
    throw new PreflightBlockedError("receipt was not bound to this caller's intent/request", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }
  if (checked.requestHash !== localRequestHash) {
    throw new PreflightBlockedError("receipt request hash does not match the request sent to the gate", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }
  if (checked.intentHash !== pre.intentHash) {
    throw new PreflightBlockedError("receipt intent hash does not match the verdict", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }
  if (checked.kind !== pre.kind || checked.verdict !== pre.verdict) {
    throw new PreflightBlockedError("receipt kind/verdict does not match the verdict", {
      verdict: pre.verdict, reasons: pre.reasons, response: pre,
    });
  }

  const result = await sign(frozenIntent, { receipt: pre.receipt, verdict: pre.verdict, response: pre });
  return { verdict: pre.verdict, receipt: pre.receipt, result, response: pre };
}

/**
 * Guard an x402 payment directly, without wiring a client hook.
 *
 * @param {object} options
 * @param {object} options.paymentRequired  The decoded 402 challenge.
 * @param {object} [options.requirements]   Selected requirement (defaults to accepts[0]).
 * @param {object} [options.policy]         Gate policy (caps/allowlists).
 * @param {string} [options.from]           Payer address.
 * @param {string} [options.baseUrl]        verify402 instance.
 * @param {boolean} [options.acknowledgeCaution]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{verdict: string, receipt: object, response: object}>}
 */
export async function guardX402Payment(options = {}) {
  const {
    paymentRequired,
    requirements,
    policy,
    from,
    baseUrl = "https://verify402.onrender.com",
    acknowledgeCaution = false,
    fetchImpl = globalThis.fetch,
    timeoutMs = 70_000,
  } = options;
  const intent = x402PaymentIntent({ paymentRequired, requirements, from });
  const gate = await guardAndSign({
    intent,
    policy,
    sign: async () => ({}),
    baseUrl,
    acknowledgeCaution,
    fetchImpl,
    timeoutMs,
  });
  return { verdict: gate.verdict, receipt: gate.receipt, response: gate.response };
}

/**
 * One-line x402 auto-guard for `x402Client.onBeforePaymentCreation`.
 *
 * The hook blocks on BLOCK, refuses CAUTION unless `acknowledgeCaution` is
 * true, verifies the receipt and both bindings, then writes the verified
 * receipt to `context.verify402` before the SDK can sign. The same context is
 * passed to `onAfterPaymentCreation`, so a caller can attach or log the receipt
 * without re-running the gate. `onVerified` receives the same attachment.
 *
 * @param {object} [options]
 * @param {object} [options.policy]
 * @param {string} [options.baseUrl]
 * @param {string} [options.from]
 * @param {boolean} [options.acknowledgeCaution]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.onVerified]
 * @param {Function} [options.onBlocked]
 * @returns {(context: {paymentRequired: object, selectedRequirements: object}) => Promise<void | {abort: true, reason: string}>}
 */
export function createX402PreflightHook(options = {}) {
  const {
    policy,
    baseUrl = "https://verify402.onrender.com",
    from,
    acknowledgeCaution = false,
    fetchImpl = globalThis.fetch,
    timeoutMs = 70_000,
    onVerified,
    onBlocked,
  } = options;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable; pass fetchImpl");

  return async function preflightHook(context) {
    let intent;
    try {
      intent = x402PaymentIntent({
        paymentRequired: context?.paymentRequired,
        requirements: context?.selectedRequirements,
        from,
      });
    } catch (e) {
      return { abort: true, reason: `x402 preflight intent: ${e.message}` };
    }

    try {
      const gate = await guardAndSign({
        intent,
        policy,
        sign: async () => ({}),
        baseUrl,
        acknowledgeCaution,
        fetchImpl,
        timeoutMs,
      });
      const attachment = {
        receipt: gate.receipt,
        verdict: gate.verdict,
        response: gate.response,
      };
      if (context && typeof context === "object") context.verify402 = attachment;
      if (typeof onVerified === "function") await onVerified({ ...attachment, context });
      return;
    } catch (e) {
      if (typeof onBlocked === "function") await onBlocked(e, context);
      return { abort: true, reason: e.message };
    }
  };
}
