# Installing verify402-mcp

Exact setup for Cline and other MCP clients. No npm account, no build step, no
API key required for the free tool.

The public demo is **testnet for payments** (Base Sepolia, `eip155:84532`) and
reads mainnet chain data for analysis. It is not a mainnet payment service.

## 1. Warm the npx cache once

The first run downloads the MCP SDK and `viem`. Some clients kill a server that
takes more than 30 seconds to start, so run this once first:

```bash
npx -y verify402-mcp@1.0.7 --help
```

This pins the published `1.0.7` package. Paid tools in the public demo use Base Sepolia testnet USDC; mainnet settlement is not enabled by this release.

Expected: a usage line listing `preflight_gate` and the five paid tools.

## 2. Add the MCP server

Free gate only — no wallet, nothing can be charged:

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": [
        "-y",
        "verify402-mcp@1.0.7"
      ],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com"
      }
    }
  }
}
```

Restart the client. The registered tool is `preflight_gate`.

## 3. Test it

Ask the agent to call `preflight_gate` with an ordinary 0.01 testnet USDC payment on the public demo's Base Sepolia rail:

```json
{
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
}
```

Expected: `verdict: PASS`, `sign_allowed: true`, and a short-lived receipt.

Then test the failure path: an unlimited USDC approve with
`policy.forbidUnlimitedApproval: true`. Expected: `verdict: BLOCK`, reason
`unlimited_approval`, `sign_allowed: false`.

## 4. Optional: paid tools

Set a dedicated hot wallet that holds only testnet USDC for the public demo:

```
EVM_PRIVATE_KEY=0x...           # omit for free-only
MAX_PAYMENT_USD=0.25            # hard cap on one payment, enforced before signing
MAX_DAILY_USD=0.50              # optional UTC-day cap
VERIFY402_NETWORKS=eip155:84532 # public demo: Base Sepolia testnet
```

Never use a main wallet. The bridge signs x402 payments only; it never signs or
broadcasts a trade. `eip155:8453` (Base mainnet) is reserved for a future,
explicit mainnet deployment; do not point it at the public demo, because the
live 402 offers the testnet rail and the bridge will fail closed.

## Uninstall

Remove the `verify402` entry from the client MCP config and restart. No global
state is written except the optional spend ledger at `.spend-ledger.json`.
