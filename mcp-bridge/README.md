# verify402-mcp

MCP server for **verify402**: a free, fail-closed **preflight gate** before an
agent signs a payment or a chain transaction, plus five paid on-chain checks
paid per call over x402.

Works with Claude Desktop, Cursor, OpenCode, and any MCP client that speaks
stdio. The free gate needs **no wallet**. The paid tools use a dedicated hot
wallet that pays in USDC; the bridge never signs or sends a trade.

## Tools

| tool | price | what it answers |
|---|---|---|
| `preflight_gate` | **free** | "Should I sign this payment request or transaction?" — PASS / CAUTION / BLOCK with reasons, `checked` / `notChecked`, and a short-lived receipt |
| `verify_arbitrage` | $0.05 | "Is this cross-venue arbitrage opportunity real, right now?" |
| `check_token_safety` | $0.10 | "Is this token safe to buy?" — TRUST / CAUTION / AVOID with evidence |
| `get_best_route` | $0.03 | "What would the chain actually pay for this swap?" — best route + every quoted venue |
| `verify_quote_fairness` | $0.05 | "A broker/bot offered me this number — is it honest?" fair / overpaying / too_good_to_be_true |
| `get_trade_depth` | $0.05 | "How big can I trade here before the round trip eats me?" — per-size impact, round-trip cost, capacity |

`preflight_gate` is the front door. Call it before signing any crypto
transaction or x402 payment request. If `sign_allowed` is false, **do not
sign**. If `requires_ack` is true, surface the reasons to the operator. The
receipt expires (default 90s); call again instead of reusing it.

The gate is advisory at this layer: the bridge does not hold the agent's
transaction key and cannot stop an agent that ignores the answer. Enforcement
belongs in the executor that signs — verify the receipt, then sign. See
[`examples/preflight-guard.mjs`](https://github.com/a32116150-ctrl/verify402/blob/master/examples/preflight-guard.mjs)
for a deny-by-default reference that refuses to call the signer without a
verified receipt.

## Run

The package is distributed as a GitHub release tarball today and as
`verify402-mcp` on npm once published. Either spec works with `npx`.

```bash
# GitHub release tarball (works today)
npx -y \
  --package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.0/verify402-mcp-1.0.0.tgz \
  verify402-mcp --help

# npm, once published
npx -y verify402-mcp --help
```

**Warm the cache first.** The first `npx` run installs the MCP SDK and `viem`;
some clients kill a server that takes more than 30 seconds to start. Run the
`--help` command once before adding it to an MCP client. After that, startup is
fast.

From source:

```bash
git clone https://github.com/a32116150-ctrl/verify402
cd verify402/mcp-bridge
npm ci
node index.mjs --help
```

## Free gate only (no key)

Omit `EVM_PRIVATE_KEY`. The server registers only `preflight_gate` and logs
`free preflight_gate only`. Nothing can be charged.

## Paid tools (dedicated hot wallet)

Set a wallet with USDC on the payment network. Use a wallet with only the money
you are willing to spend — never a main wallet. The key stays in your MCP client
configuration or environment; the package never contains it.

```
EVM_PRIVATE_KEY=0x...        # optional; omit for free-only
VERIFY402_URL=https://verify402.onrender.com
MAX_PAYMENT_USD=0.25         # hard cap on ONE payment, enforced at signature time
MAX_DAILY_USD=0.50           # optional cap for the UTC day, persisted
SPEND_LEDGER_PATH=           # optional ledger path (default .spend-ledger.json)
```

### Claude Desktop / Cursor

`claude_desktop_config.json`, or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": [
        "-y",
        "--package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.0/verify402-mcp-1.0.0.tgz",
        "verify402-mcp"
      ],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com"
      }
    }
  }
}
```

For paid tools, add `"EVM_PRIVATE_KEY": "0x..."`, `"MAX_PAYMENT_USD": "0.25"`
and optionally `"MAX_DAILY_USD": "0.50"` to `env`. The free gate works without
them.

### OpenCode V2

`opencode.jsonc`, or the global `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "verify402": {
        "type": "local",
        "command": [
          "npx",
          "-y",
          "--package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.0/verify402-mcp-1.0.0.tgz",
          "verify402-mcp"
        ],
        "environment": {
          "VERIFY402_URL": "https://verify402.onrender.com"
        }
      }
    }
  }
}
```

For paid tools, add `"EVM_PRIVATE_KEY": "{env:EVM_PRIVATE_KEY}"` to
`environment` and export the key in the environment that starts OpenCode. Keep
the secret out of the config file.

## Safety

- The bridge signs **x402 payments only**. It never signs or broadcasts a trade.
- It verifies the 402's network, asset, amount, payee and facilitator against
  the configured verify402 server before signing.
- `MAX_PAYMENT_USD` is enforced inside the x402 client, before a signature
  exists; removing it is a security regression.
- `preflight_gate` is a check, not a guarantee. Read `notChecked`: it does not
  screen recipient reputation or sanctions, audit contracts, simulate full
  balance deltas, or protect against MEV. It catches the measurable signing
  mistakes, not every scam.
- Use the [reference executor](https://github.com/a32116150-ctrl/verify402/blob/master/examples/preflight-guard.mjs)
  when you want enforcement rather than advice.

## Development

```bash
npm pack --dry-run
npm publish --access public   # requires npm login
```

The package is marked `UNLICENSED` until the repository gets a `LICENSE` file.
Choose a license before redistributing it.
