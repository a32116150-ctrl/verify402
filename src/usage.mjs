// Free-gate usage telemetry. Deliberately tiny and anonymous:
// - no IP address, no request body, no intent, no wallet
// - in-memory only; a restart starts a new window (Render has no durable disk)
// - structured stdout lines so the same events are visible in Render logs
//
// This is a call counter, not an identity system. The free gate is walletless by
// design, so a call cannot prove a unique agent. The only identity-backed usage
// signal remains a paid settlement and its payer address.

import { logInfo } from "./log.mjs";

const MAX_CLIENT_LENGTH = 64;
const MAX_KIND_LENGTH = 32;

let startedAt = new Date().toISOString();
let lastAt = null;
let total = 0;
let byVerdict = Object.create(null);
let byKind = Object.create(null);
let byClient = Object.create(null);
let byStatus = Object.create(null);

function bump(bucket, key) {
  const k = String(key || "unknown").slice(0, MAX_CLIENT_LENGTH) || "unknown";
  bucket[k] = (bucket[k] || 0) + 1;
}

function text(value) {
  return String(value ?? "").trim();
}

export function clientLabel(req) {
  const declared = text(req?.get?.("x-verify402-client")).toLowerCase();
  if (declared) return declared.slice(0, MAX_CLIENT_LENGTH);

  const ua = text(req?.get?.("user-agent")).toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("verify402-mcp")) return "mcp";
  if (ua.includes("python")) return "python";
  if (ua.includes("axios") || ua.includes("node-fetch") || ua.includes("node")) return "node";
  if (ua.includes("curl")) return "curl";
  if (ua.includes("wget")) return "wget";
  if (ua.includes("mozilla")) return "browser";
  return "other";
}

function normalizeKind(value) {
  const kind = text(value).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, MAX_KIND_LENGTH);
  return kind || "unknown";
}

function normalizeVerdict(value, status) {
  const verdict = text(value).toUpperCase();
  if (verdict === "PASS" || verdict === "CAUTION" || verdict === "BLOCK") return verdict;
  return Number(status) >= 500 ? "UNAVAILABLE" : "ERROR";
}

export function recordPreflight({ req, result, status = 200, ms = 0, code, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const event = {
    event: "verify402.preflight",
    at,
    client: clientLabel(req),
    kind: normalizeKind(result?.kind),
    verdict: normalizeVerdict(result?.verdict, status),
    status: Number.isInteger(Number(status)) ? Number(status) : 0,
    ms: Math.max(0, Math.round(Number(ms) || 0)),
    receipt: Boolean(result?.receipt),
    ...(code ? { code: text(code).slice(0, 48) } : {}),
  };

  total += 1;
  lastAt = at;
  bump(byVerdict, event.verdict);
  bump(byKind, event.kind);
  bump(byClient, event.client);
  bump(byStatus, event.status);

  // One line per call. No body, no IP, no intent, no key.
  logInfo(JSON.stringify(event));
  return event;
}

export function usageSnapshot() {
  return {
    spec: "verify402/usage@1",
    scope: "this process instance; resets on restart or deploy",
    since: startedAt,
    lastAt,
    total,
    byVerdict: { ...byVerdict },
    byKind: { ...byKind },
    byClient: { ...byClient },
    byStatus: { ...byStatus },
    note:
      "Free-gate calls only. A call is not a unique agent: the free gate has no account or wallet. " +
      "The only identity-backed usage signal is a paid settlement and its payer address.",
  };
}

// Test helper. Not called by the server.
export function resetUsage() {
  startedAt = new Date().toISOString();
  lastAt = null;
  total = 0;
  byVerdict = Object.create(null);
  byKind = Object.create(null);
  byClient = Object.create(null);
  byStatus = Object.create(null);
}
