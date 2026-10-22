# Try the free verify402 preflight gate

**5 minutes. No account, no API key, no wallet.**

`POST /preflight` is a free pre-signing gate for AI agents. Send it the payment
request or chain transaction your agent is about to sign. It answers
**PASS / CAUTION / BLOCK** with typed reasons, the checks that actually ran
(`checked`), the checks that did not (`notChecked`), and a short-lived HMAC
receipt bound to that exact intent and a fresh pinned block.

Live: **https://verify402.onrender.com**

> Free hosting: the first call after a sleep can take ~30 s. Run the curl once
> to warm it; later calls are fast.
>
> The public demo settles payments in **Base Sepolia testnet USDC**
> (`eip155:84532`). The analysis reads mainnet chain data; this is not a
> mainnet payment service. The free gate itself never moves funds.

---

## 1. One free call — a normal x402 payment

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
      "resource": "https://verify402.onrender.com/verify",
      "maxTimeoutSeconds": 60
    },
    "policy": { "maxAmountUsd": 0.25 }
  }'
```

`amount` is in raw units: `10000` = **0.01 testnet USDC** (6 decimals).
`network` `eip155:84532` is Base Sepolia, the public demo's payment rail.
`asset` is canonical testnet USDC on Base Sepolia. The analysis routes still
read mainnet chain data; only the payment rail is testnet.

You should get:

```json
{
  "verdict": "PASS",
  "sign_allowed": true,
  "requires_ack": false,
  "checked": ["scheme","network","asset","amount","payee","resource","timeout","block_freshness"],
  "notChecked": ["recipient reputation","sanctions screening","payment signature / signed payload","facilitator settlement","off-chain promises","payer_balance"],
  "block": { "number": 52814257, "ageSeconds": 0 },
  "receipt": { "id": "pf_...", "expiresAt": "...", "signature": "..." }
}
```

Your block number will differ. `sign_allowed` is simply
`verdict !== "BLOCK"`; a CAUTION still needs a human/agent decision.

## 2. The same gate says no to an unlimited approval

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
const gate = await fetch("https://verify402.onrender.com/preflight", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(intent),
}).then((r) => r.json());

const check = await fetch("https://verify402.onrender.com/preflight/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ receipt: gate.receipt }),
}).then((r) => r.json());

if (!check.valid) throw new Error(`receipt rejected: ${check.reason}`);
```

A tampered receipt returns `{ "valid": false, "reason": "bad_signature" }`.
Receipts expire after 90 seconds by default (15–300 configurable via
`ttlSeconds`). Re-call the gate instead of reusing an expired one.

## 4. Use it as an MCP tool (free-only mode needs no wallet)

Warm the `npx` cache once:

```bash
npx -y verify402-mcp@1.0.4 --help
```

This pins the published `1.0.4` package. The `1.0.5` source in this repository is an unpublished candidate; move the pin only after it is published and verified.

Then add it to Claude Desktop / Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp@1.0.4"],
      "env": { "VERIFY402_URL": "https://verify402.onrender.com" }
    }
  }
}
```

With no `EVM_PRIVATE_KEY`, the server registers only `preflight_gate`. Nothing
can be charged. The five paid measurement tools stay off.

## 5. Enforce it where the signing happens

The MCP tool is advisory: it cannot stop an agent that ignores the answer. The
enforcement belongs in the executor. [`preflight-guard.mjs`](./preflight-guard.mjs)
is a dependency-free, deny-by-default wrapper:

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

That last item is the metric that matters. It is free and unlimited; the paid
endpoints (`/verify`, `/safety`, `/route`, `/quotecheck`, `/depth`) are separate
and not needed for this test.

---

- Home: https://verify402.onrender.com
- Preflight page: https://verify402.onrender.com/preflight
- Machine docs: https://verify402.onrender.com/docs
- MCP page: https://verify402.onrender.com/mcp
- Source / issues: https://github.com/a32116150-ctrl/verify402
