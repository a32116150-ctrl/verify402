# Preflight payloads and policy recipes

Exact shapes for `POST /preflight` and the MCP `preflight_gate` tool. The MCP
tool accepts the same fields as the JSON body.

## Base Sepolia testnet constants

Used by the public demo. Do not substitute these for mainnet values.

| Item | Value |
|---|---|
| Network | `eip155:84532` (Base Sepolia) |
| Chain id | `84532` |
| Testnet USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Demo payee | `0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb` |
| Demo host | `verify402.onrender.com` |

The public demo settles payments in testnet USDC. The analysis routes read
mainnet chain data. A testnet payment is not mainnet revenue.

## Payment intent

```json
{
  "kind": "payment",
  "chainId": 84532,
  "from": "0xYourPayerAddress",
  "payment": {
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "10000",
    "payTo": "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
    "resource": "https://verify402.onrender.com/verify",
    "idempotencyKey": "order-123-payment-1",
    "maxTimeoutSeconds": 60,
    "extra": {
      "validAfter": 0,
      "validBefore": 1760000000,
      "facilitator": "https://facilitator.example"
    }
  },
  "policy": {
    "maxAmountUsd": 0.25,
    "allowedNetworks": ["eip155:84532"],
    "allowedPayTo": ["0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb"],
    "allowedAssets": ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
    "expectedResource": "https://verify402.onrender.com/verify",
    "allowedResourceHosts": ["verify402.onrender.com"],
    "maxTimeoutSeconds": 60
  }
}
```

Notes:

- `amount` is raw units. `10000` is `0.01` for 6 decimals. Always copy the
  amount from the 402; do not compute it with floating point.
- `payment.extra` is optional. If the 402 carries `validAfter`, `validBefore`,
  or `facilitator`, copy them exactly.
- `payment.idempotencyKey` is caller-local. It is not the paid-route
  `x-idempotency-key` HTTP header.
- `chainId` is optional for payments but cross-checks `payment.network`.
- `from` enables simulation and balance checks. Without `from` or a payment
  proof, expect `structural_only: true` on an otherwise passing response.

## Transaction intent

```json
{
  "kind": "transaction",
  "chainId": 8453,
  "from": "0xYourPayerAddress",
  "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "data": "0x095ea7b300000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000001",
  "value": "0",
  "policy": {
    "allowedTo": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    "allowedSpenders": ["0x1111111111111111111111111111111111111111"],
    "forbidUnlimitedApproval": true,
    "maxValueWei": "0"
  }
}
```

Notes:

- `chainId` is required. Supported measurement chains are Ethereum `1`,
  Arbitrum `42161`, and Base `8453`. Base Sepolia `84532` and Ethereum Sepolia
  `11155111` are accepted structurally for payments, but do not have pinned
  measurement blocks. Solana mainnet/devnet are accepted structurally as well.
- `to` is required.
- `data` must be even-length hex. The gate caps it at 32 KiB.
- `value` is wei as a decimal string.
- Include `from` whenever possible. Without it the simulation is skipped and
  the gate will say so.
- The gate decodes an on-chain `permit(...)` call, but it does not evaluate an
  off-chain EIP-712 typed-data permit. Treat typed-data signing as outside this
  intent shape.

## Policy recipes

### Conservative x402 payment

```json
{
  "maxAmountUsd": 0.25,
  "allowedNetworks": ["eip155:84532"],
  "allowedPayTo": ["0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb"],
  "allowedAssets": ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
  "expectedResource": "https://verify402.onrender.com/verify",
  "allowedResourceHosts": ["verify402.onrender.com"],
  "maxTimeoutSeconds": 60
}
```

This is the right shape for “pay this one demo route, on this network, to this
payee, for no more than this amount.” Adjust the addresses for your own seller.

### Transaction approval

```json
{
  "allowedTo": ["0xTokenOrRouter"],
  "allowedSpenders": ["0xSpender"],
  "forbidUnlimitedApproval": true,
  "maxValueWei": "0"
}
```

`forbidUnlimitedApproval` turns an `approve(spender, 2^256-1)` into `BLOCK`.
It does not make a finite approval safe; the spender still matters.

### Grant or budget with replay protection

```json
{
  "maxAmountUsd": 0.25,
  "allowedNetworks": ["eip155:84532"],
  "allowedPayTo": ["0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb"],
  "obligation": {
    "settledKeys": ["order-122-payment-1"],
    "spentUsd": 0.15,
    "grantUsd": 1.0
  }
}
```

Pair this with `payment.idempotencyKey`. A key already in `settledKeys` is a
`BLOCK`; adding the current payment to `spentUsd` above `grantUsd` is a
`BLOCK`. The public gate does not persist this state. If you omit it, replay and
cumulative spend stay in `notChecked`.

### Seller payout allowlist

```json
{
  "sellerPayoutWallets": ["0xSellerWallet"]
}
```

This is only an allowlist. A match adds `payee_payout_allowlist` and leaves
“independent payee ownership proof” in `notChecked`. It does not prove the
seller supplied the list.

### Seller-signed payout manifest

```json
{
  "sellerPayoutManifest": {
    "url": "https://seller.example/.well-known/verify402-seller-payout.json",
    "expectedSigner": "0xSellerSigner"
  }
}
```

The URL must be HTTPS, public, and outside the 402. The gate fetches it with
redirects disabled and a 3-second timeout. Only a verified manifest adds
`payee_payout_binding`. It still cannot tell whether the caller copied the URL
from the 402; origin trust is the caller's job.

Manifest shape accepted by the gate:

```json
{
  "spec": "verify402/seller-payout@1",
  "seller": "example-seller",
  "chainId": 8453,
  "payTo": ["0xSellerWallet"],
  "issuedAt": "2026-10-24T00:00:00.000Z",
  "expiresAt": "2026-11-24T00:00:00.000Z",
  "signer": "0xSellerSigner",
  "signature": "0x..."
}
```

The signature covers the canonical stable form of `spec`, `seller`, `chainId`,
`payTo`, `issuedAt`, `expiresAt`, and `signer`. Use the server's implementation
in `src/preflight.mjs` as the reference; do not invent a different
canonicalization.

## MCP mapping

The MCP tool takes the same fields, flattened at the top level:

```text
preflight_gate({
  kind: "payment",
  chainId: 84532,
  from: "0x...",
  payment: { ... },
  policy: { ... },
  ttlSeconds: 90
})
```

For a transaction:

```text
preflight_gate({
  kind: "transaction",
  chainId: 8453,
  from: "0x...",
  to: "0x...",
  data: "0x...",
  value: "0",
  policy: { ... }
})
```

The MCP bridge posts the same object to `/preflight`. The free gate works with
no wallet; the paid tools are registered only when the bridge has a wallet.

## Response shape

A passing payment response looks like this (abridged; your block and receipt
will differ):

```json
{
  "ok": true,
  "spec": "verify402/preflight@1",
  "kind": "payment",
  "verdict": "PASS",
  "sign_allowed": true,
  "requires_ack": false,
  "structural_only": false,
  "summary": "PASS: every check in `checked` passed at this block. See `notChecked` for what was not covered.",
  "reasons": [],
  "checked": [
    "scheme",
    "network",
    "asset",
    "amount",
    "payee",
    "resource_url",
    "resource_host",
    "timeout",
    "block_freshness"
  ],
  "notChecked": [
    "recipient reputation",
    "sanctions screening",
    "payment signature / signed payload",
    "facilitator settlement",
    "off-chain promises",
    "counterparty identity / tool metadata",
    "payTo ownership / proven seller payout wallet",
    "obligation state (idempotency key, cumulative spend, grant balance)",
    "prompt injection / hidden Unicode in tool output"
  ],
  "block": { "number": 52814257, "ageSeconds": 0 },
  "receipt": {
    "spec": "verify402/preflight-receipt@1",
    "id": "pf_...",
    "intentHash": "0x...",
    "requestHash": "0x...",
    "expiresAt": "2026-10-24T12:00:00.000Z",
    "signature": "0x..."
  },
  "note": "A PASS is not a guarantee..."
}
```

`checked` and `notChecked` are the honest pair. Do not report one without the
other.

## cURL

```bash
curl -sS -X POST https://verify402.onrender.com/preflight \
  -H 'content-type: application/json' \
  --data-binary @intent.json
```

For a receipt check:

```bash
curl -sS -X POST https://verify402.onrender.com/preflight/verify \
  -H 'content-type: application/json' \
  --data-binary @verify.json
```

where `verify.json` is:

```json
{
  "receipt": { "...": "the receipt object" },
  "request": { "...": "the exact body sent to /preflight" },
  "intent": { "...": "the normalized intent returned by /preflight" }
}
```

Send both `request` and `intent` when the signature is at stake. Request-only
verification leaves `intentBound: false`; receipt-only verification leaves both
bindings false.
