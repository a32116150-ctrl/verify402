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

## Distribution & Run

The package is officially published on npm as **[`verify402-mcp`](https://www.npmjs.com/package/verify402-mcp)** and indexed on the official [Model Context Protocol Registry](https://registry.modelcontextprotocol.io/).

Run directly via `npx` (stdio transport):

```bash
npx -y verify402-mcp --help
```

You can also install it globally:

```bash
npm install -g verify402-mcp
verify402-mcp --help
```

Or run from source:

```bash
git clone https://github.com/a32116150-ctrl/verify402
cd verify402/mcp-bridge
npm ci
node index.mjs --help
```

---

## AI Agent Integration (Step-by-Step)

### Step 1: Free Mode (Zero Config, No Wallet)
To give your AI agent the free **`preflight_gate`** (evaluates transaction calldata, payment challenges, honeypots, and approvals before signing), paste this into your client configuration:

**Claude Desktop** (`claude_desktop_config.json`) or **Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp"],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com"
      }
    }
  }
}
```

### Step 2: Paid Mode (Setting Up the Hot Wallet)
To enable the 5 deep on-chain truth checks (`verify_arbitrage`, `check_token_safety`, `get_best_route`, `verify_quote_fairness`, `get_trade_depth`), configure a dedicated hot wallet that pays per call in USDC via x402:

1. **Create a Dedicated Hot Wallet**:
   - Create a brand new wallet in MetaMask, Rabby, or via `cast wallet new`.
   - ⚠️ **SECURITY WARNING**: Never use your primary personal wallet, cold storage, or vault.
2. **Fund the Wallet on Base (EIP-155:8453)**:
   - **USDC**: Transfer $2 to $10 of USDC on Base (the bridge pays per call: $0.03 to $0.10).
   - **Gas (ETH on Base)**: Transfer ~$0.50 worth of ETH on Base for minimal gas allowances if needed.
3. **Configure Environment Variables in Your MCP Client**:
   - Set `EVM_PRIVATE_KEY` to the 64-character private key of the hot wallet.
   - Set safety caps `MAX_PAYMENT_USD` (e.g., `"0.25"`) and `MAX_DAILY_USD` (e.g., `"1.00"`).

**Paid Configuration Block (Claude Desktop, Cursor, Cline, Windsurf)**:
```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp"],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com",
        "EVM_PRIVATE_KEY": "0xYOUR_HOT_WALLET_PRIVATE_KEY",
        "MAX_PAYMENT_USD": "0.25",
        "MAX_DAILY_USD": "1.00",
        "VERIFY402_NETWORKS": "eip155:8453",
        "VERIFY402_PAY_TO": "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb"
      }
    }
  }
}
```

### OpenCode V2 Configuration
In `opencode.jsonc` (or `~/.config/opencode/opencode.jsonc`):
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "verify402": {
        "type": "local",
        "command": ["npx", "-y", "verify402-mcp"],
        "environment": {
          "VERIFY402_URL": "https://verify402.onrender.com",
          "EVM_PRIVATE_KEY": "{env:EVM_PRIVATE_KEY}",
          "MAX_PAYMENT_USD": "0.25",
          "MAX_DAILY_USD": "1.00"
        }
      }
    }
  }
}
```

---

## How AI Agents Use verify402 (Prompt Examples)

Once configured, your agent automatically sees the tools in its context. You can prompt it directly:

- **Preflight Gate (Free)**:
  > *"Before signing this transaction, call `preflight_gate` on the payment request / calldata. If it returns BLOCK, abort and explain why."*
- **Token Safety & Honeypot Check ($0.10)**:
  > *"Analyze token `0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE` using `check_token_safety`. Is it safe to trade or is there a sell tax / honeypot?"*
- **Arbitrage Verification ($0.05)**:
  > *"Use `verify_arbitrage` to verify if there is an arbitrage opportunity between Uniswap V3 and Sushiswap for WETH/USDC on chain 1 at the current block."*
- **Quote Fairness Audit ($0.05)**:
  > *"I was offered 0.35 WETH for 1,000 USDC. Run `verify_quote_fairness` to see if this is fair or if I'm overpaying."*
- **Market Depth & Capacity ($0.05)**:
  > *"Check `get_trade_depth` for WETH on Uniswap V3 to see how much slippage and impact a $50,000 swap would suffer."*

## Safety

- The bridge signs **x402 payments only**. It never signs or broadcasts a trade.
- Before signing, the paid client requires the 402 to come from the configured
  server and a known paid route, on an allowlisted EVM network, to the
  verify402 payee. It accepts only recognized default assets (USDC), caps the
  amount at `MAX_PAYMENT_USD`, and refuses redirects.
- The allowlist can be narrowed or pointed at another deployment with
  `VERIFY402_NETWORKS`, `VERIFY402_PAY_TO`, and `VERIFY402_RESOURCE_PREFIX`.
  Defaults are Base mainnet and the public verify402 payee.
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
```

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.

You may use, modify, and distribute this package, including in commercial agent
systems and bots. If you redistribute it or a product containing it, keep the
copyright notice, the license text, and the `NOTICE` file. The `verify402` name
and logo are not licensed for endorsement.
