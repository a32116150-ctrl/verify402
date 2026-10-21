# AI Agent Integration & Hot Wallet Setup Guide

> **Quick Summary:** Connect Claude Desktop, Cursor, Windsurf, Cline, OpenCode, or custom autonomous agents to **verify402** via the npm package [`verify402-mcp`](https://www.npmjs.com/package/verify402-mcp).

---

## 1. Quick Verification (Terminal Test)

Run the published npm binary once directly to verify connectivity:

```bash
npx -y verify402-mcp --help
```

---

## 2. Choosing Your Mode

| Feature | Free Mode | Paid Mode |
|---|---|---|
| **Requires Wallet?** | ❌ No | ✅ Yes (Dedicated hot wallet) |
| **Requires Private Key?** | ❌ No | ✅ Yes (`EVM_PRIVATE_KEY`) |
| **Requires Crypto / Gas?** | ❌ No | ✅ Yes (USDC on Base + ~$0.50 ETH) |
| **Tools Included** | `preflight_gate` | `preflight_gate`, `verify_arbitrage`, `check_token_safety`, `get_best_route`, `verify_quote_fairness`, `get_trade_depth` |
| **Cost** | **$0.00** | $0.03 – $0.10 per call via x402 |

---

## 3. Configuration by Agent Platform

### Claude Desktop
Edit your `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp@latest"],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com"
      }
    }
  }
}
```

### Cursor
Open `.cursor/mcp.json` in your project root, or go to **Cursor Settings → MCP → Add New MCP Server**:
- **Name:** `verify402`
- **Type:** `command`
- **Command:** `npx -y verify402-mcp@latest`

### Windsurf
Edit `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp@latest"],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com"
      }
    }
  }
}
```

### Cline / Roo Code (VS Code Extension)
Open `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp@latest"],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com"
      }
    }
  }
}
```

---

## 4. Setting Up the Agent's Hot Wallet (Paid Mode Only)

If you want the agent to use paid truth checks:

### Step 1: Create a Throwaway Hot Wallet
- Create a new wallet in MetaMask/Rabby or run:
  ```bash
  cast wallet new
  ```
- **CRITICAL RULE**: Never use your main wallet, treasury, or cold storage.

### Step 2: Fund with USDC on Base
- Network: **Base (Chain ID 8453)**
- Asset: **USDC** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- Recommended starting balance: **$3.00 to $10.00 USDC**
- Typical check prices:
  - `get_best_route`: **$0.03**
  - `verify_arbitrage`: **$0.05**
  - `verify_quote_fairness`: **$0.05**
  - `get_trade_depth`: **$0.05**
  - `check_token_safety`: **$0.10**

### Step 3: Fund with Gas
- Send **$0.50 worth of ETH on Base** to the wallet address to handle any approval transactions.

### Step 4: Add Environment Variables & Budget Caps
In your MCP config `env` block, add:
```json
"EVM_PRIVATE_KEY": "0xYOUR_HOT_WALLET_KEY",
"MAX_PAYMENT_USD": "0.25",
"MAX_DAILY_USD": "1.00",
"VERIFY402_NETWORKS": "eip155:8453",
"VERIFY402_PAY_TO": "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb"
```

#### Security Guardrails Enforced Client-Side:
- **`MAX_PAYMENT_USD`**: Refuses any single 402 challenge higher than this amount before signing.
- **`MAX_DAILY_USD`**: Tracks cumulative daily spending and halts when the cap is reached.
- **USDC-Only Default**: Rejects payment requests in unknown or non-standard tokens.
- **Payee Whitelist**: Refuses payments to addresses other than `VERIFY402_PAY_TO`.

---

## 5. Agent Prompt Cookbook

Once configured, instruct your agent using these prompt patterns:

### Safe Execution & Preflight Gate
```text
I am about to execute this swap transaction on Base:
Calldata: <calldata>
To: <router_address>
Value: 0

Before executing, invoke verify402's preflight_gate. If the verdict is BLOCK or CAUTION with critical warnings, stop and warn me.
```

### Quote-Based Token Sellability
```text
Evaluate token 0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE using check_token_safety.
Use the quote-based sellability check at a realistic size, report the round-trip cost, and list notChecked (transfer tax, blacklist, pause, max-tx, unconfigured venues). Do not call it a honeypot proof.
```

### Arbitrage Verification
```text
I see a possible price discrepancy on WETH/USDC between Uniswap V3 and Aerodrome on Base.
Run verify_arbitrage to determine if this opportunity actually has an edge after fees and price impact.
```

### Quote Audit
```text
A bot offered to swap 5,000 USDC for 1.74 WETH. Run verify_quote_fairness to see if this is an honest market rate or an overpayment.
```

## CORS

Free read-only discovery (`GET`/`HEAD`/`OPTIONS`) allows any origin. `POST /preflight` and paid routes send no `Access-Control-Allow-Origin`; browser-based agents must use a server-side client, the MCP bridge, or an SDK.
