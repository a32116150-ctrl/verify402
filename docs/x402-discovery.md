# x402 Bazaar Discovery Implementation & Verification

**Protocol Version:** x402 v2 (`@x402/core@^2.28.0`, `@x402/express@^2.28.0`, `@x402/extensions@^2.28.0`)
**Extension:** x402 Bazaar Discovery (`declareDiscoveryExtension`)
**Public Demo Host:** `https://verify402.onrender.com`
**Deployment Mode:** Testnet (`X402_MODE=testnet`) for payments; analysis reads mainnet chain data
**Networks:** Base Sepolia (`eip155:84532`) & Solana devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)

---

## 1. Overview & Architecture

x402 Bazaar is an extension to the x402 HTTP payment protocol designed to enable autonomous agents and crawler indexes to dynamically discover machine-payable APIs without out-of-band documentation.

When an unauthenticated agent makes an HTTP request to any paid route without a `PAYMENT-SIGNATURE` header (the current x402 v2 proof header; legacy `x-payment` is also accepted), Verify402 returns HTTP `402 Payment Required`. Within the 402 challenge response body:
1. `accepts`: Enumerates the payment parameters (scheme, network, asset, atomic amount, payee address, timeout).
2. `extensions.bazaar`: Contains rich, machine-readable discovery metadata declaring:
   - `method`: HTTP method (`POST`)
   - `bodyType`: Request payload encoding (`json`)
   - `input`: Realistic example input payload
   - `inputSchema`: JSON Schema describing all parameters and constraints
   - `output`: Complete example output with full evidence bundle shape

---

## 2. Server Implementation

Verify402 implements Bazaar discovery across all five paid routes in `src/server.mjs` using `@x402/extensions/bazaar`:

```javascript
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

// Example route declaration in paymentMiddleware
"POST /verify": {
  accepts: accepts(PRICE),
  description: "Measure whether a cross-venue arbitrage round trip is profitable right now...",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      method: "POST",
      bodyType: "json",
      input: { chainId: 1, target: "WETH", base: "USDC", size: 100000 },
      output: {
        example: {
          ok: true,
          verdict: "no_edge",
          chainId: 1,
          chainName: "ethereum",
          blockNumber: 21000000,
          /* ... full evidence bundle shape ... */
        },
      },
      inputSchema: {
        properties: {
          chainId: { type: "integer", description: "1 Ethereum, 42161 Arbitrum, 8453 Base" },
          target: { type: "string", description: "Token symbol to buy and sell back, e.g. WETH" },
          base: { type: "string", description: "Token to trade from, default USDC" },
          size: { type: "number", description: "Amount of base to trade, in whole units" },
          minNet: { type: "number", description: "Required net profit in base units to call it an edge" },
        },
        required: ["target"],
      },
    }),
  },
}
```

### Covered Paid Endpoints

| Route | Price (USD) | Bazaar `inputSchema` Declared | Example Output Included |
|---|---|---|---|
| `POST /verify` | $0.05 | `chainId`, `target`, `base`, `size`, `minNet` | `no_edge` with QuoterV2 / V2 router quotes & costs |
| `POST /safety` | $0.10 | `chainId`, `tokenAddress`, `intendedUsd`, `offeredPriceUsd`, `baseSymbol` | `TRUST` with quote-based sellability evidence, venue list, and notChecked transfer restrictions |
| `POST /route` | $0.03 | `chainId`, `tokenIn`, `tokenOut`, `amountIn` | Best route & full venue book |
| `POST /quotecheck` | $0.05 | `chainId`, `tokenIn`, `tokenOut`, `amountIn`, `quotedOut`, `venueClaimed` | Audit verdict (`fair`) & comparison metrics |
| `POST /depth` | $0.05 | `chainId`, `tokenAddress`, `baseSymbol`, `maxRoundTripPct`, `sizesUsd` | Capacity in USD & per-size ladder |

---

## 3. Verification Procedure

To inspect and verify that Bazaar metadata is emitted correctly by the live public demo, issue an unpaid request to any paid route:

```bash
# Verify POST /verify emits Bazaar discovery extension
curl -sS -X POST https://verify402.onrender.com/verify \
  -H 'content-type: application/json' \
  -d '{"target":"WETH"}' | jq .extensions
```

Expected output:
```json
{
  "bazaar": {
    "version": 1,
    "method": "POST",
    "bodyType": "json",
    "input": { ... },
    "inputSchema": { ... },
    "output": { ... }
  }
}
```

The HTTP status code must be `402 Payment Required`.

---

## 4. Facilitator Settlement & Indexing Limitations

### Facilitator Architecture
- **Settlement Role:** In x402, facilitators are non-custodial settlement processors: they verify payer signatures and coordinate transaction broadcasts.
- **Current public demo:** testnet settlement through the public `https://x402.org/facilitator`.
- **Explicit mainnet (separate deployment only):** Verify402 can support keyless mainnet settlement via PayAI (`https://facilitator.payai.network`) and Coinbase CDP (`createCdpFacilitatorClient`), but this is not the public demo and requires separate readiness verification.
- **External Catalog Indexing:**
  - Some third-party facilitators and aggregators (e.g. x402scan, 402 Index) crawl hosts either via DNS TXT records (`draft-hawkins-x402-dns-discovery-02`), `.well-known/x402`, or OpenAPI documents (`/openapi.json`).
  - Neither PayAI nor CDP provides a synchronous "confirm indexed" submission API.
  - Absence of an explicit listing in external aggregator search interfaces does **not** signify a protocol error; Verify402 emits all standard metadata in compliance with x402 specifications.
  - **Status:** Bazaar discovery is **IMPLEMENTED and ACTIVE** on all paid routes. External indexing across third-party crawler catalogs is **PENDING DISCOVERY CRAWL** (no fake submissions or artificial claims).
