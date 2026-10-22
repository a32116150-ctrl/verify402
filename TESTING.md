# Test verify402's free preflight gate

**Time:** 5 minutes. **No wallet, account, or paid test required.**

**Looking for:** 3 developers building AI agents, MCP tools, or x402 payment integrations.

verify402 is a preflight gate for agents before they sign or pay. Send it the payment request or transaction intent your agent is about to sign. It returns `PASS` / `CAUTION` / `BLOCK`, the checks that ran, the checks that did not, and a short-lived HMAC receipt.

## Scope and safety

- The public demo uses **Base Sepolia testnet USDC** (`eip155:84532`).
- The analysis reads mainnet chain data, but the demo does not settle mainnet payments.
- The preflight gate itself never moves funds.
- **Do not send mainnet funds for this test.**
- A `PASS` means the listed checks passed at that pinned block. It is not a safety guarantee, contract audit, sanctions screen, or reputation check. Read `notChecked` in every response.
- Never send private keys, seed phrases, or unredacted wallet data. Redact addresses and amounts if needed.

## 1. Run one free payment intent

```bash
curl -sS -X POST https://verify402.onrender.com/preflight \
  -H 'content-type: application/json' \
  -d '{
    "kind": "payment",
    "payment": {
      "scheme": "exact",
      "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "10000",
      "payTo": "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
      "resource": "https://verify402.onrender.com/verify"
    },
    "policy": { "maxAmountUsd": 0.25 }
  }'
```

`amount` is raw units: `10000` = 0.01 testnet USDC (6 decimals). The analysis routes read mainnet data; this payment rail is Base Sepolia.

Expect JSON with `verdict`, `checked`, `notChecked`, `block`, and `receipt`. A first call after idle can take ~30 seconds on the free host.

## 2. Try intents your agent would actually sign

Run 3–5 of these, not just the sample:

- a normal x402 payment;
- a payment with the wrong chain, asset, amount, or payee;
- an unlimited ERC-20 approval;
- a transaction your agent would really sign.

The unlimited-approval check is a useful negative test:

```bash
curl -sS -X POST https://verify402.onrender.com/preflight \
  -H 'content-type: application/json' \
  -d '{
    "kind": "transaction",
    "chainId": 8453,
    "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "data": "0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "value": "0",
    "policy": { "forbidUnlimitedApproval": true }
  }'
```

Expected: `BLOCK` with `unlimited_approval`. No payment is made.

## 3. Optional: use the MCP tool

Free-only mode needs no wallet. Add this to your MCP client:

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp@latest"],
      "env": { "VERIFY402_URL": "https://verify402.onrender.com" }
    }
  }
}
```

With no `EVM_PRIVATE_KEY`, only the free `preflight_gate` tool is registered. Paid tools are separate and not needed for this test.

## 4. Send feedback

Open a tester feedback issue:

https://github.com/a32116150-ctrl/verify402/issues/new?template=tester-feedback.yml

Include:

1. the client or agent you used;
2. the redacted intent;
3. the verdict and `reasons`;
4. anything that looks like a **false PASS** — an intent the gate allowed that you believe is unsafe;
5. setup friction and what would make it worth integrating.

If you prefer, reply in the thread where you found this.

## Limits

- Free gate: 60 requests/min per IP, 8 concurrent.
- Receipts expire after 90 seconds by default.
- The free host may sleep; the first call can take ~30 seconds.
- The paid endpoints (`/verify`, `/safety`, `/route`, `/quotecheck`, `/depth`) are separate and not required.

## What I will do with the feedback

I’m the solo developer. I’ll fix reproducible bugs, reply with what changed, and publish an anonymized summary if enough testers run the gate. Tell me if you want credit by handle or to stay anonymous.

- Live preflight page: https://verify402.onrender.com/preflight
- MCP page: https://verify402.onrender.com/mcp
- Source: https://github.com/a32116150-ctrl/verify402
- Full onboarding: [examples/ONBOARDING.md](examples/ONBOARDING.md)
