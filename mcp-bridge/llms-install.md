# Installing verify402-mcp

Exact setup for Cline and other MCP clients. No npm account, no build step, no
API key required for the free tool.

## 1. Warm the npx cache once

The first run downloads the MCP SDK and `viem`. Some clients kill a server that
takes more than 30 seconds to start, so run this once first:

```bash
npx -y \
  --package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.4/verify402-mcp-1.0.4.tgz \
  verify402-mcp --help
```

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
        "--package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.4/verify402-mcp-1.0.4.tgz",
        "verify402-mcp"
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

Ask the agent to call `preflight_gate` with an ordinary 0.01 USDC Base payment:

```json
{
  "kind": "payment",
  "payment": {
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
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

Set a dedicated hot wallet that holds only what you are willing to spend:

```
EVM_PRIVATE_KEY=0x...          # omit for free-only
MAX_PAYMENT_USD=0.25           # hard cap on one payment, enforced before signing
MAX_DAILY_USD=0.50             # optional UTC-day cap
VERIFY402_NETWORKS=eip155:8453 # paid calls only
```

Never use a main wallet. The bridge signs x402 payments only; it never signs or
broadcasts a trade.

## Uninstall

Remove the `verify402` entry from the client MCP config and restart. No global
state is written except the optional spend ledger at `.spend-ledger.json`.
