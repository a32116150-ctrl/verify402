# Directory submission payloads — copy/paste, in this order

This file is a paste sheet, not a record of listings. **As of 2026-11-13:**

| Directory | State |
|---|---|
| PulseMCP | "Showing 0 – 0 of 0 servers". **Submissions and listing changes are paused site-wide** while they rework how listings are ingested — the `/submit` page now redirects to the official MCP Registry docs, and their homepage banner says so. We are already in that registry (1.1.0, active), so nothing to submit today; retry when they reopen. |
| mcp.so | No listing ("No servers match verify402"). Submit page exists but shows only a **$39 one-time paid submission** (no free option visible as of 2026-11-13). Decision 2026-11-13: **hold — no spend before a first external user.** Revisit after traction; may need a free path below the fold — none seen. |
| Smithery | Server page at `smithery.ai/server/@a32116150-ctrl/verify402-mcp` now redirects to www and **404s** — no listing. |
| Glama | **Listed** (auto-indexed GitHub repo): https://glama.ai/mcp/servers/a32116150-ctrl/verify402 — shows older metadata (1.0.9-era). Nothing to submit; claiming/refreshing is optional. |

Re-check Glama before any public claim about what version it shows.

All four were marked `PREPARED` in `docs/distribution-directory-checklist.md`;
only Glama resolved that way. Everything else here is true of the live 1.1.0
release; nothing is claimed that the repo or the running service does not
show.

**Before pasting anything:** these are browser/account forms, not APIs. Open
them logged in as yourself. Do not fill in a field with something from this
file that you cannot see is true on screen.

---

## Shared facts (use verbatim)

- **Name:** verify402
- **Identifier / handle:** verify402-mcp
- **npm:** https://www.npmjs.com/package/verify402-mcp (latest `1.1.0`)
- **Install:** `npx -y verify402-mcp`
- **Repository:** https://github.com/a32116150-ctrl/verify402
- **Homepage:** https://verify402.onrender.com/
- **License:** Apache-2.0
- **Registry entry:** `io.github.a32116150-ctrl/verify402-mcp` (MCP Registry, active/latest)
- **Category hints:** finance, crypto, security, payments, agent-tools
- **Tags:** mcp, model-context-protocol, x402, ai-agents, payments, base, solana, preflight
- **One-line description:** Free, fail-closed pre-signing gate for agent payments, plus five paid on-chain checks (testnet).
- **Long description:** verify402 puts a check before the signature instead of after the loss. An agent calls `preflight_gate` on a payment challenge or an EVM transaction intent; the gate returns PASS, CAUTION, or BLOCK with typed reason codes, a short-lived HMAC receipt, and an explicit list of what was not checked. `inspect_402` reads any public 402 before you pay it; `directory_402` exposes a watched public list of x402 endpoints. The five paid checks (arbitrage, token safety, route, quote fairness, depth) are priced per call in testnet USDC over x402 and are off unless the operator configures a wallet. Free mode (no key) registers three tools and can never spend. Demo payments settle on Base Sepolia / Solana devnet; analysis reads mainnet chain data.

## Tools (all 8, 1.1.0)

Free (always registered, no key, no spend):

| Tool | What it does |
|---|---|
| `preflight_gate` | Pre-signing check for an x402 payment or an EVM transaction. PASS / CAUTION / BLOCK + receipt. |
| `inspect_402` | Read any public x402 endpoint's 402 before paying. Network, asset, amount, payee, resource binding. |
| `directory_402` | The watched public x402 directory, re-inspected on an interval, protocol and sign verdicts kept separate. |

Paid (only when a wallet is configured; testnet USDC per call):

| Tool | Price | What it does |
|---|---|---|
| `get_arb_verdict` | $0.05 | Whether a cross-venue arbitrage round trip is profitable at the pinned block. Most common result: `no_edge`. |
| `get_token_safety` | $0.10 | TRUST / CAUTION / AVOID with evidence; quote-based sellability, not a honeypot proof. |
| `get_trade_route` | $0.03 | What the chain would actually pay, venue by venue. |
| `check_quote` | $0.05 | Fair / overpaying / too-good-to-be-true for any offered quote. |
| `get_trade_depth` | $0.05 | Largest size before round-trip costs erase the plan. |

---

## 1. PulseMCP — https://www.pulsemcp.com/submit (redirects to MCP Registry docs)

Submissions are **paused site-wide**: `/submit` no longer shows a form; it
redirects to the official MCP Registry docs, and the homepage carries the
"new server submissions and listing changes are still paused" banner. The
prerequisite they want is being in the MCP Registry — done (`io.github.a32116150-ctrl/verify402-mcp`, 1.1.0, active). Do not re-submit; do not "upgrade" anything on that page; check back when the banner comes down.

## 2. mcp.so — https://mcp.so/submit?type=server

Paste the shared facts. **Pricing reality (2026-11-13):** the submit page shows
only a one-time **$39 paid submission** ("publish immediately, no review,
verified badge, featured placement, dofollow link"); no free option is visible.
**Held** — no spend until there is a first external user. The page works; it
is simply not free. If a free path turns up below the fold, take it and use
the fields below.

Expected fields:

- **Tab:** MCP Server (selected) — not Remote Server, not MCP Client, not AI Product.
- **Repository URL:** `https://github.com/a32116150-ctrl/verify402`
- **Name:** `verify402-mcp`

## 3. Smithery — https://smithery.ai/

Smithery distributes servers it can run or launch itself. Our bridge is a
stdio server published on npm and declared in the MCP Registry, so the honest
route is to register the **published package** through their web flow rather
than to claim a hosted deployment we do not run. If the flow requires an
endpoint we cannot provide, stop and say so — do not invent a URL.

## 4. Glama — https://glama.ai/mcp/servers

Glama indexes public GitHub repositories automatically; we are already there
as `glama.ai/mcp/servers/a32116150-ctrl/verify402`, showing stale metadata
(1.0.9-era). The only credible action is to claim/refresh the existing entry,
not to submit a new one. If the refresh flow is not offered to us, leave it
and re-check later. The `awesome-mcp-servers` entry below is independent.

---

## Optional: `punkpeye/awesome-mcp-servers`

The list carries X402-adjacent servers already (e.g. 402signal), and a PR is a
legitimate, free submission. Proposed entry for the **Finance & Fintech**
section, matching the list's existing line format:

```markdown
- [a32116150-ctrl/verify402](https://github.com/a32116150-ctrl/verify402) 📇 🏠 - Free, fail-closed preflight gate for agent payments: PASS / CAUTION / BLOCK with a short-lived receipt before the signature; reads any public x402 endpoint and a watched directory of live 402s; five paid on-chain checks in testnet USDC.
```

Notes: no Glama badge until Glama indexes us. The repo has 0 stars today; the
PR may be rejected on that basis — that costs nothing, do not chase the
maintainer.

## After each submission

1. Flip its row in `docs/distribution-directory-checklist.md` from
   `PREPARED` → `SUBMITTED` with the date and where it will be reviewed.
2. Do **not** claim `ACCEPTED` until the listing is publicly visible, and
   record the URL when it is.
3. Update this file's status table with the URL or the rejection reason.
