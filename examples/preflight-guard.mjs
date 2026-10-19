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
 * @param {boolean} [options.verify]    Verify the receipt (default true).
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
    verify = true,
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
  const pre = await requestJson(fetchImpl, baseUrl, "/preflight", { ...frozenIntent, policy }, timeoutMs);

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

  if (verify) {
    const checked = await requestJson(fetchImpl, baseUrl, "/preflight/verify", { receipt: pre.receipt }, timeoutMs);
    if (checked.valid !== true) {
      throw new PreflightBlockedError(`receipt verification failed: ${checked.reason || "invalid"}`, {
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
  }

  const result = await sign(frozenIntent, { receipt: pre.receipt, verdict: pre.verdict, response: pre });
  return { verdict: pre.verdict, receipt: pre.receipt, result, response: pre };
}
