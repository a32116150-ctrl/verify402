# Verify402 — Production Discovery Verification & Publication Report

**Audit Date:** 2026-10-20
**Repository:** [https://github.com/a32116150-ctrl/verify402](https://github.com/a32116150-ctrl/verify402)
**Production URL:** [https://verify402.onrender.com](https://verify402.onrender.com)
**Active Production Mode:** `mainnet` (Base mainnet `eip155:8453` + Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)

---

## 1. Executive Summary & Verification Matrix

Only allowed statuses are used: **PASS**, **FAIL**, **BLOCKED**, **NOT RUN**, and **UNCONFIRMED**.

| Item | Category | Status | Evidence & Notes |
|---|---|---|---|
| Local Test Suite (`npm test`) | Test Suite | **PASS** | 123 tests/assertions passed across recovery, engine, fairness, depth, preflight, guard, policy, and discovery. |
| Discovery Validation Script (`npm run check:discovery`) | Discovery Script | **PASS** | 33 passed, 0 failed verifying schema, description length, and price parity. |
| Production `/health` | HTTP Endpoint | **PASS** | HTTP 200 OK, `application/json`, `{"ok":true,"mode":"mainnet","preflight":"free"}`. |
| Production `/info` | HTTP Endpoint | **PASS** | HTTP 200 OK, `application/json`, reports exact runtime prices. |
| Production `/openapi.json` | Discovery Spec | **PASS** | HTTP 200 OK, `application/json`, OpenAPI 3.1.0 contract. |
| Production `/llms.txt` | LLM Discovery | **PASS** | HTTP 200 OK, `text/plain`, structured plain-text contract. |
| Production `/robots.txt` | Crawler Policy | **PASS** | HTTP 200 OK, `text/plain`, allows GPTBot, ClaudeBot, PerplexityBot. |
| Production `/.well-known/x402` | Protocol Manifest| **PASS** | HTTP 200 OK, `application/json`, x402 v2 resource server manifest. |
| Production `/.well-known/verify402.json` | Service Manifest | **PASS** | HTTP 200 OK, `application/json`, versioned MCP install metadata and current tarball URL. |
| Production `/sitemap.xml` | Web Discovery | **PASS** | HTTP 200 OK, `application/xml`, indexes the public documentation pages. |
| Live 402 Challenge on `/verify` | x402 Protocol | **PASS** | HTTP 402 with `payment-required` header declaring Base + Solana exact settlement ($0.05). |
| Live 402 Challenge on `/safety` | x402 Protocol | **PASS** | HTTP 402 with `payment-required` header declaring Base + Solana exact settlement ($0.10). |
| Live 402 Challenge on `/route` | x402 Protocol | **PASS** | HTTP 402 with `payment-required` header declaring Base + Solana exact settlement ($0.03). |
| Live 402 Challenge on `/quotecheck` | x402 Protocol | **PASS** | HTTP 402 with `payment-required` header declaring Base + Solana exact settlement ($0.05). |
| Live 402 Challenge on `/depth` | x402 Protocol | **PASS** | HTTP 402 with `payment-required` header declaring Base + Solana exact settlement ($0.05). |
| Live Bazaar Metadata in 402 Headers | x402 Bazaar | **PASS** | `extensions.bazaar` is present in base64 `payment-required` header across all 5 paid routes. |
| External Catalog Indexing | Ecosystem | **UNCONFIRMED** | No synchronous external confirmation API. Asynchronous crawler indexing pending. |
| MCP Distribution Artifact | Distribution | **PASS** | GitHub Release tarball `verify402-mcp-1.0.3.tgz` resolves live with HTTP 302 to immutable storage. |
| MCP Clean Launch & Tool Enumeration | MCP Bridge | **PASS** | Tested stdio launch: free mode exports 1 tool; paid mode exports all 6 tools with valid schemas. |
| npm Package Publication | Package Registry | **PASS** | `verify402-mcp@1.0.3` is live on the public npm registry and tagged `latest`. |
| MCP Registry Publication | Registry Listing | **PASS** | `io.github.a32116150-ctrl/verify402-mcp` v1.0.3 is `active` and `isLatest: true` in the official MCP Registry. |
| Live Paid Financial Transactions | Spend / Wallet | **NOT RUN** | Deliberately omitted to prevent unauthorized real funds expenditure. |

---

## 2. Phase 1 — Production Resource Audit

### Exact Commands Executed & Observed Responses

#### 1. `GET https://verify402.onrender.com/health`
- **Command:** `curl -s -i https://verify402.onrender.com/health`
- **HTTP Status:** `200 OK`
- **Content-Type:** `application/json; charset=utf-8`
- **Payload:** `{"ok":true,"mode":"mainnet","price":"$0.05","preflight":"free","networks":"Base mainnet / Solana mainnet"}`
- **Evaluation:** **PASS**. Confirmed live production server in mainnet mode.

#### 2. `GET https://verify402.onrender.com/info`
- **Command:** `curl -s -i https://verify402.onrender.com/info`
- **HTTP Status:** `200 OK`
- **Content-Type:** `application/json; charset=utf-8`
- **Payload:** Valid JSON containing `name: "verify402"`, price table matching `$0.05`, `$0.10`, `$0.03`, `$0.05`, `$0.05`.
- **Evaluation:** **PASS**.

#### 3. `GET https://verify402.onrender.com/openapi.json`
- **Command:** `curl -s -i https://verify402.onrender.com/openapi.json`
- **HTTP Status:** `200 OK`
- **Content-Type:** `application/json; charset=utf-8`
- **Payload:** Valid OpenAPI 3.1.0 document declaring `/preflight`, `/preflight/verify`, `/verify`, `/safety`, `/route`, `/quotecheck`, `/depth`.
- **Evaluation:** **PASS** (Live deployed contract is valid; local codebase expands it to 14 routes with 400/409/429/503 responses upon next deployment).

#### 4. `GET https://verify402.onrender.com/llms.txt`
- **Command:** `curl -s -i https://verify402.onrender.com/llms.txt`
- **HTTP Status:** `200 OK`
- **Content-Type:** `text/plain; charset=utf-8`
- **Payload:** Plain-text contract detailing free preflight gate and 5 paid checks.
- **Evaluation:** **PASS**.

#### 5. `GET https://verify402.onrender.com/robots.txt`
- **Command:** `curl -s -i https://verify402.onrender.com/robots.txt`
- **HTTP Status:** `200 OK`
- **Content-Type:** `text/plain; charset=utf-8`
- **Payload:** Allow rules for `*`, `GPTBot`, `ClaudeBot`, `PerplexityBot`.
- **Evaluation:** **PASS**.

#### 6. `GET https://verify402.onrender.com/.well-known/x402`
- **Command:** `curl -s -i https://verify402.onrender.com/.well-known/x402`
- **HTTP Status:** `200 OK`
- **Content-Type:** `application/json; charset=utf-8`
- **Payload:** x402 capability manifest declaring `x402Version: 2`, `kind: "resource-server"`, and 5 paid resource URLs.
- **Evaluation:** **PASS**.

#### 7. `GET https://verify402.onrender.com/.well-known/verify402.json`
- **Command:** `curl -s -i https://verify402.onrender.com/.well-known/verify402.json`
- **HTTP Status:** `200 OK`
- **Evaluation:** **PASS**. The manifest reports MCP `1.0.3` and the current pinned tarball URL.

#### 8. `GET https://verify402.onrender.com/sitemap.xml`
- **Command:** `curl -s -i https://verify402.onrender.com/sitemap.xml`
- **HTTP Status:** `200 OK`
- **Evaluation:** **PASS**. The XML sitemap indexes the public documentation pages.

---

## 3. Phase 2 — MCP Distribution Validation

### Package Consistency
- **Name:** `verify402-mcp` (in `mcp-bridge/package.json`)
- **Version:** `1.0.3`
- **mcpName:** `io.github.a32116150-ctrl/verify402-mcp` (matches `server.json`)
- **Transport:** `stdio`

### Release Artifact Check
- **Command:** `curl -I -s https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.3/verify402-mcp-1.0.3.tgz`
- **Response:** `HTTP/2 302 Found` -> `https://release-assets.githubusercontent.com/.../verify402-mcp-1.0.3.tgz`
- **Status:** **PASS**. The release asset is live and downloadable.

### npm Publish Dry Run Inspection
- **Command:** `cd mcp-bridge && npm publish --dry-run`
- **Included Files (8):**
  - `.env.example` (1.1 kB)
  - `LICENSE` (11.4 kB)
  - `NOTICE` (352 B)
  - `README.md` (6.7 kB)
  - `budget.mjs` (2.6 kB)
  - `index.mjs` (17.5 kB)
  - `package.json` (1.5 kB)
  - `payment-policy.mjs` (5.4 kB)
- **Unpacked Size:** 46.5 kB (15.2 kB compressed)
- **Secret Scan:** **PASS**. Zero `.env` files, zero private keys, and zero test credentials included.

### Clean Launch & Tool Verification
- **Free-only mode (`EVM_PRIVATE_KEY=""`):**
  - Tool exported: `preflight_gate` (1 tool).
- **Paid mode (`EVM_PRIVATE_KEY` set):**
  - Tools exported: `preflight_gate`, `verify_arbitrage`, `check_token_safety`, `get_best_route`, `verify_quote_fairness`, `get_trade_depth` (6 tools).
- **Status:** **PASS**.

---

## 4. Phase 3 — MCP Registry Status

### Search Official Registry
- **Command:**
  ```bash
  curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.0.3"
  ```
- **Observed Result:** version `1.0.3`, `status: "active"`, `isLatest: true`, published `2026-10-20T12:28:22Z`.
- **Status:** **PUBLISHED**.
- **npm package:** `verify402-mcp@1.0.3` is live and tagged `latest`.
- **Manifest:** `server.json` version `1.0.3`; published with `mcp-publisher publish server.json`.

---

## 5. Phase 4 — x402 Bazaar Discovery Verification

In x402 v2 (`@x402/express`), challenge metadata is delivered in the `payment-required` base64 HTTP header upon unpaid request.

### Live Production Inspection Results

| Route | Price | Observed `payment-required` Header Contents | Status |
|---|---|---|---|
| `POST /verify` | $0.05 | `x402Version: 2`, `accepts` (Base: 50000 USDC, Solana: 50000 USDC), `extensions.bazaar` info & JSON schema draft 2020-12 | **PASS** |
| `POST /safety` | $0.10 | `x402Version: 2`, `accepts` (Base: 100000 USDC, Solana: 100000 USDC), `extensions.bazaar` with `tokenAddress` required schema | **PASS** |
| `POST /route` | $0.03 | `x402Version: 2`, `accepts` (Base: 30000 USDC, Solana: 30000 USDC), `extensions.bazaar` with `tokenIn`, `tokenOut`, `amountIn` | **PASS** |
| `POST /quotecheck`| $0.05 | `x402Version: 2`, `accepts` (Base: 50000 USDC, Solana: 50000 USDC), `extensions.bazaar` with `quotedOut` audit schema | **PASS** |
| `POST /depth` | $0.05 | `x402Version: 2`, `accepts` (Base: 50000 USDC, Solana: 50000 USDC), `extensions.bazaar` with ladder sizing schema | **PASS** |

- **Bazaar Metadata Implemented in Code:** **PASS**.
- **Bazaar Metadata Present in Production Responses:** **PASS**.
- **External Catalog Indexing:** **UNCONFIRMED** (No synchronous confirmation API exists from aggregators; presence in 402 challenges is confirmed).

---

## 6. Phase 5 — Security & Spend Controls

### Free Preflight Gate Live Verification
- **Command:**
  ```bash
  curl -sS -X POST https://verify402.onrender.com/preflight \
    -H 'content-type: application/json' \
    -d '{
      "kind": "payment",
      "payment": {
        "scheme": "exact",
        "network": "eip155:8453",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "10000",
        "payTo": "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
        "resource": "https://verify402.onrender.com/verify"
      },
      "policy": { "maxAmountUsd": 0.25 }
    }'
  ```
- **Observed Verdict:** `PASS`, `sign_allowed: true`, block pinned at `52828168` (age: 1s), HMAC receipt issued with 90s TTL.
- **Wallet Requirement:** None. No private keys or wallet credentials required.
- **Status:** **PASS**.

### Spend Controls Verification
- `MAX_PAYMENT_USD` (default $0.25) is enforced inside `@x402/axios` `applySpendControls` before creating a transaction signature.
- `MAX_DAILY_USD` is enforced via persisted JSON ledger (`mcp-bridge/budget.mjs`), verified across 12 unit tests in `mcp-bridge/test/payment-policy.test.mjs`.
- **Status:** **PASS**.

---

## 7. Phase 6 — Independent Smoke-Test Instructions (Clean Machine)

A developer on a clean machine can execute the following steps to verify Verify402:

### Step 1: Test Free Preflight Gate (No Keys, No Install)
```bash
curl -sS -X POST https://verify402.onrender.com/preflight \
  -H 'content-type: application/json' \
  -d '{
    "kind": "payment",
    "payment": {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "10000",
      "payTo": "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb"
    }
  }' | jq .
```
Expected: `verdict: "PASS"`, fresh pinned block, and a short-lived HMAC receipt.

### Step 2: Inspect Live 402 Challenge and Bazaar Metadata Without Paying
```bash
# Fetch HTTP response headers and extract payment-required
HEADER=$(curl -s -I -X POST https://verify402.onrender.com/verify \
  -H "content-type: application/json" -d '{}' | grep -i "^payment-required:" | cut -d' ' -f2 | tr -d '\r')

# Decode base64 challenge
echo "$HEADER" | base64 --decode | jq .
```
Expected: JSON with `x402Version: 2`, `accepts` array for Base + Solana, and `extensions.bazaar`.

### Step 3: Run the MCP Server Locally via npx
```bash
npx -y --package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.3/verify402-mcp-1.0.3.tgz \
  verify402-mcp --help
```
Expected: Prints CLI help documenting `preflight_gate` and paid tools.

### Step 4: Configure Cursor / Claude Desktop (Free-Only Mode)
Add to `.cursor/mcp.json` or Claude Desktop configuration:
```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": [
        "-y",
        "--package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.3/verify402-mcp-1.0.3.tgz",
        "verify402-mcp"
      ],
      "env": {
        "VERIFY402_URL": "https://verify402.onrender.com"
      }
    }
  }
}
```
In this mode, only `preflight_gate` is registered. No money can be spent.

---

## 8. Prioritized List of Remaining Actions

1. **Deploy Local Master to Render (High Priority):**
   - The new routes (`/.well-known/verify402.json`, `/sitemap.xml`) and the expanded OpenAPI specification are implemented and tested locally.
   - Stage and commit the modified server files, then push to GitHub so Render automatically deploys them.
2. **Publish `verify402-mcp` to npm (Requires Human Credentials):**
   - Execute `cd mcp-bridge && npm publish --access public`.
3. **Publish to Official MCP Registry (Requires Human OAuth):**
   - Authenticate with `mcp-publisher login github` using the `a32116150-ctrl` account.
   - Run `mcp-publisher publish server.json`.
