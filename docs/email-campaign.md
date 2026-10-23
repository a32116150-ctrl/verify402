# Email campaign — free preflight gate testers

**Status:** **4 of 4 sent** (Oct 23, 12:50–12:55 UTC): Glama, Cloudflare x402,
PulseMCP, Solana Foundation. Glama opened auto-ticket **#148620911**; no other
replies or bounces yet. Postal address omitted by owner decision (CAN-SPAM risk
accepted). Signer: `verify402 <sankou7-1754@agentmail.to>`. One follow-up
maximum per recipient, 4–7 days out.

This is deliberately not a mass campaign. The project rule is 3–5 targeted
messages, not 50. The goal is 3 testers who run real intents and report false
PASSes — not impressions.

---

## 1. Tooling: free email MCP

### Chosen: AgentMail MCP

- **Hosted MCP:** `https://mcp.agentmail.to/mcp`
- **Auth:** `x-api-key: ${AGENTMAIL_API_KEY}` (key starts with `am_`), or OAuth
  in Claude clients.
- **Free plan:** 3 inboxes, 3,000 emails/month, 100/day, 3 GB storage, MCP
  included. **No custom domain** on Free; mail carries a “Sent via AgentMail”
  footer.
- **Why this one:** it can send **and receive** without owning a domain. Replies
  land in the same inbox, so the follow-up loop is `list_threads` →
  `reply_to_message`. Resend cannot send to arbitrary recipients until a domain
  is verified; Brevo works but is marketing-first and its free plan is 300/day.
- **Core tools:** `create_inbox`, `send_message`, `list_threads`, `get_thread`,
  `reply_to_message`, `create_draft`, `send_draft`.

**Config (Cursor/Windsurf/opencode-style client):**

```json
{
  "agentmail": {
    "url": "https://mcp.agentmail.to/mcp",
    "headers": { "x-api-key": "${AGENTMAIL_API_KEY}" }
  }
}
```

**Codex (`~/.codex/config.toml`):**

```toml
[mcp_servers.agentmail]
url = "https://mcp.agentmail.to/mcp"
env_http_headers = { "x-api-key" = "AGENTMAIL_API_KEY" }
```

**Setup, in order:**

1. Sign up free at `https://console.agentmail.to/sign-up`; complete the email
   OTP (`agent.verify` if signing up programmatically — unverified signups can
   only mail their own signup address).
2. Create inbox `verify402` with display name `verify402`.
3. Store the key as `AGENTMAIL_API_KEY` in the shell/secret store. Never commit
   it, never paste it into a doc.
4. Test: send one message to your own address, then reply to it and confirm
   `list_threads` shows the thread. Only after that send externally.

**Live setup (Oct 23):** inbox `sankou7-1754@agentmail.to`, display name
`verify402`; a test email sent to itself and listed with the `sent` label. The
current key is inbox-scoped, so `inbox_create` is denied — a branded
`verify402@agentmail.to` address would need an organization-scoped key. The
free-plan footer `Sent via AgentMail` is present on sent mail.

### Alternatives (and why not now)

| MCP | Free tier | Constraint |
|---|---|---|
| **Resend MCP** (`resend/resend-mcp`, `https://mcp.resend.com/mcp`) | 3,000/month, 100/day | **Requires a verified domain** to send to anyone. Best upgrade path once a domain exists (no footer, best deliverability). |
| **Brevo MCP** (`https://mcp.brevo.com/v1/...`) | 300/day (~9,000/mo) | Marketing/CRM platform; sender verification; more spam surface than a 4-email 1:1 campaign needs. |
| **Gmail MCP** (community) | Free with a Gmail account | Acts as a human mailbox; no official Google MCP; cold outreach from Gmail is a deliverability and policy risk. |

**Upgrade trigger:** if the campaign produces replies and a second round is
justified, buy/verify a domain (e.g. a `verify402` domain), move to Resend MCP,
and keep AgentMail for inbound replies.

---

## 2. Non-negotiable rules

1. **Six recipients maximum in round 1** (4 email + 3 form/warm; see §3). No CC,
   no BCC, no mail-merge blast.
2. **Only public role addresses or official forms.** No scraped personal
   emails, no guessed addresses, no purchased lists.
3. **Plain text only.** One link. No images, no tracking pixels, no open/click
   tracking, no attachments.
4. **Identify honestly:** solo developer, free gate, testnet demo, no wallet, no
   paid test, no funding ask (except the explicit grant forms).
5. **No overclaims:** it checks the transaction, not token reputation or
   sellability. Never write “safe”, “guaranteed”, “prevents all”, or “audited”.
6. **Opt-out in every email:** “If this is not useful, reply ‘no’ and I will not
   follow up.” Honour it immediately and permanently.
7. **One follow-up**, 4–7 days later, same thread. Then stop. No third message.
8. **Postal address omitted by owner decision (Oct 23).** CAN-SPAM requires a
   physical address for commercial email; these messages do not carry one, so
   that requirement is not met. The owner accepted the risk. Do not invent an
   address.
9. **EU/UK recipients:** legitimate-interest basis, easy opt-out, no profiling.
   If anyone objects, delete their address from the prospect file.
10. **Send one at a time, read the rendered email before `send_message`.** The
    MCP makes bulk easy; that is exactly why the cap is manual.

---

## 3. Prospects (round 1)

### A. Email track — 4 messages

| # | Target | Public route | Why them | Ask |
|---|---|---|---|---|
| 1 | **Glama** | `support@glama.ai` (public GitHub org email) | Our listing still points at the **1.0.2** tarball; current is **1.0.5**. | Correct the listing to `npx -y verify402-mcp@latest`; tester link as context. |
| 2 | **PulseMCP** | `hello@pulsemcp.com` (public GitHub org email) | Directory + “The Agentic Loop” newsletter; listings are paused, so this is a queue request, not a demand. | Consider verify402 when submissions reopen; offer the browser link for a quick look. |
| 3 | **Cloudflare x402 team** | `x402@cloudflare.com` (published in Cloudflare’s x402 launch post) | Cloudflare co-launched the x402 Foundation; closest team to the protocol our gate checks. | Falsification test: run 3–5 real intents, report false PASSes. |
| 4 | **Solana Foundation** | `hello@solana.com` (published community contact) | The demo accepts Solana devnet payment challenges; ask for an ecosystem testing intro. **State plainly that transaction simulation is EVM-only today.** | Intro to a tester/ecosystem group; no grant ask in this email. |

### B. Form track — 3 submissions (not email)

| # | Target | Route | Ask |
|---|---|---|---|
| 5 | **Base** | `https://www.base.org/contact-us` | Ecosystem/testing feedback; Base Sepolia demo, Base mainnet analysis. |
| 6 | **Ethereum Foundation ESP** | `https://esp.ethereum.foundation/applicants` | Public-good grant fit. Check current status first — open grants were paused in 2025. |
| 7 | **Solana Grants** | `https://solana.org/grants` | Grant + tester intro; keep the EVM-simulation boundary explicit. |

### C. Warm / platform track — 3 replies (no email)

| # | Target | Route | Ask |
|---|---|---|---|
| 8 | **kvnya Auditor** | MoltJobs “Seven rails measured, zero settled” thread | They already engaged with verify402; reply with the browser link and the false-PASS ask. |
| 9 | **SameDayDesk** | MoltJobs launch thread | Previous audit exchange; low-pressure “the free gate is now browser-first” note. |
| 10 | **Imperium X402 Broker** | MoltJobs thread `91415b7c` | Already replied (`3553c6cf`); follow up only if they answer. |

### Do not contact

- **NLnet** — form-only, and its policy explicitly excludes AI-generated
  projects/proposals. Not a fit; do not email.
- **Smithery** — no public role address (the GitHub org email is a founder’s
  unrelated work address). Use their Discord only if already a member.
- **security@ addresses** at audit firms — those inboxes are for vulnerability
  reports, not outreach.
- Anyone whose address would have to be scraped from a personal profile.

---

## 4. Drafts

Round 1 signature (use this; ignore the `[NAME]` / `[POSTAL ADDRESS]`
placeholders below):

```text
verify402
Solo developer
sankou7-1754@agentmail.to
```

Keep the body under ~180 words. No HTML.

### 4.1 Glama — listing correction

**Subject:** `verify402 listing points at 1.0.2 — current is 1.0.5`

```text
Hi Glama team,

Your verify402 MCP listing still points at the 1.0.2 tarball. The current
release is 1.0.5: npm verify402-mcp@1.0.5, GitHub tag mcp-v1.0.5.

Could you update the install command to `npx -y verify402-mcp@latest`? If the
listing is generated from the npm metadata, the stale tarball link is the only
thing that needs a nudge.

Context, not a pitch: the free preflight gate now has a no-wallet browser path
at https://verify402.onrender.com/preflight#try. I am looking for three builders
to run 3–5 real intents and report false PASSes. If the listing fix is the wrong
channel, tell me and I will stop here.

If this is not useful, reply "no" and I will not follow up.

[NAME]
Solo developer, verify402
[POSTAL ADDRESS]
```

### 4.2 PulseMCP — queue request

**Subject:** `verify402 — listing when submissions reopen?`

```text
Hi PulseMCP team,

I saw submissions and listing changes are paused while you rework ingestion, so
this is a queue request, not a demand.

verify402 is a free pre-signing gate for x402 payment requests and EVM
transaction intents. No wallet, no account, no paid test. The browser path is
https://verify402.onrender.com/preflight#try (simple token-approval check, plus
raw JSON samples).

When submissions reopen, I would like verify402 considered for the directory,
and I am happy to send whatever metadata you need. If “The Agentic Loop” ever
wants a falsification angle, the honest one is: run 3–5 intents and try to make
the gate return a false PASS.

If this is not useful, reply "no" and I will not follow up.

[NAME]
Solo developer, verify402
[POSTAL ADDRESS]
```

### 4.3 Cloudflare x402 — technical falsification ask

**Subject:** `Pre-signing gate for x402 intents — would a falsification test be useful?`

```text
Hi x402 team,

I am the solo developer behind verify402, a free pre-signing gate for x402
payment requests and EVM transaction intents. It returns PASS/CAUTION/BLOCK with
typed reasons, the checks that ran, and an explicit notChecked list. It never
moves funds and needs no wallet.

I saw Cloudflare co-launched the x402 Foundation, so I am asking the team closest
to the protocol: would a falsification test be useful? Run 3–5 intents you would
otherwise sign — a payment, an unlimited approval, a swap — in the browser and
tell me where it returns a false PASS. Demo payments are Base Sepolia; analysis
reads mainnet chain data; no paid test.

Browser: https://verify402.onrender.com/preflight#try
MCP: https://verify402.onrender.com/mcp

The gate checks the transaction, not the counterparty's reputation or the
token's sellability; those are named in notChecked, not implied away.

If this is the wrong team or not useful, reply "no" and I will not follow up.

[NAME]
Solo developer, verify402
[POSTAL ADDRESS]
```

### 4.4 Solana Foundation — tester intro

**Subject:** `Solana devnet payments in a free pre-signing gate — tester intro?`

```text
Hi Solana team,

verify402 is a free pre-signing gate for agent payments. The demo accepts
Solana devnet payment challenges, and the browser path needs no wallet:
https://verify402.onrender.com/preflight#try

One boundary stated plainly: transaction simulation is EVM-only today
(Ethereum/Arbitrum/Base). For Solana, the gate checks the payment request and
the challenge fields, not a simulated state change. I would rather say that than
imply parity.

I am looking for three builders to run 3–5 real intents and report false PASSes.
If there is an ecosystem testing group or a maintainer who should see this, an
intro would help. No grant ask in this email.

If this is not useful, reply "no" and I will not follow up.

[NAME]
Solo developer, verify402
[POSTAL ADDRESS]
```

---

## 5. Form-track copy

### Base contact form (≈110 words)

```text
I am the solo developer behind verify402, a free pre-signing gate for x402
payment requests and EVM transaction intents. Demo payments use Base Sepolia;
analysis reads Base mainnet chain data; no wallet or paid test is required.

I am looking for three builders to run 3–5 real intents in the browser and report
false PASSes (the failure mode that matters): 
https://verify402.onrender.com/preflight#try

If this belongs with a Base ecosystem or developer-relations contact, could you
point me to the right place? No funding ask, no token, no mainnet payments.
```

### EF ESP (only if the current program is open)

Keep to the form’s own questions: project, public good, open licence
(Apache-2.0), users, funding already received (none), and what is *not* built.
Mention the 2025 pause and ask whether ESP or another EF program is the right
fit. Do not paste marketing copy.

### Solana Grants

Use the form’s project summary; state the Solana devnet payment support and the
EVM-only simulation boundary. Ask for tester intros, not a large grant.

---

## 6. Send sequence

| Day | Action |
|---|---|
| 0 | Send 4.1 and 4.3. Read each rendered message first. | **Done** 12:50 UTC. |
| 0 | Send 4.2 and 4.4 only if the first two render cleanly. | **Done** 12:55 UTC. |
| 1 | Submit the Base form; check EF/Solana grant status before submitting. |
| 4–7 | One follow-up per non-responder: “Closing the loop — is this useful or should I stop?” No new link, no new ask. |
| 8 | Stop. Record outcomes. Do not start a second wave without new evidence. |

**Follow-up template:**

```text
Closing the loop on the note below — is this useful, or should I stop?

No reply needed if it is not a fit. I will not send another message either way.

[NAME]
```

---

## 7. Tracking

Maintain `docs/email-prospects.csv` (public addresses only) with:
`target, route, segment, sent_at, replied, tester, intents_tested, false_pass, next_action`.

Also record:

- `/usage` before the first send and 7 days after (`total`, `byClient`,
  `byVerdict`). A call is not a unique tester; only a reply is.
- Any false PASS with the exact intent, verdict, reason codes, and block.
- Suppression list: anyone who replies “no” or objects.

**Success for round 1 is not opens.** It is: at least one reply, at least one
person who ran an intent, and zero overclaims. If nobody replies, the honest
conclusion is that cold email is the wrong channel for this audience — not that
the gate is bad.

---

## 8. Pre-send checklist

- [x] Postal address omitted by owner decision (CAN-SPAM risk accepted)
- [x] AgentMail account verified (OTP complete)
- [x] `AGENTMAIL_API_KEY` stored outside the repo
- [x] Test email sent and listed (`sent` label); inbound reply still untested
- [ ] Sender display name and signature agreed
- [ ] Four recipients re-checked against public routes
- [ ] No scraped addresses in the prospect file
- [ ] `/usage` baseline recorded
- [ ] Plain text, one link, no tracking
- [ ] Opt-out line in every draft
