// Central logging and redaction.
//
// Every runtime log line goes through this module. The goal is that an RPC URL
// path, query string, basic-auth credential, header value, API key, or
// idempotency key cannot reach stdout/stderr even when the source is a raw
// viem/HttpRequestError, a stack trace, or request metadata.
//
// The public error boundary already keeps these values out of HTTP responses.
// This module closes the other half: the log sink.

import { createHash } from "node:crypto";

const ORIGINAL = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

const SENSITIVE_KEY_RE =
  /^(?:x-payment|payment-signature|authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|secret|password|passwd|token|access[-_]?token|refresh[-_]?token|credential|private[-_]?key|idempotency[-_]?key|x-idempotency-key)$/i;
const IDEMPOTENCY_KEY_RE = /^(?:x-)?idempotency[-_]?key$/i;
const HEADER_OR_PARAM_RE =
  /(x-payment|payment-signature|authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|secret|password|passwd|access[-_]?token|refresh[-_]?token|private[-_]?key)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\n\r,;]+)/gi;
const IDEMPOTENCY_HEADER_RE =
  /(x-idempotency-key|idempotency-key)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

let installed = false;

function stripQuotes(value) {
  return String(value ?? "").replace(/^["']|["']$/g, "");
}

/** Stable 8-character hash prefix for a caller-supplied idempotency key. */
export function idempotencyPrefix(value) {
  if (value == null || String(value) === "") return null;
  return `idem:${createHash("sha256").update(String(value)).digest("hex").slice(0, 8)}`;
}

function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^(?:https?|wss?):$/i.test(u.protocol)) return raw;
    return `${u.protocol}//${u.host}/***`;
  } catch {
    // Best effort for malformed URLs: drop userinfo and everything after the
    // authority, but never echo the original path/query.
    return String(raw)
      .replace(/\/\/[^/@\s]+@/, "//")
      .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+).*$/i, "$1/***");
  }
}

/**
 * Redact a string. `idempotencyKey` is optional context: when the caller's key
 * is known, any literal occurrence is replaced with its 8-character hash
 * prefix instead of a generic marker.
 */
export function redactText(value, { idempotencyKey = null } = {}) {
  let s = String(value ?? "");
  if (idempotencyKey) {
    const key = String(idempotencyKey);
    s = s.split(key).join(idempotencyPrefix(key));
  }

  // Full URLs: keep scheme + host (including port), replace the rest.
  s = s.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (match) => {
    const trailing = match.match(/[),.;:!?]+$/)?.[0] ?? "";
    const core = trailing ? match.slice(0, -trailing.length) : match;
    return sanitizeUrl(core) + trailing;
  });

  // Idempotency keys get a stable 8-character hash prefix, not a generic
  // marker, so a replay can still be correlated without exposing the key.
  s = s.replace(IDEMPOTENCY_HEADER_RE, (match, key, sep, rawValue) => {
    const value = stripQuotes(rawValue);
    if (/^idem:[0-9a-f]{8}$/.test(value)) return match;
    return `${key}${sep}${idempotencyPrefix(value)}`;
  });

  // Other headers and key=value query parameters: redact the whole value.
  // This intentionally over-redacts an inline header line rather than risk
  // leaving a fragment of "Bearer <token>" or a multi-word credential behind.
  s = s.replace(HEADER_OR_PARAM_RE, (match, key, sep) => {
    return `${key}${sep}[REDACTED]`;
  });

  return s;
}

function safeStringify(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Error) return formatError(value);
  if (depth > 5) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((v) => safeStringify(v, depth + 1, seen));
    if (value.length > 50) out.push(`[+${value.length - 50} more]`);
    return `[${out.join(",")}]`;
  }
  const pairs = [];
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      pairs.push(`${JSON.stringify(key)}:${JSON.stringify(IDEMPOTENCY_KEY_RE.test(key) ? idempotencyPrefix(v) : "[REDACTED]")}`);
    } else {
      pairs.push(`${JSON.stringify(key)}:${safeStringify(v, depth + 1, seen)}`);
    }
  }
  return `{${pairs.join(",")}}`;
}

export function redactValue(value, { idempotencyKey = null } = {}) {
  if (value instanceof Error) return formatError(value, { idempotencyKey });
  if (typeof value === "string") return redactText(value, { idempotencyKey });
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, { idempotencyKey }));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = IDEMPOTENCY_KEY_RE.test(key)
        ? idempotencyPrefix(v)
        : "[REDACTED]";
    } else {
      out[key] = redactValue(v, { idempotencyKey });
    }
  }
  return out;
}

/** Format an Error without ever dumping its raw enumerable properties. */
export function formatError(error, { idempotencyKey = null } = {}) {
  if (error == null) return "";
  if (typeof error === "string") return redactText(error, { idempotencyKey });
  if (!(error instanceof Error)) {
    return redactText(safeStringify(error), { idempotencyKey });
  }

  const head = redactText(`${error.name || "Error"}: ${error.message || ""}`, { idempotencyKey });
  const cause = error.cause
    ? `\ncause: ${formatError(error.cause, { idempotencyKey })}`
    : "";
  const stack = error.stack
    ? `\n${redactText(error.stack, { idempotencyKey })}`
    : "";
  return `${head}${cause}${stack}`;
}

function emit(level, message, error = null, context = null) {
  const parts = [redactText(message)];
  if (context && typeof context === "object" && Object.keys(context).length) {
    parts.push(redactText(safeStringify(context)));
  }
  const detail = error == null ? "" : formatError(error);
  const line = `${parts.join(" ")}${detail ? `\n${detail}` : ""}`;
  // Use the current console method so tests and embedders can still capture
  // structured events. installConsoleRedaction() makes this idempotent.
  (console[level] || ORIGINAL[level])(line);
}

export function logInfo(message, error = null, context = null) {
  emit("log", message, error, context);
}

export function logWarn(message, error = null, context = null) {
  emit("warn", message, error, context);
}

export function logError(message, error = null, context = null) {
  emit("error", message, error, context);
}

/**
 * Defence in depth: wrap console.* so a future direct console call cannot dump
 * a raw Error or an unredacted URL. Safe to call more than once.
 */
export function installConsoleRedaction() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => {
      const safe = args.map((arg) =>
        arg instanceof Error
          ? formatError(arg)
          : typeof arg === "string"
            ? redactText(arg)
            : arg,
      );
      ORIGINAL[level](...safe);
    };
  }
}
