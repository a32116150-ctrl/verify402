# Three outreach drafts for tester recruitment

> **Email:** the capped email campaign lives in **`docs/email-campaign.md`**.
> 15 sends went out Oct 23; AgentMail's new-recipient cap is exhausted until
> `2026-10-30T12:17:03Z`. The postal address was omitted by owner decision
> (CAN-SPAM risk accepted). Do not add recipients until the cap clears;
> one follow-up maximum per recipient, planned Oct 27–30.

Use these as targeted messages, not a mass blast. Warm replies to people who already engaged with verify402 convert better than a new standalone post.

## Moltbook post (2026-10-23, owner override)

The owner explicitly overrode the no-standalone-post rule for this one:

- **Post:** `2047798a-ddad-435f-9508-c98fb29bcc15` in `m/agentfinance`
- **Title:** “What would make a pre-signing gate useful before your agent pays? (free Base Sepolia test)”
- **URL:** https://www.moltbook.com/post/2047798a-ddad-435f-9508-c98fb29bcc15
- **Status:** verified, `is_spam:false`. As of 2026-10-23 22:45 UTC: 6 upvotes,
  0 downvotes, 14 comments, 3 new followers. One credible agent tester
  (`piggybank-bsc`) ran 15 read-only intents and found two issues; both fixed
  in commit `909cbfd` and shipped in `1.0.6`. Replies posted:
  `6978fdf0-e9e3-44e3-be84-d2365927f20b` (piggybank) and
  `90a84a30-f760-4be0-86b0-0516abee3d6f` (lilt, edge-case batch offer).
- **2026-10-23 22:45 UTC — three tester asks, all verified `is_spam:false`:**
  - `7034d0b3-fba0-402a-b70a-f16dbb59aa6e` → **spawn3**: obligation state is
    named in `notChecked`; receipt `intentHash`/`requestHash` binding is live;
    ask is the settled-idempotency-key and cumulative-spend sequence.
  - `ea6d3a8c-f569-4cd8-bd9a-4e25a4ee432f` → **citruscoastai**:
    `payTo ownership / proven seller payout wallet` is named in `notChecked`;
    quote binding is at the receipt layer; ask is third-party-gateway `payTo`
    plus post-gate amount/asset swaps.
  - `d912ba18-1d8d-44d7-bdd4-4786e32c43f5` → **piggybank-bsc**: 1.0.6 re-run
    of the four fixed/regression cases (unbound resource, foreign host with
    allowlist, canonical host, `eip155:56`).
  - Their parent comments were upvoted. The ask is 5–10 read-only intents,
    free, Base Sepolia only, no wallet or payment.
- **Tester findings fixed:** unbound `payment.resource` is now CAUTION
  `resource_identity_unverified`; `policy.allowedResourceHosts` match → PASS +
  `resource_host`, foreign host → BLOCK; `expectedResource` exact-URL binding
  remains. `eip155:56` now says “not supported by this instance” with the
  supported list. `notChecked` now names payTo ownership and obligation state.
- **2026-10-24 — published in 1.0.8:** caller-supplied
  `payment.idempotencyKey`, `policy.obligation`, and
  `policy.sellerPayoutWallets` are on npm `verify402-mcp@1.0.8`, active in the
  MCP Registry, and live at `/preflight`. `sellerPayoutWallets` is an
  allowlist, not a binding; a verified `policy.sellerPayoutManifest` is the
  only source of `payee_payout_binding`. The gate still does not persist a
  ledger, and the payout binding is not proof of wallet ownership. The release
  also adds the `createX402PreflightHook()` / `guardX402Payment()` example and
  anonymous client labels for `/usage`.
- **Rule:** one post per 30 minutes. If it gets flagged or removed, do not retry; go back to replies/comments.

Before sending:

1. Warm the service: `curl -sS https://verify402.onrender.com/health`
2. Record the baseline: `curl -sS https://verify402.onrender.com/usage`
3. Use the browser panel as the primary link: `https://verify402.onrender.com/preflight#try`. The stable MCP fallback is `https://verify402.onrender.com/mcp`.
4. Send 3–5 messages, not 50. Personalize the first line.

## 1. Moltbook / MoltJobs reply

Use this in a relevant thread about MCP tools, x402, agent payments, or testing. Do not create a standalone Moltbook post without an explicit override.

```text
I’m testing a free preflight gate for agents before they sign or pay. Demo payments are Base Sepolia testnet only; analysis reads mainnet chain data. No wallet or paid test. It returns PASS/CAUTION/BLOCK plus what it didn’t check. I’m looking for 3 builders to run 3–5 real intents and report false PASSes. Try it in the browser (paste a token address, or run the raw intent): https://verify402.onrender.com/preflight#try — MCP: https://verify402.onrender.com/mcp
```

## 2. GitHub issue

**Opened 2026-10-23 as issue #3:** https://github.com/a32116150-ctrl/verify402/issues/3

Title:

```text
Looking for 3 testers: free preflight gate (Base Sepolia testnet)
```

Body:

```markdown
I’m the solo developer behind verify402. I’m looking for three developers building AI agents, MCP tools, or x402 payment integrations to test the free preflight gate.

What it is: send a payment request or transaction intent; get PASS/CAUTION/BLOCK with the checks that ran, the checks that did not, and a receipt. The goal is to make the agent stop and inspect the intent before signing, not to guarantee safety.

Scope: Base Sepolia testnet USDC (`eip155:84532`). The analysis reads mainnet chain data, but the demo does not settle mainnet payments. The free gate never moves funds. No wallet, account, or paid test is required.

Ask: run 3–5 real intents, then report the verdict/reasons and anything that looks like a false PASS. Redact addresses and amounts if needed.

- Try it in the browser: https://verify402.onrender.com/preflight#try (simple token-approval check, plus raw JSON samples)
- 5-minute guide: https://github.com/a32116150-ctrl/verify402/blob/master/TESTING.md
- Feedback form: https://github.com/a32116150-ctrl/verify402/issues/new?template=tester-feedback.yml

I’m not selling anything or asking for funding. “Not useful for my workflow” is useful feedback too.
```

## 3. Direct message or email

```text
Hi [name] — you mentioned [specific MCP/x402/agent-payment problem] in [thread]. I’m the solo developer behind verify402, a free preflight gate for agents before they sign or pay.

I’m looking for 3 builders to run 3–5 real intents (a payment, an approval, a swap) on the testnet demo and tell me what breaks, especially false PASSes. No wallet, account, or paid test is required; the analysis reads mainnet chain data.

Try it in the browser: https://verify402.onrender.com/preflight#try

If it’s not useful for your workflow, that’s useful feedback too. No pitch or call needed.
```

## What to track

- `/usage` before and after (baseline 2026-10-23 12:35 CET: 4 calls, all ours)
- number of testers
- intents tested
- false PASS / false BLOCK findings
- one integration conversation

After three testers, publish a short anonymized “What 3 testers found” note. That is the next promotion asset.
