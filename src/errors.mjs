// Public error boundary.
//
// Every response that fails for an internal reason goes through this module.
// The caller gets a stable public code plus a request id; the detail (which may
// contain an RPC URL, an API key, a provider message, or a stack) is written to
// the server log under the SAME request id. Nothing from viem, a transport, or
// an upstream provider is ever echoed in a response body.
//
// Public codes are deliberately small and stable:
//   bad_request       400  the caller's input is wrong (specific `code` included)
//   rate_limited      429  too many requests
//   busy              429  too many concurrent requests
//   rpc_unavailable   503  the chain/provider could not be read
//   rpc_rate_limited  503  the provider rate-limited us
//   internal_error    500/503  anything else; a decode failure that aborts a
//                              measurement is 503 so the caller is not charged,
//                              and the original message is never echoed

import { randomUUID } from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function requestIdFor(req) {
  return req?.requestId || randomUUID();
}

export function requestIdMiddleware(req, res, next) {
  const incoming = String(req.get("x-request-id") || "").trim();
  req.requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  res.set("x-request-id", req.requestId);
  next();
}

const TRANSPORT_RE = /timeout|timed out|fetch failed|network error|econn|enotfound|eai_again|socket hang up|connection (?:refused|reset)|http request failed|502|503|504/i;
const RATE_LIMIT_RE = /rate limit|too many requests|429/i;

/**
 * Classify an exception without ever returning its message to a caller.
 * Unknown errors fail closed as internal_error.
 */
export function classifyError(error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const msg = error == null ? "" : String(error.message || error);
  if (RATE_LIMIT_RE.test(msg)) {
    return { status: 503, code: "rpc_rate_limited", message: "the chain provider rate-limited this request; no verdict was issued" };
  }
  if (TRANSPORT_RE.test(msg) || error?.name === "TimeoutError" || error?.name === "HttpRequestError") {
    return { status: 503, code: "rpc_unavailable", message: "the chain could not be read; no verdict was issued and no settlement should occur" };
  }
  return { status: 500, code: "internal_error", message: "the request could not be completed; no verdict was issued" };
}

export function sendPublicError(req, res, status, code, message, {
  log = null,
  extra = {},
} = {}) {
  const requestId = requestIdFor(req);
  if (log) {
    // Server-side only. The request id ties the public response to this line.
    console.error(`[error ${requestId}] ${code}:`, log);
  }
  res.set("Cache-Control", "no-store");
  res.set("x-request-id", requestId);
  return res.status(status).json({ error: code, message, requestId, ...extra });
}

export function sendClassifiedError(req, res, error, { extra = {} } = {}) {
  const c = classifyError(error);
  return sendPublicError(req, res, c.status, c.code, c.message, { log: error, extra });
}

/** Wrap a route so unexpected exceptions still produce a sanitized response. */
export function sanitizedRoute(route, handler) {
  return async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (error) {
      if (res.headersSent) return next(error);
      return sendClassifiedError(req, res, error, { extra: route ? { route } : {} });
    }
  };
}
