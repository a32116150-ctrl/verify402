# verify402

> **Machine-payable on-chain truth & pre-signing checks for AI agents.**
> Free fail-closed preflight gate + five verifiable truth checks paid per call via x402 in USDC. No API key, no account, no wallet required for the free gate.

[![npm version](https://img.shields.io/npm/v/verify402-mcp.svg)](https://www.npmjs.com/package/verify402-mcp)
[![MCP Server](https://img.shields.io/badge/MCP-verify402--mcp-blue.svg)](https://verify402.onrender.com/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-active-success.svg)](https://registry.modelcontextprotocol.io/)
[![OpenAPI 3.1](https://img.shields.io/badge/OpenAPI-3.1.0-green.svg)](https://verify402.onrender.com/openapi.json)
[![x402 v2](https://img.shields.io/badge/x402-v2%20exact-purple.svg)](https://github.com/x402-foundation/x402)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

---

## 30-Second Quickstart

### 1. Free Preflight Gate (No wallet, no key)
Verify an x402 payment challenge before signing it:

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

Returns `PASS` / `CAUTION` / `BLOCK`, typed reasons, exact `checked` and `notChecked` lists, pinned block number, and a verifiable 90-second HMAC receipt.

A `PASS` means the listed checks passed at that block. It does **not** mean the
transaction is safe or cannot drain funds, and the paid token check is a
quote-based sellability check, not a honeypot proof. Read `notChecked` in the response.

---

## 🤖 Using verify402 with AI Agents (Step-by-Step)

The MCP server is live on npm as **[`verify402-mcp`](https://www.npmjs.com/package/verify402-mcp)** and indexed on the official [Model Context Protocol Registry](https://registry.modelcontextprotocol.io/) (`io.github.a32116150-ctrl/verify402-mcp`).

It works with **Claude Desktop**, **Cursor**, **Windsurf**, **Cline**, **OpenCode**, and any MCP client over stdio.

### Step 1: Add the MCP Server to Your Agent

#### Option A: Free Mode (Zero Config, No Wallet, No Key)
Gives your AI agent the free **`preflight_gate`** tool. It checks payment challenges, token approvals, payee/amount, and transaction calldata at a fresh block before signing. The paid `check_token_safety` check adds a quote-based sellability check; it does not execute a transfer and is not a honeypot guarantee.

Paste this into your client config file:
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor**: `.cursor/mcp.json` or Cursor Settings → MCP
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`
- **Cline**: `cline_mcp_settings.json`

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

#### Option B: Paid Mode (Unlocks 5 Deep Truth Checks)
Unlocks the 5 on-chain truth checks (`verify_arbitrage`, `check_token_safety`, `get_best_route`, `verify_quote_fairness`, `get_trade_depth`). The agent pays per call via x402 in USDC.

```json
{
  "mcpServers": {
    "verify402": {
      "command": "npx",
      "args": ["-y", "verify402-mcp@latest"],
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

---

### Step 2: How to Set Up the Agent's Hot Wallet

If you want your agent to use the paid truth tools, follow these 4 steps to set up its wallet safely:

1. **Create a Dedicated Hot Wallet**:
   - Generate a brand new EVM address using MetaMask, Rabby, or CLI (`cast wallet new`).
   - ⚠️ **NEVER USE YOUR MAIN WALLET OR COLD VAULT.** Treat this wallet like physical petty cash.
2. **Fund with USDC on Base (EIP-155:8453)**:
   - Send $2 to $10 of USDC on the Base network to your new hot wallet.
   - The tools cost tiny fixed amounts per call: `$0.03` (route), `$0.05` (arbitrage/quotecheck/depth), `$0.10` (token safety).
3. **Fund with Gas (ETH on Base)**:
   - Send ~$0.50 worth of ETH on Base for token approvals / gas overhead.
4. **Export the Private Key**:
   - Copy the wallet's private key (hex string starting with `0x`) into the `EVM_PRIVATE_KEY` field in your MCP config.
   - *Client-Side Guardrails*: The bridge enforces `MAX_PAYMENT_USD` (hard cap per call, default $0.25) and `MAX_DAILY_USD` (daily budget cap) before any signature can be created. This caps what the bridge can authorize; it is **not** protection against a compromised private key.

---

### Step 3: Prompting the AI Agent to Use the Tools

Once configured, restart your AI client. The agent automatically has access to the tools. You can prompt it naturally:

| What you want to do | Example Prompt to your AI Agent | Tool Called | Cost |
| :--- | :--- | :--- | :--- |
| **Verify a transaction before signing** | *"Before signing, run `preflight_gate` on the calldata to check payee, amount, approvals, and block freshness. If it returns BLOCK, stop; a PASS is not a guarantee."* | `preflight_gate` | **Free** |
| **Check measured token safety / sellability** | *"Run `check_token_safety` on token `0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE` and tell me whether it is sellable at a realistic size, what the round-trip cost is, and whether the result is TRUST / CAUTION / AVOID. This is not a code audit."* | `check_token_safety` | $0.10 |
| **Verify an arbitrage opportunity** | *"Use `verify_arbitrage` to check if the claimed arb between Uniswap V3 and Sushiswap on WETH/USDC is real right now on chain 1."* | `verify_arbitrage` | $0.05 |
| **Audit a swap quote** | *"I was quoted 0.35 WETH for 1,000 USDC. Call `verify_quote_fairness` to see if this quote is honest or if I'm being overcharged."* | `verify_quote_fairness` | $0.05 |
| **Check market depth & slippage** | *"Check `get_trade_depth` for WETH on Uniswap V3 to see how much slippage I would take on a $25,000 swap."* | `get_trade_depth` | $0.05 |
| **Find true on-chain swap route** | *"Query `get_best_route` to find the exact net payout for swapping 2,000 USDC to WETH across all DEX pools."* | `get_best_route` | $0.03 |

---

## Machine-Readable Discovery

- **Service Manifest:** [`/.well-known/verify402.json`](https://verify402.onrender.com/.well-known/verify402.json) ([Documentation](docs/service-manifest.md))
- **OpenAPI 3.1 Specification:** [`/openapi.json`](https://verify402.onrender.com/openapi.json)
- **MCP Registry Manifest:** [`server.json`](server.json) ([Publishing Guide](docs/mcp-registry-publishing.md))
- **x402 Bazaar Discovery:** [`docs/x402-discovery.md`](docs/x402-discovery.md)
- **Plain Text Contract:** [`/llms.txt`](https://verify402.onrender.com/llms.txt)
- **Discovery Audit:** [`docs/discovery-audit.md`](docs/discovery-audit.md)
- **Directory Submission Checklist:** [`docs/distribution-directory-checklist.md`](docs/distribution-directory-checklist.md)

**Human Pages:** [Home](https://verify402.onrender.com/) · [Start](https://verify402.onrender.com/start) · [Preflight Gate](https://verify402.onrender.com/preflight) · [MCP Server](https://verify402.onrender.com/mcp) · [Checks](https://verify402.onrender.com/checks) · [Live Findings](https://verify402.onrender.com/live) · [Proof & Receipts](https://verify402.onrender.com/proof) · [Docs](https://verify402.onrender.com/docs) · [Donate](https://verify402.onrender.com/donate)

---

## Why an agent would pay for this

Models hallucinate profit. Most arb "opportunities" an LLM surfaces are stale, ignore
fees, or come from a quote that was never checked against the venue that would
execute the trade. This service exists to be the check an agent cannot do itself.

## The measurement discipline

Quotes come from the canonical on-chain sources — **never our own reimplementation
of venue math**:

- V3: Uniswap's deployed `QuoterV2` (its answers are the router's answers by construction)
- V2: each router's own `getAmountsOut`

Both legs are measured against **one block number**, so the round trip reflects a
single instant rather than two prices that never coexisted.

Three bugs were caught by the test suite before this ever served a paid response,
and they are the reason the tests exist:

1. **Invented profit (the big one).** `decodeFunctionResult` on `getAmountsOut` — a
   single declared output, which viem unwraps — was indexed with `decoded[0]`,
   silently grabbing the array's first element: the *input* amount. On the sell leg
   that turned 41 WETH into 41 **trillion** USDC of "profit". Now the decoder finds
   the `uint256[]` structurally and refuses a result equal to the input.
2. **Basis points off by 100x.** −292 USDC on a 100,000 USDC round trip rendered as
   −0.29 bps instead of −29. A rounding trick multiplying by `10_000n` instead of
   `1_000_000n` when keeping two decimals of precision.
3. **Venue that doesn't exist still gets reported.** Started as an unasserted
   assumption; `all configured venues exist on-chain` is now a test.

```bash
node test/measure.test.mjs   # 5 checks, needs a mainnet RPC
```

One check is the headline property: *a 100k USDC round trip on Ethereum must NOT
come out profitable.* If it ever does, the engine is wrong until proven otherwise.

## Run it

```bash
npm install
npm test                              # engine checks (network required)
node src/server.mjs                   # testnet payment mode
BYPASS_PAYMENT=1 node src/server.mjs  # local dev only - loud warning, no billing
X402_MODE=mainnet FACILITATOR_URL=... AGENT_URL=https://verify402.example node src/server.mjs
```

Mainnet refuses to start without `AGENT_URL`: the agent card is a public
identity document and must not derive its origin from the request's `Host`
header. In testnet/local mode the card falls back to a Host allowlist
(`TRUSTED_HOSTS`, plus `localhost` / `127.0.0.1`); an unlisted Host gets
`400 untrusted_host` instead of being reflected.

## Endpoints

| Route | Price | What it does |
|---|---|---|
| `POST /preflight` | free | pre-signing gate: validate a payment request or transaction, return PASS / CAUTION / BLOCK + a short-lived receipt |
| `POST /preflight/verify` | free | verify a preflight receipt (HMAC, intent hash, expiry) |
| `POST /verify` | $0.05 (x402) | the measurement, with verdict + evidence |
| `POST /safety` | $0.10 (x402) | pre-trade token check: TRUST / CAUTION / AVOID + evidence; not a code audit |
| `POST /route` | $0.03 (x402) | what would the chain ACTUALLY pay for this swap? best route + every quoted venue |
| `POST /quotecheck` | $0.05 (x402) | audit a quote someone else gave you: fair / overpaying / too_good_to_be_true |
| `POST /depth` | $0.05 (x402) | position sizing: how big can I trade before the round trip eats me? |
| `GET /findings` | free | live no_edge verdicts on Ethereum majors |
| `GET /info` | free | machine-readable service description |
| `GET /health` | free | liveness |

`POST /depth` is the pre-trade sizing question nothing on-chain answers.
Pool-reserve "liquidity: $2.7M" tells an agent nothing about the block it
will actually trade in. The depth engine buys the target with the best route
at each rung of a USD ladder, immediately sells the exact position back, and
reports per-rung impact %, round-trip cost %, and `capacityUsd` — the largest
size that stays under the caller's cost tolerance. Live example (SHIB,
2.5% tolerance): "$2.7M liquidity" resolves to a real capacity of **$1,000**
($100 → 1.20% round trip, $10k → 6.57%). The ladder is the honest answer.

## The preflight gate

`POST /preflight` is the free control an agent runs immediately before signing.
It accepts one of two intents:

- **payment** — an x402 402 challenge (EVM or Solana): scheme, CAIP-2 network,
  asset, raw amount, `payTo`, resource, timeout, authorization window.
- **transaction** — `chainId`, `to`, `data`, `value`, optional `from` (EVM:
  Ethereum 1, Arbitrum 42161, Base 8453).

Response: `PASS` / `CAUTION` / `BLOCK`, `reasons[]`, `checked[]`,
`notChecked[]`, and a receipt:

```json
{
  "verdict": "CAUTION",
  "sign_allowed": true,
  "requires_ack": true,
  "reasons": [{ "code": "unlimited_approval", "severity": "caution", "message": "..." }],
  "checked": ["scheme", "network", "asset", "amount", "payee", "resource", "payer_balance", "block_freshness"],
  "notChecked": ["recipient reputation", "sanctions screening", "payment signature / signed payload", "facilitator settlement", "off-chain promises", "counterparty identity / tool metadata", "prompt injection / hidden Unicode in tool output"],
  "receipt": {
    "spec": "verify402/preflight-receipt@1",
    "intentHash": "…",
    "blockNumber": 48277717,
    "blockHash": "0x…",
    "expiresAt": "2026-10-19T…Z",
    "signature": "…"
  }
}
```

- The receipt is HMAC-SHA256 signed, bound to the canonical normalized intent,
  a fresh pinned block where the chain is readable, and an expiry (default 90s,
  max 300s). `POST /preflight/verify` recomputes it.
- **Fresh block, not just any block:** on EVM chains, a latest block older than
  **30s** is `CAUTION`; older than **120s** is `BLOCK`. The response carries
  `block.timestamp` and `block.ageSeconds`. A block with no timestamp is a
  `503`, not a PASS.
- **Fail-closed:** if the chain cannot be read, the endpoint returns `503` and
  no receipt. An executor must refuse to sign without a verifiable receipt.
- **Not checked, on purpose:** recipient reputation, sanctions, contract
  audits, full balance-delta simulation, MEV, the payment signature/signed
  payload, gas price/limit chosen by the signer, raw signed-transaction binding,
  facilitator settlement, counterparty identity/tool metadata, and prompt
  injection or hidden Unicode in tool output. They are named in every response
  instead of being implied. A PASS is not a counterparty audit.
- Free is rate-limited (60/min per IP, 8 concurrent) so it cannot become a
  public RPC proxy.

The MCP server exposes it as `preflight_gate`. It runs with no wallet (free gate
only); add `EVM_PRIVATE_KEY` for the five paid tools. If `sign_allowed` is
false, do not sign; if `requires_ack` is true, surface the reasons to the
operator. Client configs and the install command are at
[`/mcp`](https://verify402.onrender.com/mcp).

### Reference executor

`examples/preflight-guard.mjs` is a dependency-free, deny-by-default wrapper:
it calls the gate, refuses `BLOCK`, requires an explicit acknowledgement for
`CAUTION`, verifies the receipt, and only then calls **your** signer. It holds
no key and sends nothing itself. The intent is cloned and deep-frozen before the
gate, and that same object is passed to the signer. If you do not want to trust
the public instance, run your own and pin `baseUrl`.

`POST /verify` request:

```json
{ "chainId": 1, "target": "WETH", "base": "USDC", "size": 100000, "minNet": 0 }
```

Response (abridged):

```json
{
  "verdict": "no_edge",
  "blockNumber": 26214368,
  "buy":  { "venue": "uni-v3-0.05%", "amountOutHuman": 41.366 },
  "sell": { "venue": "uni-v3-0.05%", "amountOutHuman": 99707.9 },
  "gross": { "human": -292.08, "bps": -29.23 },
  "net":   { "human": -342.14, "bps": -34.23 },
  "costs": { "flashLoanPremiumBps": 5, "gasUsd": 0.0561 },
  "venues": { "quoted": 12, "buySide": [...], "sellSide": [...], "unavailable": [...] },
  "caveats": ["..."]
}
```

`verdict` is one of `edge` (net cleared `minNet`), `no_edge_costs_ate_it` (gross
positive, costs larger), or `no_edge` (unprofitable before costs).

`POST /safety` request (accepts any ERC-20 address, not just registry symbols):

```json
{ "chainId": 1, "tokenAddress": "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", "intendedUsd": 500 }
```

Response (abridged):

```json
{
  "verdict": "TRUST",
  "quote_status": "ok",
  "checked": ["contract", "market", "quote-based sellability", "liquidity"],
  "notChecked": ["actual token transfer or sell execution", "transfer tax / fee-on-transfer",
                 "blacklist / pause / max-tx restrictions", "venues not in config"],
  "notes": ["quoteable sell via uni-v3-0.3% via hop, uniswap-v2 via hop, ...",
            "round trip in and out of $500 costs 1.42%"],
  "evidence": { "contract": {...}, "market": {...},
                "sellability": { "canSell": true, "probedInUsd": 25,
                                 "caveat": "quote-based only: a quote does not prove a transfer will succeed" },
                "liquidity": { "roundTripCostPct": 1.42 } },
  "elapsedMs": 1434
}
```

`verdict` is one of:
- `AVOID` — positively dangerous: no configured venue can quote an exit at a
  realistic size, or the contract is not a token at all
- `CAUTION` — tradable, but with a stated cost or problem (thin pool,
  manufactured price, expensive round trip)
- `TRUST` — every check that ran passed; still not a promise of profit, only a
  record that nothing measured was wrong

This is a **quote-based sellability check**. It asks the configured venues'
own routers for a price; it does not execute or simulate a transfer, so
transfer tax, blacklist, pause, and max-transaction restrictions are listed in
`notChecked`, not silently assumed away. Venues that are not configured on the
chain are also named in `notChecked`.

Probes are USD-sized on purpose: an earlier version probed "half a token" and
flagged SHIB — a $1B token — as unexitable, because half a SHIB is dust no pool
can quote. The test suite and live calls caught that before it launched; every
future verdict change must be explainable, not silent.

A request without payment gets `402Payment Required` with instructions in the
`PAYMENT-REQUIRED` header; the client pays and retries with proof — that is the
entire x402 flow, and it is what makes the caller a program rather than a person.

## Deploying

See `DEPLOY.md` — free-tier container deployment, ERC-8004 identity mint
(`npm run register`, owner's key, on-chain data URI), mainnet facilitator
wiring, and the distribution order.

## MCP: how AI agents consume this

`mcp-bridge/` is packaged as **`verify402-mcp`** (stdio). It exposes the free
pre-signing gate (`preflight_gate`) and the five paid endpoints
(`verify_arbitrage`, `check_token_safety`, `get_best_route`,
`verify_quote_fairness`, `get_trade_depth`) to Claude Desktop, Cursor, OpenCode,
or any MCP client.

- **Free gate only:** omit `EVM_PRIVATE_KEY`; the server registers only
  `preflight_gate` and nothing can be charged.
- **Paid tools:** add a dedicated hot wallet with USDC. The bridge signs the x402
  payment only — never a trade — and enforces `MAX_PAYMENT_USD` (default $0.25)
  inside the x402 client before a signature exists. It also requires an
  allowlisted EVM network, the verify402 payee, and a known paid resource on the
  configured server, and refuses redirects. `MAX_DAILY_USD` is optional.
- **Install:** `npx -y verify402-mcp@latest` from the public npm registry.
  The pinned GitHub release tarball remains an optional fallback:
  `npx -y --package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.3/verify402-mcp-1.0.3.tgz verify402-mcp`.
  No npm account is required to run the published package. Client configs, the
  exact OpenCode V2 shape, and the release command are at
  [`/mcp`](https://verify402.onrender.com/mcp). See also
  `mcp-bridge/README.md`.

## Settlement, response delivery, and recovery (honest contract)

> **Process-local state (important):** recovery records and `/usage` counters live
> only in this process. A restart or deploy loses both: a previously settled
> idempotency key may be charged again, and usage counts reset. Neither is
> shared across instances.

- **Delivery:** the verdict is returned inside the settlement response — the paid answer
  arrives together with the payment confirmation (testnet receipt: tx
  `0x11121007bafec47f132763f42e2f58af6ebba7fba9c7ed1b5980d3f595a9324a`).
- **Recovery — implemented (`x-idempotency-key`):** send the header on the FIRST call of an
  operation, minting ONE key per operation. If the response is lost after settlement,
  retrying with the same key returns the SAME verdict without requiring payment again:
  10 minutes (max 3 replays). Caveats stated plainly: the key is the caller's secret
  (whoever presents it replays for free), the window is short by design so the 402 paywall
  stays intact, and replayed responses carry `recovery: { replayed: true, responseHash, replays }`.
  - **Key strength (required):** use `crypto.randomUUID()` or at least 32 URL-safe
    characters (`A-Z`, `a-z`, `0-9`, `_`, `-`) with at least 16 distinct characters.
    Short, repeated, sequential, or low-entropy keys are rejected with
    `400 weak_idempotency_key` and guidance to generate a key. Requests without a key
    keep working exactly as before; they simply do not get recovery.
  - **The key is a secret.** A leaked key allows anyone to replay the settled verdict
    until the 10-minute window closes or the 3-replay cap is reached. Do not put it in
    logs, URLs, screenshots, or public issue reports. If it leaks, use a new key for the
    next operation; the old key cannot be revoked except by the short TTL/cap.
  - **What recovery does not guarantee:** it is not a durable ledger and does not
    survive a process restart; it does not prove payment, refund a failed call, replay
    after the TTL or cap, cross instances, or recover a response if the caller lost the
    key. `/usage` counters are likewise process-local and reset on restart. Recovery
    only returns the exact settled response bytes while the record is live.
  - **Settlement-gated (fail-closed):** a verdict record only becomes replayable
    **after the facilitator confirms the settlement** (official x402 `onAfterSettle`
    hook). Promotion is keyed on a server-generated `operationId` carried in the
    response (`recovery.operationId`, excluded from the projection) and requires a
    confirmed settle result with a non-empty transaction reference; the projection hash
    of the served bytes is an additional check. **Equal output does not identify an
    operation** — two requests that both resolve to `{"verdict":"no_match"}` are still
    distinct, and settling one never promotes the other. A failed, aborted or pending
    settlement promotes nothing. The replay cap (3) is per operation, bound to the key.
  - **The key is the only credential.** The service does **not** derive a payer identity
    from `x-payment`, `payment-signature`, or `payload.authorization.from`; those headers are
    unverified at the recovery layer. The facilitator-confirmed payer is stored as
    `verified_payer` for audit only. A forged `authorization.from` cannot replay anything.
  - **No companion alias.** An earlier design also recorded a verdict under a hash of the
    canonical request content. That made a settled verdict readable by anyone who could
    reproduce the body, so it was removed. A secret token returned only in the original
    response cannot help a lost-response retry; the original key is the only secret that
    survives, so it is the only one accepted. Reusing a key with **changed request content**
    returns `409 recovery_conflict` (`conflict: "request_mismatch"`) *before* the paywall —
    never the other operation's verdict, never a charge.
  - **After the window (typed, not silent):** expired verdicts leave a tombstone carrying the
    previous `responseHash` for 6 hours. A retry within the tombstone window re-measures with
    the paywall re-armed (there is no free measure after the window — anything else would be a
    loophole), but the response carries `recovery: { remeasured: true, previousResponseHash,
    expiredAt }`, so the calling agent can branch on "this operation was charged before and
    could not be replayed" instead of guessing.
  - **Regression controls:** `test/recovery.test.mjs` covers forged `authorization.from`,
    a different key with a known body, the victim's replay budget under forged traffic, and
    legitimate replay. Two staged operations with byte-identical output do not cross-promote;
    promotion is refused on failed/pending settle, a missing/empty transaction, or a missing
    `operationId`.
- **Evidence bundle — implemented (`verify402/evidence-bundle@1`):** every paid response
  carries `evidence_bundle: { requestHash, responseHash, pinnedBlock, mode, createdAt,
  payment.in }`. Both hashes are sha256 over canonical JSON (keys sorted recursively, no
  whitespace). `requestHash` covers `{ route, body }`; `responseHash` covers the response
  body excluding `evidence_bundle`, `recovery`, `cache`, `elapsedMs`. Reference
  implementation of the canonical form: `src/recovery.mjs` (`canonicalStable`), tests in
  `test/recovery.test.mjs`.
- **Payment caps (bridge/client):** `MAX_PAYMENT_USD` caps one payment at signature time;
  `MAX_DAILY_USD` (optional, `mcp-bridge/budget.mjs`) caps the whole UTC day across
  restarts via a local ledger. Attempted charges are counted before the payment is built —
  a spending guard should over-count, never under-count.

## Errors, honesty, chainId, and readiness

- **Honesty contract:** every `200` and every typed failure on `/verify`, `/safety`,
  `/route`, `/quotecheck`, and `/depth` includes non-empty `checked[]` and
  `notChecked[]`. `notChecked` names the real limits (unconfigured venues, transfer
  restrictions, execution, MEV) rather than implying coverage that doesn't exist.
- **Typed quote outcomes:** `quote_status` is `ok | partial | no_pool | failed`.
  `transport` and `decode` failures return `ok:false` with HTTP `503` and never
  become `AVOID`, `no_edge`, `unknown`, or `illiquid`. Only a genuine `no_pool` or
  venue `revert` may make a leg unavailable.
- **No settlement on failure:** the installed `@x402/express` middleware cancels
  settlement for any response `>= 400`. A `503` (transport/decode/RPC) is not charged.
- **Errors never leak:** responses carry a stable public code (`bad_request`,
  `rpc_unavailable`, `rpc_rate_limited`, `internal_error`, …) plus a `requestId`.
  Provider messages, RPC URLs, and API keys stay in the server log under the same id.
- **chainId is required:** every paid route and every transaction preflight requires an
  integer `chainId`. Missing => `400 missing_chain`; wrong type => `400 invalid_chain`;
  unsupported => `400 unsupported_chain`. There is no silent Ethereum default.
- **Readiness:** `/health` is liveness; `/ready` is a deep check that reads the latest
  block with a 3-second timeout.

## First paid call, in ten lines

1. `GET  https://verify402.onrender.com/info` — prices, endpoints, recovery contract.
2. `GET  https://verify402.onrender.com/findings` — free verdicts on majors; see the honest `no_edge` baseline.
3. `POST /verify` with your question (`{"chainId":1,"target":"WETH","size":100000}`) and no payment → HTTP 402.
4. Read the payment instructions from the `payment-required` response header.
5. Build an x402 payment for ≤ the stated price (Node example: `mcp-bridge/first-payment.mjs`; MCP users: `mcp-bridge/`).
6. Re-send the same request with the `payment` header. The verdict arrives with the settlement response.
7. On a retry/restart, add `x-idempotency-key: <crypto.randomUUID()>` to step 3 so lost responses replay free instead of paying twice. The key is a secret; a leaked key allows replay until the TTL/cap.
8. Verify the receipt: `evidence_bundle.responseHash` must equal sha256(canonical JSON of the body minus `evidence_bundle`, `recovery`, `cache`, `elapsedMs`).
9. Cap your own wallet: `MAX_PAYMENT_USD` (per call) and `MAX_DAILY_USD` (per day) in the bridge `.env`.
10. Repeat the call in the same block and compare `evidence_bundle.responseHash` — determinism of the measurement. An `edge` verdict should be raced, not trusted.

## Honesty

- No profit is promised. The measured answer for mainstream pairs is almost always
  `no_edge` — that is the market's fee boundary, not a failure of the tool.
- The service reports what it measured, not what it guarantees.
- Not financial advice.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.

You may use, modify, and distribute this software, including in commercial agent
systems and bots. If you redistribute it or a product containing it, keep the
copyright notice, the license text, and the `NOTICE` file. The `verify402` name
and logo are not licensed for endorsement.
