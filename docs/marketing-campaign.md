# Marketing campaign — the pre-signing layer

**Owner:** operator (verify402)
**Status:** active, started 2026-10-25
**Goal:** turn the free preflight gate into a category, a tester pipeline, and a
repeatable commercial funnel — without paid ads, invented traction, or a token.

---

## 1. The thesis

Agent payments are moving from "human clicks approve" to "software signs." The
failure mode is not a bad forecast; it is a **valid signature on a bad intent**.
Most tooling checks the result after the money moved. verify402 checks the intent
before the signature and returns a receipt that can be verified later.

The category we name and own: **the pre-signing gate for agent payments.**

One sentence:

> Before your agent signs, it should ask: *should I sign this?* verify402 answers
> with PASS / CAUTION / BLOCK, the reasons, and a short-lived receipt — in one
> free call, with no wallet and no signup.

What makes this credible rather than promotional:

- the gate is free and read-only;
- every answer carries a `notChecked` list;
- the receipt is HMAC-signed and bound to the exact intent and block;
- the verdict is falsifiable — a false PASS is a real, reportable finding.

---

## 2. Objectives and KPIs

The campaign is measured in **intents**, not impressions.

| Horizon | Objective | KPI | Target |
|---|---|---|---|
| 14 days | Qualified testers | teams that run ≥3 real intents | 3 |
| 30 days | Proof asset | anonymized "what testers ran" note | 1 |
| 30 days | Integration conversation | teams that ask to embed the gate | 1 |
| 45 days | Commercial signal | first external paid call or paid pilot | 1 |
| 45 days | Owned audience | blog posts published + RSS subscribers | 6 posts, any RSS pickup |

Secondary: `/preflight` calls from unique client labels, MCP installs, GitHub
stars (weak signal), directory referrals.

Non-goals: follower counts, impressions, "awareness" without an intent run,
fake logos, testimonials, usage inflation, price predictions.

---

## 3. Positioning

**For** builders whose agents sign x402 payments, token approvals, or swaps
**who** need a check at the moment of signing
**verify402 is** a free pre-signing gate
**that** returns PASS / CAUTION / BLOCK, typed reasons, and an intent-bound receipt
**unlike** dashboards, scanners, and post-hoc analytics
**it** checks the exact intent before the signature and is MCP-native.

Category language to repeat everywhere:

- "the pre-signing gate for agent payments"
- "a receipt is not a guarantee; it is a falsifiable record"
- "a false PASS is the only failure that matters"
- "the gate is free because it has to run before every signature"

Avoid:

- "AI-powered," "trust layer," "bank-grade," "audited" (unless literally true)
- "safe," "guaranteed," "protected" as absolutes
- profit, yield, alpha, "find trades"
- implying mainnet settlement or an external buyer that does not exist

---

## 4. Audiences

| Priority | Audience | Where they are | What they fear | Entry point |
|---|---|---|---|---|
| 1 | x402 API-payment agents | x402 Bazaar, 402index, Moltbook, MoltJobs | paying a swapped payee or wrong asset | `/preflight` |
| 2 | Agent wallets / smart accounts | GitHub, Safe modules, wallet docs | unlimited approval to a fresh spender | `/preflight` approval panel |
| 3 | MCP builders | MCP Registry, mcprush, Glama, Smithery, PulseMCP | adding an unsafe payment tool | `/mcp` |
| 4 | Treasury / ops agents | agent-finance threads, founder DMs | a valid signature on a bad transfer | `/testers` |

The first three audiences are reachable today. The fourth is warm-intro only.

---

## 5. Offer ladder

| Step | Offer | Price | Purpose |
|---|---|---|---|
| 1 | Free preflight gate | free | acquisition; must run before every signature |
| 2 | Tester kit (`/testers`) | free | converts a reader into a real intent run |
| 3 | MCP server | free | embeds the gate in the tool loop |
| 4 | Five measurement checks | $0.03–$0.10/call, testnet demo | proves the paid surface |
| 5 | Design-partner slot | free, 3 teams | integration + public case study |
| 6 | Hosting sponsorship | $7/month | keeps the free tier awake |
| 7 | Paid pilot | scoped by email, no mainnet rail offered today | future revenue |

Rules:

- The free gate is never paywalled. It is the category entry point.
- Paid checks are separate and optional; no upsell inside a verdict.
- Design partners are free but named only with written permission.
- No mainnet payment is offered through the public demo. A pilot's rail is
  decided only when an always-on instance and a mainnet facilitator exist.

---

## 6. Funnel

```
blog / directory / tester thread
        ↓
   /testers  (three-intent ask)
        ↓
   /preflight#try  (free verdict + receipt)
        ↓
   /mcp  (embed in the agent)
        ↓
   paid check  →  design partner  →  pilot / sponsor
```

Every asset has one job:

- **Blog** — earn trust and search traffic with scope and receipts.
- **`/testers`** — make the ask concrete and low-friction.
- **`/preflight`** — deliver the first PASS/BLOCK in under two minutes.
- **`/mcp`** — turn a test into an integration.
- **`/proof`** — keep the commercial claims honest.

---

## 7. Content engine

Cadence: **two posts per week, Tuesday and Friday**, 700–1,200 words, one idea
each. Every post ends with the same tester ask, not a sales pitch.

### Published

1. **What a pre-signing gate can check — and what it can't** (scope; evergreen)
2. **A receipt is not a guarantee. It's a falsifiable record.** (trust)
3. **Three payment intents your agent should never sign unchecked** (problem)

### Backlog

4. **What 15 outside intents changed in 1.0.8** — hardening note, not a defect
   list; only with tester permission and receipts.
5. **How to put a pre-signing gate in an MCP agent in 15 minutes** — integration
   walkthrough with the reference guard.
6. **The `notChecked` list is the product** — why scope beats a green check.
7. **Why an unlimited approval is still the default failure** — ERC-20 allowance
   mechanics, no fear-mongering.
8. **A receipt for the wrong intent is theater** — intent binding, request
   binding, expiry, replay.
9. **What a payment gate should log — and what it should never log** — privacy
   and redaction for agents.

Distribution for each post:

- RSS (`/blog/rss.xml`) and sitemap;
- one substantive Moltbook comment where the topic is already being discussed
  (never a standalone post);
- one MoltJobs reply only when it answers a live thread;
- a line in the next email follow-up (one follow-up maximum);
- GitHub issue #3 / README update when the post is a guide.

---

## 8. Channel playbook

### Owned

- **Blog** — the durable asset; no platform risk.
- **`/testers`** — the conversion page.
- **`/preflight`, `/mcp`, `/proof`** — product proof.
- **GitHub** — source, issues, release notes, tester template.
- **RSS** — lets aggregators and agents pick up posts without an account.

### Earned

- **Moltbook** — comments only. Five standalone posts were auto-flagged; the
  filter targets the account/topic. One useful comment in a live thread beats a
  flagged post. Never bulk-copy the same text.
- **MoltJobs** — launch thread + tester offer; reply to live threads.
- **Directories** — MCP Registry, mcprush, Glama, Smithery, PulseMCP, 402index,
  x402 Bazaar. Fix stale versions before asking for new placement.
- **Email** — 15 personalized sends on Oct 23; one follow-up maximum, Oct 27–30.
  No new recipients until AgentMail's cap clears on Oct 30; Resend is primary.

### Not now

- Paid ads (no budget, no proof of conversion).
- Mass DMs or scraped lists.
- Standalone Moltbook posts.
- X/LinkedIn automation without account access.
- PR pitches to crypto media (the story is not funded enough to survive it).

---

## 9. Four-week calendar

### Week 1 — owned assets (Oct 26–Nov 1)

- [x] Publish `/blog` with three posts and RSS.
- [x] Publish `/testers` with three copyable intents.
- [x] Add Blog + Testers to nav, footer, sitemap.
- [ ] Update GitHub issue #3 with the `/testers` link.
- [ ] Send follow-ups to the 15 Oct 23 recipients (Oct 27–30), blog link included.
- [ ] One Moltbook comment linking the scope post where relevant.

### Week 2 — proof (Nov 2–8)

- [ ] Run every intent received; reply with raw verdict + reason codes.
- [ ] Publish one anonymized field note if ≥3 intents arrived.
- [ ] Fix any reproducible false PASS; ship a patch only with approval.
- [ ] Ask one tester for a design-partner slot.

### Week 3 — integration (Nov 9–15)

- [ ] Publish the MCP integration walkthrough.
- [ ] Record a 60–90 second screen capture of the gate blocking an approval.
- [ ] Pitch the gate to one wallet / agent-framework team (warm only).
- [ ] Check mcprush + Glama listing status.

### Week 4 — commercial (Nov 16–22)

- [ ] Publish the "notChecked" post.
- [ ] Offer one scoped pilot; do not offer a mainnet rail.
- [ ] Review `/usage`, tester count, and false-PASS findings.
- [ ] Keep what worked; kill one channel that produced nothing.

---

## 10. Measurement

Weekly review, same five numbers:

1. **Intents run** by outside testers (target: 9 by Nov 8).
2. **Distinct tester teams** (target: 3).
3. **False PASS / false BLOCK findings** (the product metric).
4. **Integrations started** (target: 1).
5. **Revenue signal** — paid check, pilot, or sponsorship (target: 1).

Instrumentation that exists:

- `/usage` — call counts by client label and verdict.
- `/proof` — operator settlement only; no external buyer invented.
- `/sponsor` — manual ledger, updated only after on-chain confirmation.
- Email replies and GitHub issues — the real conversion record.

Do not add vanity analytics that require a tracking script. If a campaign link
needs attribution, use a distinct page or a `?ref=` value recorded by the tester
when they send the intent.

---

## 11. Guardrails

- No fake logos, testimonials, customers, or usage.
- No profit, yield, or "safe" claims.
- No public inventory of product defects; publish scope and hardening notes.
- No standalone Moltbook posts; comments only.
- One follow-up maximum per email recipient.
- No new npm publish without explicit approval.
- No mainnet payment offering while the demo is testnet and the host sleeps.
- Redact tester intents; name a tester only with permission.
- Every claim about the product must be reproducible from the live service or
  the public repo.

---

## 12. Autonomy boundary

I can do without asking:

- write and publish blog posts, `/testers`, RSS, sitemap, nav, metadata;
- answer tester threads with raw verdicts;
- update GitHub issues and docs;
- comment in live Moltbook/MoltJobs threads when it is on-topic;
- prepare email drafts and the weekly review.

I ask first for:

- a new npm version or registry release;
- a mainnet payment rail or a paid pilot with a mainnet address;
- a standalone Moltbook post;
- paid ads or spending money;
- naming a tester or publishing their intent;
- any claim that changes the funding or buyer status on `/proof`.

---

## 13. Assets shipped with this plan

- `/blog` — index, three posts, RSS.
- `/testers` — three-intent tester kit.
- `docs/marketing-campaign.md` — this document.
- Nav/footer/sitemap updates so the campaign is crawlable.
- Tester ask already live: MoltJobs reply `9156c3e6`, Moltbook comment `22f709b8`.

The next action is not another post. It is to put the `/testers` link in front of
the 15 people who already received a personalized email, and to run the first
three intents that come back.
