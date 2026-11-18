# Installing verify402-mcp

Exact setup for Cline and other MCP clients. No npm account, no build step, no
API key required for the free tool.

The service is live on **Base mainnet** (`eip155:8453`): paid calls settle in
real USDC, and the analysis reads mainnet chain data. A Base Sepolia testnet
demo (`eip155:84532`, testnet USDC
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, https://verify402.onrender.com)
is available if you want to try the payment rail without spending real money.

## 1. Warm the npx cache once

The first run downloads the MCP SDK and `viem`. Some clients kill a server that
takes more than 30 seconds to start, so run this once first:

```bash
npx -y verify402-mcp@1.1.6 --help
```

This pins the published `1.1.6` package. Paid tools default to real USDC on Base mainnet at https://vex402.online; the testnet demo is an explicit opt-in.

Expected: a usage line listing the free tools (`preflight_gate`, `inspect_402`, `directory_402`) and the five paid tools.

## 2. Add the MCP server

Free gate only — no wallet, nothing can be charged:

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": [
        "-y",
        "verify402-mcp@1.1.6"
      ],
      "env": {
        "VERIFY402_URL": "https://vex402.online"
      }
    }
  }
}
```

Restart the client. The registered free tools are `preflight_gate`, `inspect_402`, and `directory_402`.

## 3. Test it

Ask the agent to call `preflight_gate` with an ordinary 0.01 USDC payment on the live Base mainnet rail:

```json
{
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
  "policy": { "maxAmountUsd": 0.25 }
}
```

Expected: `verdict: PASS`, `sign_allowed: true`, and a short-lived receipt.

Then test the failure path: an unlimited USDC approve with
`policy.forbidUnlimitedApproval: true`. Expected: `verdict: BLOCK`, reason
`unlimited_approval`, `sign_allowed: false`.

## 4. Optional: paid tools

Set a dedicated hot wallet that holds only a small amount of USDC on Base mainnet:

```
EVM_PRIVATE_KEY=0x...           # omit for free-only
MAX_PAYMENT_USD=0.25            # hard cap on one payment, enforced before signing
MAX_DAILY_USD=0.50              # optional UTC-day cap
VERIFY402_NETWORKS=eip155:8453  # default: Base mainnet, real USDC
```

Never use a main wallet. The bridge signs x402 payments only; it never signs or
broadcasts a trade. For the Base Sepolia testnet demo instead, set
`VERIFY402_URL=https://verify402.onrender.com` and
`VERIFY402_NETWORKS=eip155:84532`; the two rails are never mixed, and an
unexpected network is refused before signing.

## Uninstall

Remove the `verify402` entry from the client MCP config and restart. No global
state is written except the optional spend ledger at `.spend-ledger.json`.
