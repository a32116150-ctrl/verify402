# Follow-up wave — Oct 27–30, 2026

**Status:** prepared, not sent. The first campaign emails went out **2026-10-23**.
This is the one allowed follow-up per recipient, 4–7 days later.

**Rules**

- One follow-up maximum. If the original message is available, reply in the same thread and keep its subject; if sending a new message, use “Following up:” rather than a fake “Re:”. Do not start a second thread.
- No new cold recipients until AgentMail's cap clears on **2026-10-30T12:17:03Z**.
  Resend on `anoir.space` is verified and is the primary sender.
- Five messages, not fifty. The goal is a tester or a listing fix, not impressions.
- No mainnet payment offer. No funding claim. No "safe" or "guaranteed."
- Link to `/testers` for the ask and to the one blog post that fits the recipient.
- Track replies in `docs/email-prospects.csv`; update `HISTORY` only after a send.

**Send window:** Oct 27 (Tue) through Oct 30 (Fri), one batch per day. If a
recipient replied in the meantime, answer that reply instead of sending this.

---

## 1. Glama — listing correction

**To:** `support@glama.ai`
**Subject:** Re: verify402 MCP listing — 1.0.8 is current (ticket #148620911)

```text
Hi Glama team — following up once on ticket #148620911.

The listing still points at verify402-mcp 1.0.2. The current npm release is
1.0.8, and the install command is:

  npx -y verify402-mcp@latest

The 1.0.8 release adds caller-supplied payout allowlists, obligation checks
(caller-supplied idempotency key and cumulative spend/grant), and a receipt
binding that an executor can verify before signing. The listing description
does not need to change; only the version/tarball reference does.

If it is easier, the package page is https://www.npmjs.com/package/verify402-mcp
and the source is https://github.com/a32116150-ctrl/verify402.

No rush, and no need to reply if the queue already has this. Thanks.

— verify402
```

**Why this one:** transactional, not a pitch. It corrects a stale version that
misleads anyone installing from the directory.

---

## 2. Cloudflare x402 — falsification test

**To:** `x402@cloudflare.com`
**Subject:** Following up: a free pre-signing gate for x402 intents

```text
Hi x402 team — one follow-up on the free pre-signing gate.

The gate takes an x402 payment request (scheme, network, asset, raw amount,
payTo, resource, timeout) and returns PASS / CAUTION / BLOCK with typed
reasons, the checks that ran, the checks that did not, and a short-lived
receipt bound to the exact intent. It is read-only and free; the public demo
settles Base Sepolia testnet only.

The ask is narrow: three intents, one expected pass, one uncertain, one
expected block. If a swapped payTo or a lookalike asset still gets a PASS,
that is the finding worth having.

Tester kit: https://verify402.onrender.com/testers
Scope note: https://verify402.onrender.com/blog/what-a-pre-signing-gate-can-check

If this is not the right team, a pointer to whoever owns x402 developer
tooling is enough. No call needed.

— verify402
```

**Why this one:** the gate checks the exact object Cloudflare co-launched. The
scope post preempts the "what doesn't it catch" question.

---

## 3. MetaMask — approval warnings

**To:** `hello@metamask.io`
**Subject:** Following up: the approval screen and a pre-signing check

```text
Hi MetaMask team — following up once on the pre-signing gate.

The gate decodes approve / transfer / transferFrom / permit and common V2/V3
swap selectors, flags an unlimited approval or an unknown spender, checks the
swap deadline and minimum output, and can simulate the call from the signer
when a `from` address is supplied. It returns PASS / CAUTION / BLOCK plus a
receipt; it never signs or sends.

The integration question is whether a check like this belongs behind the
approval warning, not only in a separate dashboard. The free HTTP endpoint and
MCP tool are both public.

Test it with the unlimited-approval sample:
https://verify402.onrender.com/testers

No partnership ask and no mainnet payment offer. If the answer is "we already
do this in-house," that is useful too.

— verify402
```

**Why this one:** MetaMask owns the exact UI where the bad approval is shown.
The message asks a product question, not for a meeting.

---

## 4. Privy — embedded wallets

**To:** `hi@privy.io`
**Subject:** Following up: embedded wallets and a pre-signing check

```text
Hi Privy team — one follow-up on the pre-signing gate.

Embedded wallets remove the wallet UI, which also removes the last human
glance at an approval. The gate is a read-only HTTP/MCP call that checks the
intent before the signer runs: network, asset, amount, payee, resource,
approval shape, calldata against policy, and block freshness. It returns
PASS / CAUTION / BLOCK and a receipt bound to the exact intent.

The useful test is not "does it pass a normal payment" — it is whether a
swapped payee or an unlimited approval gets stopped before the signer.

Tester kit: https://verify402.onrender.com/testers
Receipt note: https://verify402.onrender.com/blog/a-receipt-is-a-falsifiable-record

If your team already has a policy engine, the only question is whether an
intent-bound receipt would make it easier to audit. No call needed.

— verify402
```

**Why this one:** embedded wallets are the clearest "no human at the signing
screen" use case. The receipt post answers the audit question.

---

## 5. OpenZeppelin — approval safety

**To:** `contact@openzeppelin.com`
**Subject:** Following up: a free falsification test for an approval gate

```text
Hi OpenZeppelin team — following up once on the free pre-signing gate.

The gate checks payment and transaction intents before signing: unlimited
approvals, spenders, swap deadlines, zero minimum output, output recipients,
x402 payee/asset/amount/resource mismatches, and block freshness. It returns
PASS / CAUTION / BLOCK with typed reasons and a receipt.

I am not asking for an audit or a endorsement. I am asking for the failure
case: an intent the gate passes that your team believes is unsafe. If it is
reproducible, I will fix it and publish what changed.

Unlimited-approval sample and the three-intent ask:
https://verify402.onrender.com/testers

Scope, stated plainly:
https://verify402.onrender.com/blog/what-a-pre-signing-gate-can-check

— verify402
```

**Why this one:** OpenZeppelin is the right audience for a false-PASS challenge,
not a product pitch. The message explicitly disclaims an audit ask.

---

## Tracking table

| Target | Address | Send date | Reply | Outcome | Next |
|---|---|---|---|---|---|
| Glama | support@glama.ai |  |  |  |  |
| Cloudflare x402 | x402@cloudflare.com |  |  |  |  |
| MetaMask | hello@metamask.io |  |  |  |  |
| Privy | hi@privy.io |  |  |  |  |
| OpenZeppelin | contact@openzeppelin.com |  |  |  |  |

After Oct 30, the remaining wave-1 recipients can get the same one-follow-up
treatment if they have not replied. Do not send a second follow-up to anyone.
