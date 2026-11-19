# Try the free verify402 preflight gate

**5 minutes. No account, no API key, no wallet.**

`POST /preflight` is a free pre-signing gate for AI agents. Send it the payment
request or chain transaction your agent is about to sign. It answers
**PASS / CAUTION / BLOCK** with typed reasons, the checks that actually ran
(`checked`), the checks that did not (`notChecked`), and a short-lived HMAC
receipt bound to that exact intent, the request body, and a fresh pinned block.

Live: **https://vex402.online**

> The live service settles payments in **real USDC on Base mainnet**
> (`eip155:8453`). The free gate itself never moves funds. A Base Sepolia
> testnet demo (`eip155:84532`) is available at
> https://verify402.onrender.com — it runs on a free host, so the first call
> after a sleep can take ~30 s.

---

## 1. One free call — a normal x402 payment

```bash
curl -sS -X POST https://vex402.online/preflight \
  -H 'content-type: application/json' \
  -d '{
    "kind": "payment",
    "payment": {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "10000",
      "payTo": "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
      "resource": "https://vex402.online/verify",
      "maxTimeoutSeconds": 60
    },
    "policy": { "maxAmountUsd": 0.25, "allowedResourceHosts": ["vex402.online"] }
  }'
```

`amount` is in raw units: `10000` = **0.01 USDC** (6 decimals).
`network` `eip155:8453` is Base mainnet, the live payment rail.
`asset` is canonical USDC on Base. For the testnet demo, use `eip155:84532`
and testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

You should get:

```json
{
  "verdict": "PASS",
  "sign_allowed": true,
  "requires_ack": false,
  "checked": ["scheme","network","asset","amount","payee","resource_url","resource_host","timeout","block_freshness"],
  "notChecked": ["recipient reputation","sanctions screening","payment signature / signed payload","facilitator settlement","off-chain promises","counterparty identity / tool metadata","payTo ownership / proven seller payout wallet","obligation state (idempotency key, cumulative spend, grant balance)","prompt injection / hidden Unicode in tool output","payer_balance"],
  "block": { "number": 52814257, "ageSeconds": 0 },
  "receipt": {
    "spec": "verify402/preflight-receipt@1",
    "id": "pf_...",
    "intentHash": "…",
    "requestHash": "…",
    "expiresAt": "...",
    "signature": "..."
  }
}
```

Your block number will differ. `sign_allowed` is simply
`verdict !== "BLOCK"`; a CAUTION still needs a human/agent decision.

If your agent keeps its own payment ledger, add
`payment.idempotencyKey` and `policy.obligation` (`settledKeys`,
`spentUsd`, `grantUsd`) to reject an already-settled key or a payment
that would exceed the grant. Add `policy.sellerPayoutWallets` for a
caller-supplied payout allowlist, or `policy.sellerPayoutManifest` to fetch a
seller-signed manifest from a caller-pinned HTTPS origin. Only the manifest
adds `payee_payout_binding`; the allowlist alone does not. The public gate does
not persist the ledger, and neither form proves the seller controls the wallet.

## 2. The same gate says no to an unlimited approval

```bash
curl -sS -X POST https://vex402.online/preflight \
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

That calldata is USDC `approve(spender, 2^256-1)`. Expected:

```json
{
  "verdict": "BLOCK",
  "sign_allowed": false,
  "reasons": [
    { "code": "unlimited_approval", "severity": "block", "message": "approve grants an unlimited allowance and policy.forbidUnlimitedApproval is set" }
  ]
}
```

Add `"from": "0xYourPayerAddress"` to enable balance-delta simulation; without
it the response also carries a `simulation_skipped_no_from` caution.

## 3. Verify a receipt before you trust it

Every verdict includes a receipt. `POST /preflight/verify` recomputes the HMAC
and checks expiry, so an executor can refuse anything it cannot verify.

```js
const gate = await fetch("https://vex402.online/preflight", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(intent),
}).then((r) => r.json());

const check = await fetch("https://vex402.online/preflight/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  // `request` is the exact body sent to /preflight. The verifier re-hashes it,
  // so the receipt is bound to what this caller actually asked to sign.
  body: JSON.stringify({ receipt: gate.receipt, request: intent }),
}).then((r) => r.json());

if (!check.valid || check.requestBound !== true) {
  throw new Error(`receipt rejected: ${check.reason || "not bound to this request"}`);
}
```

A tampered receipt returns `{ "valid": false, "reason": "bad_signature" }`.
An altered request returns `request_mismatch`; a receipt issued before request
binding returns `missing_request_hash`; a receipt without an intent hash
returns `missing_intent_hash`. `intent` may also be supplied (using the
normalized object returned by the gate) for a second, independent hash check.
Receipt-only verification remains compatible but reports `intentBound:false`
and `requestBound:false`; require both when a signature is at stake.
Receipts expire after 90 seconds by default (15–300 configurable via
`ttlSeconds`). Re-call the gate instead of reusing an expired one.

## 4. Use it as an MCP tool (free-only mode needs no wallet)

Warm the `npx` cache once:

```bash
npx -y verify402-mcp@2.0.1 --help
```

This pins the published `2.0.1` package. Paid tools default to real USDC on Base mainnet at https://vex402.online; the Base Sepolia testnet demo is an explicit opt-in.

Then add it to Claude Desktop / Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp@2.0.1"],
      "env": { "VERIFY402_URL": "https://vex402.online" }
    }
  }
}
```

With no `EVM_PRIVATE_KEY`, the server registers only `preflight_gate`. Nothing
can be charged. The six paid checks stay off.

## 5. Enforce it where the signing happens

The MCP tool is advisory: it cannot stop an agent that ignores the answer. The
enforcement belongs in the executor. [`preflight-guard.mjs`](./preflight-guard.mjs)
is a small repo-local, deny-by-default wrapper:

```js
import { guardAndSign } from "./preflight-guard.mjs";

await guardAndSign({
  intent: { kind: "transaction", chainId: 8453, from: wallet.address, to, data, value: "0" },
  policy: { forbidUnlimitedApproval: true },
  sign: async (intent, { receipt }) => wallet.sendTransaction(intent),
});
```

`BLOCK`, a missing/expired/unverifiable receipt, or a 503 from the gate throws
**before** `sign` is called. `CAUTION` requires `acknowledgeCaution: true`.

---

## What this does not do

The gate catches measurable signing mistakes: wrong network or chain, a
non-canonical asset, an amount over your cap, a payee outside your allowlist, an
unlimited approval, a transfer that would revert, a stale block, a mismatched
resource. It does **not** screen recipient reputation or sanctions, audit a
contract, simulate balance-delta traces, or guarantee a token is safe. Those
limits are printed in `notChecked` on every response. A PASS means the checks in
`checked` passed at that block — nothing more.

## What I want from you

Run 3–5 intents your agent would actually sign (or has signed before). Send back:

1. the intent (redact addresses/amounts if you need to),
2. the verdict and `reasons`,
3. anything that looks like a **false PASS** — a transaction the gate passed
   that you believe is unsafe.

That last item is the metric that matters. The gate is free and rate-limited
(60 requests/min per IP, 8 concurrent), so no payment is needed; the paid
endpoints (`/verify`, `/safety`, `/route`, `/quotecheck`, `/depth`) are separate
and not needed for this test.

---

- Home: https://vex402.online
- Preflight page: https://vex402.online/preflight
- Machine docs: https://vex402.online/docs
- MCP page: https://vex402.online/mcp
- Source / issues: https://github.com/a32116150-ctrl/verify402
