# Three outreach drafts for tester recruitment

> **Email:** the capped email campaign (AgentMail MCP, 4 emails + 3 forms + 3
> warm replies) lives in **`docs/email-campaign.md`**. It is drafted but **not
> sent**; it needs a postal address and an AgentMail account/API key first.

Use these as targeted messages, not a mass blast. Warm replies to people who already engaged with verify402 convert better than a new standalone post.

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
