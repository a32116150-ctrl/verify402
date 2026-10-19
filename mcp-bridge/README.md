# verify402 MCP bridge

Makes verify402's paid tools and its free pre-signing gate available to any
MCP client (Claude Desktop, OpenCode, Cursor, custom agents) with per-call x402
payment handled automatically.

## Tools

| tool | price | what it answers |
|---|---|---|
| `preflight_gate` | free | "Should I sign this payment request or transaction?" — PASS / CAUTION / BLOCK with reasons and a short-lived receipt |
| `verify_arbitrage` | $0.05 | "Is this cross-venue arbitrage opportunity real, right now?" |
| `check_token_safety` | $0.10 | "Is this token safe to buy?" — TRUST / CAUTION / AVOID with evidence |
| `get_best_route` | $0.03 | "What would the chain actually pay for this swap?" — best route + every quoted venue |
| `verify_quote_fairness` | $0.05 | "A broker/bot offered me this number — is it honest?" fair / overpaying / too_good_to_be_true |
| `get_trade_depth` | $0.05 | "How big can I trade here before the round trip eats me?" — per-size impact, round-trip cost, capacity |

`preflight_gate` is the front door. Call it before signing any crypto
transaction or x402 payment request. If `sign_allowed` is false, **do not
sign**. If `requires_ack` is true, surface the reasons to the operator. The
receipt expires (default 90s); call again instead of reusing it. It is free, so
it does not go through the paying client.

The gate is advisory at this layer: the bridge does not hold the agent's
transaction key and cannot stop an agent that ignores the answer. Enforcement
belongs in the executor that signs — verify the receipt, then sign. A tool
description is not a security boundary. See
[`examples/preflight-guard.mjs`](../examples/preflight-guard.mjs) for a
deny-by-default reference that refuses to call the signer without a verified
receipt.

## Setup

```bash
cd mcp-bridge
npm install
```

Create `.env` (this file holds the BUYER's key — the wallet that pays; never
commit it):

```
EVM_PRIVATE_KEY=0x...          # wallet with USDC on the payment network
VERIFY402_URL=https://your-deployment.example.com
MAX_PAYMENT_USD=0.25           # hard policy: refuse to sign any payment above this
```

## Wire into Claude Desktop (or any MCP client)

```json
{
  "mcpServers": {
    "verify402": {
      "command": "node",
      "args": ["/absolute/path/to/verify402/mcp-bridge/index.mjs"],
      "env": {
        "EVM_PRIVATE_KEY": "0x...",
        "VERIFY402_URL": "https://your-deployment.example.com",
        "MAX_PAYMENT_USD": "0.25"
      }
    }
  }
}
```

## Payment policy (load-bearing)

Before signing anything, the bridge enforces a spend cap:

- `MAX_PAYMENT_USD` (default $0.25) — the x402 client itself refuses to
  construct or sign a payment above this limit, before any signature exists.
  The default asset is USDC; unrecognized assets are rejected unless explicitly
  allowed in `spendControls`.

A bridge that signs whatever an arbitrary 402 asks for is a blank cheque.
This cap is enforced inside `x402Client` (`applySpendControls`), so removing
it from this file's config is a security regression, not a refactor.
