// Unit tests for the public board (/board, /board.json, /badge).
//
// The board is a measurement surface, so the tests pin both the rendering and
// the honesty constraints: a verdict is labelled as a structural read, the
// caveats cannot be dropped, unknown endpoints get a neutral badge, and seller
// text is escaped rather than trusted.

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBoard,
  normalizeRow,
  renderBoardPage,
  renderBadgeSvg,
  badgeFor,
  readLocalBoard,
  chainLabel,
  formatPrice,
  formatWindow,
  shortHash,
  verdictOf,
  BOARD_CAVEATS,
} from "../src/board.mjs";

const board = normalizeBoard({
  generatedAt: "2026-11-14T22:00:00.000Z",
  source: "https://example.test/catalog",
  catalogTotal: 100,
  rows: [
    { resource: "https://paid.example/a", method: "GET", verdict: "PASS", chain: "eip155:8453", priceUsd: 0.01, maxTimeoutSeconds: 300, calls30d: 1200, checkedAt: "2026-11-14T22:00:00.000Z" },
    { resource: "https://paid.example/b", method: "POST", verdict: "CAUTION", reasons: ["long_timeout"], chain: "solana:5eykt4", priceUsd: 0.005, maxTimeoutSeconds: 3600, calls30d: 3, checkedAt: "2026-11-14T22:00:00.000Z" },
    { resource: "https://refused.example/c", method: "POST", error: "challenge_mismatch", checkedAt: "2026-11-14T22:00:00.000Z" },
    { resource: "https://down.example/d", method: "GET", error: "unresolvable_host", checkedAt: "2026-11-14T22:00:00.000Z" },
  ],
});

test("board: counts come from the rows, not from the file", () => {
  assert.deepEqual(board.counts, { pass: 1, caution: 1, refused: 1, block: 0, unreachable: 1 });
  assert.equal(board.rows.length, 4);
});

test("board: a row without a resource is dropped, not rendered blank", () => {
  assert.equal(normalizeRow({ method: "GET" }), null);
  const b = normalizeBoard({ rows: [{ resource: "" }, { resource: "https://ok.example/x", verdict: "PASS" }] });
  assert.equal(b.rows.length, 1);
});

test("board: malformed input is refused rather than half-rendered", () => {
  assert.equal(normalizeBoard(null), null);
  assert.equal(normalizeBoard({ rows: [] }), null);
  assert.equal(normalizeBoard("nope"), null);
});

test("board: verdict mapping separates refusals from unreachable reads", () => {
  assert.equal(verdictOf({ verdict: "PASS" }), "pass");
  assert.equal(verdictOf({ verdict: "CAUTION" }), "caution");
  assert.equal(verdictOf({ verdict: "BLOCK" }), "block");
  assert.equal(verdictOf({ error: "challenge_mismatch" }), "refused");
  assert.equal(verdictOf({ error: "fetch_timeout" }), "unreachable");
});

test("badge: known endpoint carries the verdict and the caveat in its title", () => {
  const pass = badgeFor(board, "https://paid.example/a");
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.right, "well-formed");
  const svg = renderBadgeSvg(pass);
  assert.match(svg, /^<svg /);
  assert.match(svg, /well-formed/);
  assert.match(svg, /not an audit or endorsement/);
  assert.match(svg, /aria-label="x402 · verify402: well-formed"/);
});

test("badge: a long authorization window is named, not hidden", () => {
  const caution = badgeFor(board, "https://paid.example/b");
  assert.equal(caution.right, "flagged · long window");
});

test("badge: an unlisted endpoint gets a neutral badge, never a pass", () => {
  const unknown = badgeFor(board, "https://never-scanned.example/x");
  assert.equal(unknown.verdict, "unknown");
  assert.equal(unknown.right, "not scanned");
  assert.doesNotMatch(renderBadgeSvg(unknown), /well-formed/);
});

test("badge: trailing slashes do not change which endpoint is found", () => {
  assert.equal(badgeFor(board, "https://paid.example/a/").verdict, "pass");
  assert.equal(badgeFor(board, "").verdict, "unknown");
});

test("badge: any text placed in the SVG is escaped, not injected", () => {
  const svg = renderBadgeSvg({
    left: 'a"<b>',
    right: "x</text><script>alert(1)</script>",
    color: "#000",
    title: '"><script>alert(2)</script>',
  });
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&quot;/);
});

test("badge: a hostile endpoint URL only contributes its host", () => {
  const b = normalizeBoard({ rows: [{ resource: "https://evil.example/</title><script>x</script>", verdict: "PASS" }] });
  const svg = renderBadgeSvg(badgeFor(b, b.rows[0].resource));
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /evil\.example/);
});

test("page: states the counts, the timestamp, and the limits in the same view", () => {
  const html = renderBoardPage(board);
  assert.match(html, /Which x402 endpoints return a payment demand/);
  assert.match(html, /2026-11-14 22:00 UTC/);
  assert.match(html, /not safe: the demand can parse perfectly and the seller can still be dishonest/i);
  assert.match(html, /board\.json/);
  for (const caveat of BOARD_CAVEATS) {
    assert.ok(html.includes(caveat.slice(0, 40)), `page must carry the caveat: ${caveat.slice(0, 40)}`);
  }
});

test("page: every row is addressable and filterable", () => {
  const html = renderBoardPage(board);
  for (const row of board.rows) {
    assert.ok(html.includes(`id="e-${shortHash(row.resource)}"`), `missing anchor for ${row.resource}`);
  }
  assert.match(html, /data-verdict="caution"/);
  assert.match(html, /data-chain="Base"/);
});

test("page: an endpoint URL cannot break out of the markup", () => {
  const b = normalizeBoard({ rows: [{ resource: 'https://x.example/"><img src=x onerror=alert(1)>', verdict: "PASS" }] });
  const html = renderBoardPage(b);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&quot;&gt;&lt;img/);
});

test("page: an empty board says the scan has not run instead of showing zero as a result", () => {
  const html = renderBoardPage(normalizeBoard({ rows: [] }) || { rows: [], counts: {}, caveats: [], generatedAt: null });
  assert.match(html, /has not run yet/);
});

test("page: never presents itself as a safe list", () => {
  const html = renderBoardPage(board).toLowerCase();
  assert.ok(html.includes("not an audit"));
  assert.ok(!html.includes("verified safe"));
});

test("formatters: prices and windows keep their units honest", () => {
  assert.equal(formatPrice(0.01), "$0.01");
  assert.equal(formatPrice(0.0005), "$0.0005");
  assert.equal(formatPrice(0), "$0");
  assert.equal(formatPrice(null), "—");
  assert.equal(formatWindow(300), "5 min");
  assert.equal(formatWindow(3600), "1 h");
  assert.equal(formatWindow(45), "45 s");
  assert.equal(formatWindow(null), "—");
  assert.equal(chainLabel("eip155:8453"), "Base");
  assert.equal(chainLabel("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "Solana");
  assert.equal(chainLabel("eip155:9999"), "chain 9999");
  assert.equal(chainLabel(null), "—");
});

test("bundled data: the shipped snapshot parses and has rows", () => {
  const local = readLocalBoard();
  assert.ok(local, "data/board.json must be present and valid in the repo");
  assert.ok(local.rows.length > 0);
  assert.ok(local.generatedAt);
});
