# Email campaign — wave 3 (5 prospects)

**Status:** **5 sent** via Resend on 2026-10-23T13:31 UTC. Four delivered
(Rabby, Rainbow, Turnkey, Wallet Guard); **Safe bounced** — `info@safe.global`
returned `550 5.1.1 no such user` even though it is published on Safe's imprint.
Use Safe's official contact form or drop it.

**Owner approval:** the original campaign cap was 3–5 targeted messages. The
owner explicitly approved this five-email extension on Oct 23 after `anoir.space`
was verified in Resend. Keep the same rules: plain text, one link, no tracking,
one follow-up maximum, opt-out in every message. Postal address omitted by owner
decision (CAN-SPAM risk accepted).

**Sender:** `verify402 <verify402@anoir.space>`; **Reply-To:**
`sankou7-1754@agentmail.to`. Resend free tier: 3,000/month, 100/day; do not
exceed 5–10 sends/day on a new domain.

| # | Target | Public route | Why them | Result |
|---|---|---|---|---|
| 1 | **Safe** | `info@safe.global` | Smart-account wallet; nested `execTransaction` calldata | **bounced** (550 no such user); use contact form |
| 2 | **Rabby** | `support@rabby.io` | Ships transaction previews before signing | delivered |
| 3 | **Rainbow** | `hello@rainbow.me` | Consumer wallet at the signing screen | delivered |
| 4 | **Turnkey** | `hello@turnkey.com` | Embedded wallets sign without a wallet UI | delivered |
| 5 | **Wallet Guard** | `team@walletguard.app` | Wallet security extension; transaction threat detection | delivered |

Address verification: `info@safe.global` from Safe's imprint; `support@rabby.io`
from Rabby's Terms/Privacy; `hello@rainbow.me` from Rainbow's App Store
description; `hello@turnkey.com` from Turnkey's contact page;
`team@walletguard.app` from Wallet Guard's site. No personal or scraped
addresses.

---

## Drafts as sent

### 1. Safe — bounced

**Subject:** `Nested Safe calldata in a pre-signing gate - falsification test?`

```text
Hi Safe team,

I am the solo developer behind verify402, a free pre-signing gate for EVM transaction intents. It returns PASS/CAUTION/BLOCK with typed reasons, the checks that ran, and an explicit notChecked list; it never moves funds and needs no wallet.

Safe is where a transaction becomes a multisig approval, so the nested call is the interesting part: a gate can look at the outer execTransaction and miss what the Safe actually does. Would a falsification test be useful? Run 3-5 Safe intents you would otherwise sign and tell me where verify402 returns a false PASS, especially on nested calldata.

Browser demo: https://verify402.onrender.com/preflight#try
Demo payments are Base Sepolia; analysis reads mainnet; no paid test. It checks the transaction, not the Safe's signer policy or the token's sellability; those are named in notChecked.

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 2. Rabby — delivered

**Subject:** `Independent pre-signing check - where does it false-PASS?`

```text
Hi Rabby team,

I am the solo developer behind verify402, a free pre-signing gate for EVM transaction intents. It returns PASS/CAUTION/BLOCK with typed reasons and a notChecked list; it never moves funds and needs no wallet.

Rabby already previews what a transaction will do, so I am not asking you to replace that. I am asking for a falsification test: run 3-5 intents you would otherwise sign and tell me where verify402 returns PASS on something Rabby would flag, or CAUTION/BLOCK on something benign. A false PASS is the finding I care about.

Browser demo: https://verify402.onrender.com/preflight#try
Demo payments are Base Sepolia; analysis reads mainnet; no paid test. It checks transaction structure, not token reputation or counterparty history; those are in notChecked.

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 3. Rainbow — delivered

**Subject:** `Pre-signing check before Rainbow signs - tester ask`

```text
Hi Rainbow team,

verify402 is a free pre-signing gate for EVM transaction intents. It returns PASS/CAUTION/BLOCK with typed reasons and an explicit notChecked list; it never moves funds and needs no wallet.

Rainbow is the last screen before a user signs, so a second, independent check is only useful if it catches something the wallet does not. Would you run 3-5 intents (an approval, a swap, a payment) and tell me where the gate returns a false PASS?

Browser demo: https://verify402.onrender.com/preflight#try
Demo payments are Base Sepolia; analysis reads mainnet; no paid test. It checks the transaction, not the token's sellability or the counterparty's reputation; those are named in notChecked.

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 4. Turnkey — delivered

**Subject:** `Pre-signing gate before embedded-wallet signing - tester ask`

```text
Hi Turnkey team,

verify402 is a free pre-signing gate for EVM transaction intents. It returns PASS/CAUTION/BLOCK with typed reasons and a notChecked list; it never moves funds and needs no wallet.

Embedded wallets sign on behalf of users, often without a wallet UI to catch a bad approval. You already enforce policy at signing; I am not asking you to replace that. I am asking for a falsification test: run 3-5 intents and tell me where verify402 returns a false PASS, or where it adds nothing over your policy engine.

Browser demo: https://verify402.onrender.com/preflight#try
Demo payments are Base Sepolia; analysis reads mainnet; no paid test.

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 5. Wallet Guard — delivered

**Subject:** `Falsification test for a pre-signing gate?`

```text
Hi Wallet Guard team,

I am the solo developer behind verify402, a free pre-signing gate for EVM transaction intents. It returns PASS/CAUTION/BLOCK with typed reasons and an explicit notChecked list; it never moves funds and needs no wallet.

Wallet Guard already blocks malicious sites and transactions, so I am not claiming to replace that. I am asking for a falsification test: run 3-5 intents you would otherwise sign and try to make verify402 return a false PASS. The interesting cases are unlimited approvals, odd spenders, and calldata that looks benign at the top level.

Browser demo: https://verify402.onrender.com/preflight#try
Demo payments are Base Sepolia; analysis reads mainnet; no paid test. It checks transaction structure, not threat intelligence or counterparty reputation; those are in notChecked.

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

---

## Message IDs

| Target | Resend ID | Last event |
|---|---|---|
| Safe | `01a168f5-e1d4-73e9-802f-1f800c13f087` | bounced (550 no such user) |
| Rabby | `01a168f5-e3f2-7542-9455-66f2c5f436fc` | delivered |
| Rainbow | `01a168f5-e5ec-7bad-b9b7-22dcd87f8704` | delivered |
| Turnkey | `01a168f5-e807-7883-97a0-703ff0f7c6aa` | delivered |
| Wallet Guard | `01a168f5-e9c6-7f2d-9a44-2a4d33f48e9c` | delivered |
