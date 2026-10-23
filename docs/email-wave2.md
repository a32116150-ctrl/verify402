# Email campaign — wave 2 (6 prospects)

**Status:** **5 of 6 sent** at 2026-10-23T13:17 UTC (MetaMask, WalletConnect,
Circle, OpenZeppelin, Offchain Labs). **Privy is held**: the free account's
10-distinct-recipient cap is now exhausted and does not lift until
**2026-10-30T12:17Z** unless the plan is upgraded. Same rules as wave 1: plain
text, one link, no tracking, one follow-up maximum, opt-out in every message.
Postal address omitted by owner decision (CAN-SPAM risk accepted). Signer:
`verify402 <sankou7-1754@agentmail.to>`.

All six addresses were published as public **role** addresses on the
organizations’ GitHub org profiles on Oct 23 (no personal or scraped addresses).
They are general inboxes, so the ask is short and the routing is explicit: “if
this is the wrong team, tell me and I’ll stop.”

**Why these six:** wave 1 covered directories and the x402 protocol team. Wave 2
goes to the places where an intent becomes a signature — wallets, embedded
wallets, USDC, Arbitrum, and two security teams that can try to break the gate.

| # | Target | Public route | Why them |
|---|---|---|---|
| 1 | **MetaMask** | `hello@metamask.io` | Ships the approval warnings users see before signing. |
| 2 | **WalletConnect** | `contact@walletconnect.com` | Sits between dapps and wallets at the signing boundary. |
| 3 | **Circle** | `devmarketing@circle.com` | USDC is the asset in the demo; developer marketing can route. |
| 4 | **OpenZeppelin** | `contact@openzeppelin.com` | Maintains approval/security tooling; falsification test. |
| 5 | **Offchain Labs** | `info@offchain.io` | Arbitrum (42161) is supported by the transaction gate. |
| 6 | **Privy** | `hi@privy.io` | Embedded wallets sign without a wallet UI to catch a bad approval. |

**Cap:** these six complete wave 2. Do not add more until at least one reply or a
false-PASS finding. More volume from a new `@agentmail.to` domain is a
deliverability risk, not a growth strategy.

---

## Drafts

### 1. MetaMask

**Subject:** `Pre-signing approval check - would a falsification test be useful?`

```text
Hi MetaMask team,

I am the solo developer behind verify402, a free pre-signing gate for EVM
transaction intents. It returns PASS/CAUTION/BLOCK with typed reasons and an
explicit notChecked list; it never moves funds and needs no wallet.

You ship the approval warnings users see before signing, so I am asking the team
closest to that moment: would a falsification test be useful? Run 3-5 approvals
or swaps you would otherwise sign in the browser and tell me where the gate
returns a false PASS. Demo payments are Base Sepolia; analysis reads mainnet; no
paid test.

Browser: https://verify402.onrender.com/preflight#try
MCP: https://verify402.onrender.com/mcp

It checks the transaction, not the token's sellability or the counterparty's
reputation; those are named in notChecked.

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 2. WalletConnect

**Subject:** `Pre-signing gate for wallet-signed intents - tester ask`

```text
Hi WalletConnect team,

verify402 is a free pre-signing gate for EVM transaction intents and x402 payment
requests. It returns PASS/CAUTION/BLOCK with typed reasons, the checks that ran,
and a notChecked list. No wallet, no funds moved.

WalletConnect sits between dapps and wallets, at the exact point where an intent
becomes a signature. Would a falsification test be useful? Run 3-5 intents you
would otherwise sign and tell me where it returns a false PASS. Demo payments are
Base Sepolia; analysis reads mainnet; no paid test.

Browser: https://verify402.onrender.com/preflight#try
MCP: https://verify402.onrender.com/mcp

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 3. Circle

**Subject:** `USDC approval checks before signing - tester ask`

```text
Hi Circle team,

verify402 is a free pre-signing gate for x402 payment requests and EVM
transaction intents. USDC is the asset in the demo; the gate checks network,
asset, amount, payee, and approval calldata before anything is signed. No wallet,
no paid test.

I am looking for three builders to run 3-5 real intents and report false PASSes.
Since Circle owns the asset and the developer surface, an intro to the right
developer-relations or x402 contact would help. No grant ask.

Browser: https://verify402.onrender.com/preflight#try
MCP: https://verify402.onrender.com/mcp

If this is not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 4. OpenZeppelin

**Subject:** `Falsification test for a pre-signing approval gate?`

```text
Hi OpenZeppelin team,

I am the solo developer behind verify402, a free fail-closed pre-signing gate for
EVM transaction intents. It returns PASS/CAUTION/BLOCK with typed reasons,
checked/notChecked lists, and a short-lived receipt; it never moves funds.

You maintain the approval and security tooling many teams rely on, so I am asking
for a falsification test rather than a review: run 3-5 intents (an unlimited
approval, a swap, a payment) and try to make the gate return a false PASS. No
wallet, no paid test; demo payments are Base Sepolia, analysis reads mainnet.

Browser: https://verify402.onrender.com/preflight#try
MCP: https://verify402.onrender.com/mcp

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 5. Offchain Labs

**Subject:** `Arbitrum intents in a free pre-signing gate - tester ask`

```text
Hi Offchain team,

verify402 is a free pre-signing gate for EVM transaction intents. It supports
Arbitrum (42161) alongside Ethereum and Base: chainId, target, calldata, value,
then PASS/CAUTION/BLOCK with typed reasons and a notChecked list. No wallet, no
funds moved.

Would the team run 3-5 Arbitrum intents you would otherwise sign and report any
false PASS? Demo payments are Base Sepolia; analysis reads Arbitrum mainnet; no
paid test.

Browser: https://verify402.onrender.com/preflight#try
MCP: https://verify402.onrender.com/mcp

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```

### 6. Privy

**Subject:** `Pre-signing gate before embedded-wallet signing - tester ask`

```text
Hi Privy team,

verify402 is a free pre-signing gate for EVM transaction intents. It returns
PASS/CAUTION/BLOCK with typed reasons and an explicit notChecked list; it never
moves funds and needs no wallet.

Embedded wallets sign on behalf of users, often without a wallet UI to catch a bad
approval. Would a falsification test be useful? Run 3-5 intents you would
otherwise sign and tell me where the gate returns a false PASS. No paid test; demo
payments are Base Sepolia, analysis reads mainnet.

Browser: https://verify402.onrender.com/preflight#try
MCP: https://verify402.onrender.com/mcp

If this is the wrong team or not useful, reply "no" and I will not follow up.

verify402
Solo developer
sankou7-1754@agentmail.to
```
