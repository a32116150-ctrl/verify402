// Free-gate usage telemetry. Deliberately tiny and anonymous:
// - no IP address, no request body, no intent, no wallet
// - persisted when a file path is configured (VERIFY402_USAGE_PATH, or a file
//   next to RECOVERY_DB_PATH); otherwise process-local and says so, like the
//   free Render instance that spins down loses it
// - structured stdout lines so the same events are visible in Render logs
// - client labels are self-declared or inferred; they are not identity
//
// This is a call counter, not an identity system. The free gate is walletless by
// design, so a call cannot prove a unique agent. The only identity-backed usage
// signal remains a paid settlement and its payer address.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logInfo, logWarn } from "./log.mjs";

const MAX_CLIENT_LENGTH = 64;
const MAX_KIND_LENGTH = 32;
// A public endpoint can receive arbitrary client labels. Bound the number of
// in-memory keys so unique header values cannot grow the process without limit.
const MAX_CLIENT_LABELS = 32;
const CLIENT_LABEL_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

// The ping endpoint accepts only tools that actually exist on the bridge.
// One list, shared by the server (boundary check) and this helper.
export const PINGABLE_TOOLS = Object.freeze([
  "preflight_gate",
  "inspect_402",
  "directory_402",
  "verify_arbitrage",
  "check_token_safety",
  "get_best_route",
  "verify_quote_fairness",
  "get_trade_depth",
]);

const SPEC = "verify402/usage@1";
const SAVE_DEBOUNCE_MS = 2000;

let startedAt = new Date().toISOString();
let firstAt = null;
let lastAt = null;
let total = 0;
let byVerdict = Object.create(null);
let byKind = Object.create(null);
let byTool = Object.create(null);
let byClient = Object.create(null);
let byClientSource = Object.create(null);
let byStatus = Object.create(null);
let filePath = null;
let saveTimer = null;
let dirty = false;
let saveFailed = false;

function snapshotNumbers(bucket) {
  const out = Object.create(null);
  if (!bucket || typeof bucket !== "object") return out;
  for (const [k, v] of Object.entries(bucket)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

function restore(payload) {
  if (!payload || payload.spec !== SPEC) return false;
  startedAt = text(payload.startedAt) || startedAt;
  firstAt = text(payload.firstAt) || firstAt;
  lastAt = text(payload.lastAt) || null;
  total = Math.max(0, Math.floor(Number(payload.total) || 0));
  byVerdict = snapshotNumbers(payload.byVerdict);
  byKind = snapshotNumbers(payload.byKind);
  byTool = snapshotNumbers(payload.byTool);
  byClient = snapshotNumbers(payload.byClient);
  byClientSource = snapshotNumbers(payload.byClientSource);
  byStatus = snapshotNumbers(payload.byStatus);
  return true;
}

function serialize() {
  return JSON.stringify({
    spec: SPEC,
    startedAt,
    firstAt,
    lastAt,
    total,
    byVerdict,
    byKind,
    byTool,
    byClient,
    byClientSource,
    byStatus,
    updatedAt: new Date().toISOString(),
  });
}

function writeSnapshotAtomic() {
  if (!filePath) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, serialize(), "utf8");
    renameSync(tmp, filePath);
    saveFailed = false;
  } catch (e) {
    // Analytics must never block a paid or free call. The counters keep
    // working in memory; a failure stays visible on /usage and /ready.
    saveFailed = true;
    logWarn("usage counters could not be written to disk; continuing process-local", e);
  }
}

function scheduleSave() {
  if (!filePath) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) writeSnapshotAtomic();
    dirty = false;
  }, SAVE_DEBOUNCE_MS);
  if (typeof saveTimer.unref === "function") saveTimer.unref();
}

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
  if (!firstAt) firstAt = at;
  lastAt = at;
  bump(byVerdict, event.verdict);
  bump(byKind, event.kind);
  bumpClient(event.client);
  bump(byClientSource, event.clientSource);
  bump(byStatus, event.status);
  scheduleSave();

  // One line per call. No body, no IP, no intent, no key.
  logInfo(JSON.stringify(event));
  return event;
}

// The MCP bridge reports one anonymous line per tool call when the operator
// opts in with VERIFY402_TELEMETRY=1. No intent, no arguments, no result.
export function recordToolPing({ tool, ok = true, client = "mcp", now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const safe = String(tool ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  if (!safe || !PINGABLE_TOOLS.includes(safe)) return null;
  const success = ok !== false;
  const label = normalizeDeclared(client) || "mcp";

  total += 1;
  if (!firstAt) firstAt = at;
  lastAt = at;
  bump(byKind, `mcp:${safe}`);
  bump(byTool, safe);
  bumpClient(label);
  bump(byClientSource, "mcp-ping");
  bump(byStatus, success ? 200 : 500);
  logInfo(JSON.stringify({ event: "verify402.mcp_ping", at, tool: safe, ok: success, client: label }));
  scheduleSave();
  return { tool: safe, ok: success };
}

export function usageSnapshot() {
  return {
    spec: "verify402/usage@1",
    scope: filePath ? "persisted; totals survive restart and deploy" : "this process instance; resets on restart or deploy",
    since: startedAt,
    firstAt,
    lastAt,
    total,
    mcpPings: Object.values(byTool).reduce((acc, n) => acc + n, 0),
    byVerdict: { ...byVerdict },
    byKind: { ...byKind },
    byTool: { ...byTool },
    byClient: { ...byClient },
    byClientSource: { ...byClientSource },
    byStatus: { ...byStatus },
    ...(filePath ? { file: filePath, saveFailed } : { file: null }),
    note:
      "Anonymous call counter. Client labels are self-declared via X-Verify402-Client or inferred from User-Agent; " +
      "they are not identities and can be spoofed. A call is not a unique agent: the free gate has no account or wallet. " +
      "The only identity-backed usage signal is a paid settlement and its payer address. " +
      "MCP-bridge pings are counted in byTool and byKind as mcp:<tool>; they carry no arguments, no intent, no result.",
  };
}

// Server boot: load persisted counters when a durable path is configured.
export function initUsage({ path: explicitPath } = {}) {
  const chosen =
    explicitPath ||
    process.env.VERIFY402_USAGE_PATH ||
    (process.env.RECOVERY_DB_PATH
      ? join(dirname(process.env.RECOVERY_DB_PATH), "usage.json")
      : null);
  filePath = chosen ? text(chosen) : null;
  if (!filePath) return { enabled: false, path: null };
  try {
    restore(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      logWarn(`usage file ${filePath} could not be read; starting a new window`, e);
      saveFailed = true;
    }
  }
  return { enabled: true, path: filePath };
}

export function flushUsage() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) writeSnapshotAtomic();
  dirty = false;
}

export function usageHealth() {
  return { enabled: Boolean(filePath), path: filePath, saveFailed };
}

// Test helper. Not called by the server.
export function resetUsage() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  saveFailed = false;
  filePath = null;
  startedAt = new Date().toISOString();
  firstAt = null;
  lastAt = null;
  total = 0;
  byVerdict = Object.create(null);
  byKind = Object.create(null);
  byTool = Object.create(null);
  byClient = Object.create(null);
  byClientSource = Object.create(null);
  byStatus = Object.create(null);
}
