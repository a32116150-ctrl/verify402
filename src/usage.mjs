// Free-gate usage telemetry. Deliberately tiny and anonymous:
// - no IP address, no request body, no intent, no wallet
// - in-memory only; a restart starts a new window (Render has no durable disk)
// - structured stdout lines so the same events are visible in Render logs
// - client labels are self-declared or inferred; they are not identity
//
// This is a call counter, not an identity system. The free gate is walletless by
// design, so a call cannot prove a unique agent. The only identity-backed usage
// signal remains a paid settlement and its payer address.

import { logInfo } from "./log.mjs";

const MAX_CLIENT_LENGTH = 64;
const MAX_KIND_LENGTH = 32;
// A public endpoint can receive arbitrary client labels. Bound the number of
// in-memory keys so unique header values cannot grow the process without limit.
const MAX_CLIENT_LABELS = 32;
const CLIENT_LABEL_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

let startedAt = new Date().toISOString();
let lastAt = null;
let total = 0;
let byVerdict = Object.create(null);
let byKind = Object.create(null);
let byClient = Object.create(null);
let byClientSource = Object.create(null);
let byStatus = Object.create(null);

function bump(bucket, key) {
  const k = String(key || "unknown").slice(0, MAX_CLIENT_LENGTH) || "unknown";
  bucket[k] = (bucket[k] || 0) + 1;
}

function bumpClient(key) {
  const k = String(key || "unknown").slice(0, MAX_CLIENT_LENGTH) || "unknown";
  if (!(k in byClient) && Object.keys(byClient).length >= MAX_CLIENT_LABELS - 1 && k !== "other") {
    byClient.other = (byClient.other || 0) + 1;
    return;
  }
  byClient[k] = (byClient[k] || 0) + 1;
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizeDeclared(value) {
  const v = text(value).toLowerCase();
  if (!v) return null;
  if (!CLIENT_LABEL_RE.test(v)) return "other";
  return v;
}

function userAgentClient(ua) {
  if (!ua) return "unknown";
  const mcp = /(?:^|[^a-z0-9])verify402-mcp\/([0-9][0-9a-z.+-]{0,31})/.exec(ua);
  if (mcp) return `mcp/${mcp[1]}`.slice(0, MAX_CLIENT_LENGTH);
  if (ua.includes("verify402-mcp")) return "mcp";
  if (ua.includes("python")) return "python";
  if (ua.includes("axios") || ua.includes("node-fetch") || ua.includes("node")) return "node";
  if (ua.includes("curl")) return "curl";
  if (ua.includes("wget")) return "wget";
  if (ua.includes("mozilla")) return "browser";
  return "other";
}

export function clientInfo(req) {
  const declared = normalizeDeclared(req?.get?.("x-verify402-client"));
  if (declared) return { label: declared, source: "declared" };
  const ua = text(req?.get?.("user-agent")).toLowerCase();
  return { label: userAgentClient(ua), source: ua ? "user-agent" : "unknown" };
}

export function clientLabel(req) {
  return clientInfo(req).label;
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
  const client = clientInfo(req);
  const event = {
    event: "verify402.preflight",
    at,
    client: client.label,
    clientSource: client.source,
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
  bumpClient(event.client);
  bump(byClientSource, event.clientSource);
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
    byClientSource: { ...byClientSource },
    byStatus: { ...byStatus },
    note:
      "Free-gate calls only. Client labels are self-declared via X-Verify402-Client or inferred from User-Agent; " +
      "they are not identities and can be spoofed. A call is not a unique agent: the free gate has no account or wallet. " +
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
  byClientSource = Object.create(null);
  byStatus = Object.create(null);
}
