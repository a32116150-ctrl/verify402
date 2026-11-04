// Site analytics: aggregate page views, no cookies, no IP, honest scope.
// Run directly (node test/site-analytics.test.mjs) like the other offline tests.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPageView, recordPageView, siteAnalyticsSnapshot,
  initSiteAnalytics, flushSiteAnalytics, resetSiteAnalytics, siteAnalyticsHealth,
} from "../src/site-analytics.mjs";

const dir = mkdtempSync(join(tmpdir(), "verify402-analytics-"));
const file = join(dir, "site-analytics.json");

try {
  resetSiteAnalytics();

  // Only a successful GET that produced HTML is a page view.
  assert.equal(isPageView({ method: "GET", status: 200, contentType: "text/html; charset=utf-8" }), true);
  assert.equal(isPageView({ method: "POST", status: 200, contentType: "text/html" }), false);
  assert.equal(isPageView({ method: "GET", status: 404, contentType: "text/html" }), false);
  assert.equal(isPageView({ method: "GET", status: 200, contentType: "application/json" }), false);

  // Crawlers and HTTP clients are skipped and the skip is counted.
  assert.equal(recordPageView({ path: "/", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" }), null);
  assert.equal(recordPageView({ path: "/pricing", userAgent: "curl/8.7.1" }), null);
  assert.equal(recordPageView({ path: "/x", userAgent: "" }), null);
  let snap = siteAnalyticsSnapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.skipped.crawler_or_client, 2);
  assert.equal(snap.skipped.no_user_agent, 1);

  // A real browser view is counted; query strings and fragments are dropped.
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
  const view = recordPageView({
    path: "/preflight?intent=0xSECRETTOKEN#try",
    referrer: "https://news.ycombinator.com/item?id=1",
    userAgent: ua,
    now: Date.parse("2026-11-01T10:00:00Z"),
  });
  assert.deepEqual(view, { path: "/preflight", referrer: "news.ycombinator.com", day: "2026-11-01" });

  recordPageView({ path: "/", referrer: "", userAgent: ua, now: Date.parse("2026-11-01T10:01:00Z") });
  recordPageView({ path: "/", referrer: "https://www.google.com/", userAgent: ua, now: Date.parse("2026-11-02T09:00:00Z") });
  recordPageView({ path: "/not a path <script>", userAgent: ua, now: Date.parse("2026-11-02T09:01:00Z") });

  snap = siteAnalyticsSnapshot();
  assert.equal(snap.spec, "verify402/site-analytics@1");
  assert.equal(snap.total, 4);
  assert.equal(snap.byPath["/"], 2);
  assert.equal(snap.byPath["/preflight"], 1);
  assert.equal(snap.byPath["/other"], 1, "unrecognized paths are bucketed, never stored raw");
  assert.equal(snap.byReferrer.direct, 2);
  assert.equal(snap.byReferrer["news.ycombinator.com"], 1);
  assert.equal(snap.byReferrer["www.google.com"], 1);
  assert.equal(snap.byDay["2026-11-01"], 2);
  assert.equal(snap.byDay["2026-11-02"], 2);
  assert.match(snap.note, /not unique visitors/);
  assert.match(snap.scope, /process-local/);
  assert.ok(!JSON.stringify(snap).includes("SECRETTOKEN"), "query strings must never be stored");

  // Durable mode: counts survive a simulated restart in the same file.
  const before = siteAnalyticsSnapshot();
  const init = initSiteAnalytics({ path: file });
  assert.equal(init.enabled, true);
  assert.equal(siteAnalyticsHealth().enabled, true);
  recordPageView({ path: "/proof", userAgent: ua, now: Date.parse("2026-11-03T08:00:00Z") });
  const flush = flushSiteAnalytics();
  assert.equal(flush.saved, true);

  resetSiteAnalytics();
  assert.equal(siteAnalyticsSnapshot().total, 0, "reset clears the in-memory window");

  initSiteAnalytics({ path: file });
  const restored = siteAnalyticsSnapshot();
  assert.equal(restored.total, before.total + 1);
  assert.equal(restored.byPath["/proof"], 1);
  assert.match(restored.scope, /durable-single-instance/);

  // Cardinality is bounded so a public endpoint cannot grow memory without limit.
  for (let i = 0; i < 200; i += 1) {
    recordPageView({ path: `/page-${i}`, userAgent: ua });
  }
  snap = siteAnalyticsSnapshot();
  assert.ok(Object.keys(snap.byPath).length <= 96);
  assert.ok(snap.byPath.other >= 1);

  console.log("site-analytics.test.mjs: all assertions passed");
} finally {
  resetSiteAnalytics();
  rmSync(dir, { recursive: true, force: true });
}
