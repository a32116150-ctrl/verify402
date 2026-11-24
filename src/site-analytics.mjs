// First-party, aggregate page-view counting.
//
// What this is: how many times the site's HTML pages were served, by path,
// by referring host, and by day. It answers one question the project could not
// answer before: is anyone actually reaching the pages the funnel points at?
//
// What this is NOT:
// - not unique visitors (no cookie, no fingerprint, no IP address is stored)
// - not a session or identity system
// - not a replacement for a paid settlement, which is the only identity-backed
//   usage signal the product has
//
// Honesty rules, in the same spirit as src/usage.mjs:
// - no IP, no query string, no header beyond User-Agent and Referer
// - User-Agent is used only to skip obvious crawlers/monitors, then discarded
// - query strings are dropped before the path is counted (a query can carry a
//   token or an email address)
// - crawler skips are counted and published, so the numbers are not silently
//   inflated or deflated
//
// Persistence: when SITE_ANALYTICS_PATH is set, or RECOVERY_DB_PATH is set
// (same durable disk), counters are written to a small JSON file and survive a
// restart or deploy. Without either, they are process-local and say so — a
// free Render instance that spins down loses them.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logWarn } from "./log.mjs";

const SPEC = "verify402/site-analytics@1";
const MAX_PATHS = 96;
const MAX_REFERRERS = 24;
const MAX_DAYS = 60;
const MAX_PATH_LENGTH = 96;
const SAVE_DEBOUNCE_MS = 2000;

const PAGE_PATH_RE = /^\/[a-z0-9\-._~/]*$/i;

// Crawlers, uptime monitors, and HTTP clients are not readers. Matching is
// deliberately conservative: a false skip only undercounts, while counting
// bots would tell a story the traffic does not support.
const BOT_RE =
  /(bot\b|crawler|spider|slurp|scrapy|headlesschrome|phantomjs|lighthouse|pagespeed|gtmetrix|uptime|pingdom|statuscake|monitor|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx\/|axios\/|node-fetch|undici|go-http-client|java\/|okhttp|libwww|httpclient)/i;

let startedAt = new Date().toISOString();
let firstAt = null;
let lastAt = null;
let total = 0;
let byPath = Object.create(null);
let byReferrer = Object.create(null);
let byDay = Object.create(null);
let skipped = Object.create(null);
let filePath = null;
let saveTimer = null;
let dirty = false;
let saveFailed = false;

function text(value) {
  return String(value ?? "").trim();
}

function normalizePath(value) {
  let path = text(value).split("?")[0].split("#")[0] || "/";
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  if (!PAGE_PATH_RE.test(path)) return "/other";
  return path.slice(0, MAX_PATH_LENGTH);
}

function referrerHost(value) {
  const raw = text(value);
  if (!raw) return "direct";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "other";
    return (url.hostname || "other").toLowerCase().slice(0, 80);
  } catch {
    return "other";
  }
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function bump(bucket, key, cap) {
  const k = text(key) || "unknown";
  if (!(k in bucket) && Object.keys(bucket).length >= cap - 1 && k !== "other") {
    bucket.other = (bucket.other || 0) + 1;
    return;
  }
  bucket[k] = (bucket[k] || 0) + 1;
}

function skip(reason) {
  skipped[reason] = (skipped[reason] || 0) + 1;
}

// A page view is a successful GET that produced HTML. JSON discovery, assets,
// the 402 challenges and error pages are not page views by construction.
export function isPageView({ method, status, contentType } = {}) {
  if (method !== "GET") return false;
  if (Number(status) !== 200) return false;
  return text(contentType).toLowerCase().includes("text/html");
}

export function recordPageView({ path, referrer, userAgent, now = Date.now() } = {}) {
  const ua = text(userAgent);
  if (!ua) {
    skip("no_user_agent");
    return null;
  }
  if (BOT_RE.test(ua)) {
    skip("crawler_or_client");
    return null;
  }
  const at = new Date(now).toISOString();
  const view = {
    path: normalizePath(path),
    referrer: referrerHost(referrer),
    day: dayKey(now),
  };

  total += 1;
  if (!firstAt) firstAt = at;
  lastAt = at;
  bump(byPath, view.path, MAX_PATHS);
  bump(byReferrer, view.referrer, MAX_REFERRERS);
  bump(byDay, view.day, MAX_DAYS);
  scheduleSave();
  return view;
}

// Express middleware. Registered before the static handler; it listens for the
// response finish event, so it never delays or alters the response.
export function siteAnalyticsMiddleware(req, res, next) {
  res.on("finish", () => {
    if (!isPageView({ method: req.method, status: res.statusCode, contentType: res.getHeader("content-type") })) return;
    recordPageView({
      path: req.path,
      referrer: req.get("referer"),
      userAgent: req.get("user-agent"),
    });
  });
  next();
}

function trimmedBucket(bucket, max) {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, max);
  return Object.fromEntries(entries);
}

export function siteAnalyticsSnapshot() {
  return {
    spec: SPEC,
    scope: filePath
      ? "durable-single-instance; survives restart, one server process per file"
      : "process-local; resets on restart or deploy",
    since: startedAt,
    firstAt,
    lastAt,
    total,
    byPath: { ...byPath },
    byReferrer: { ...byReferrer },
    byDay: trimmedBucket(byDay, MAX_DAYS),
    skipped: { ...skipped },
    note:
      "Aggregate counts of HTML pages served. No cookies, no IP addresses, no query strings, no per-visitor identifiers. " +
      "Crawlers and HTTP clients are skipped by User-Agent and the skip counts are reported. " +
      "These are views, not unique visitors, and they are not an identity or a payment signal. " +
      "The only identity-backed usage signal is a paid settlement and its payer address.",
  };
}

// ------------------------------------------------------------------ storage --

function savePath() {
  return filePath;
}

function scheduleSave() {
  if (!filePath) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSiteAnalytics();
  }, SAVE_DEBOUNCE_MS);
  // A pending flush must not keep the process alive.
  saveTimer.unref?.();
}

export function flushSiteAnalytics() {
  const target = savePath();
  if (!target || !dirty) return { saved: false, path: target };
  const payload = {
    spec: SPEC,
    savedAt: new Date().toISOString(),
    startedAt,
    firstAt,
    lastAt,
    total,
    byPath,
    byReferrer,
    byDay,
    skipped,
  };
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
    dirty = false;
    saveFailed = false;
    return { saved: true, path: target };
  } catch (e) {
    saveFailed = true;
    logWarn(`site analytics could not be persisted to ${target}; counts stay in memory`, e);
    return { saved: false, path: target, error: e };
  }
}

function restore(payload) {
  if (!payload || payload.spec !== SPEC) return false;
  const numbers = (bucket) => {
    const out = Object.create(null);
    if (!bucket || typeof bucket !== "object") return out;
    for (const [k, v] of Object.entries(bucket)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
    }
    return out;
  };
  startedAt = text(payload.startedAt) || new Date().toISOString();
  firstAt = text(payload.firstAt) || null;
  lastAt = text(payload.lastAt) || null;
  total = Math.max(0, Math.floor(Number(payload.total) || 0));
  byPath = numbers(payload.byPath);
  byReferrer = numbers(payload.byReferrer);
  byDay = numbers(payload.byDay);
  skipped = numbers(payload.skipped);
  return true;
}

export function initSiteAnalytics({ path: explicitPath } = {}) {
  const chosen =
    explicitPath ||
    process.env.SITE_ANALYTICS_PATH ||
    (process.env.RECOVERY_DB_PATH
      ? join(dirname(process.env.RECOVERY_DB_PATH), "site-analytics.json")
      : null);
  filePath = chosen ? text(chosen) : null;
  if (!filePath) return { enabled: false, path: null };
  try {
    restore(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (e) {
    // A missing file is normal on first boot. A corrupt one is logged and
    // replaced with a fresh window; analytics must never block the service.
    if (e?.code !== "ENOENT") logWarn(`site analytics file ${filePath} could not be read; starting a new window`, e);
  }
  return { enabled: true, path: filePath };
}

// Test helper. Not called by the server in production.
export function resetSiteAnalytics() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  saveFailed = false;
  filePath = null;
  startedAt = new Date().toISOString();
  firstAt = null;
  lastAt = null;
  total = 0;
  byPath = Object.create(null);
  byReferrer = Object.create(null);
  byDay = Object.create(null);
  skipped = Object.create(null);
}

export function siteAnalyticsHealth() {
  return { enabled: Boolean(filePath), path: filePath, saveFailed };
}
