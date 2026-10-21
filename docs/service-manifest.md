# Verify402 Canonical Service Manifest

**Location:** `/.well-known/verify402.json`
**MIME Type:** `application/json`
**Caching:** `Cache-Control: public, max-age=300`
**Purpose:** Provides a single, versioned, machine-readable discovery document describing the complete Verify402 service surface: endpoints, MCP tool registration, exact x402 payment requirements, networks, rate limits, idempotency policies, and security boundaries.

---

## Specification & Consumption

Agents, crawlers, and frameworks can fetch `https://verify402.onrender.com/.well-known/verify402.json` to configure automated integrations without hardcoded URLs or pricing assumptions.

### Top-Level Fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | string | Manifest schema version (`1.0.0`) |
| `name` | string | Project identifier (`verify402`) |
| `title` | string | Human-readable service title |
| `description` | string | High-level summary of service functionality |
| `version` | string | Semver release version |
| `license` | string | Open source license (`Apache-2.0`) |
| `canonicalUrl` | string | Canonical base URL (`https://verify402.onrender.com`) |
| `repository` | object | Git repository link and subfolder |
| `documentation` | object | Key public documentation and schema URLs |
| `integrations` | object | MCP server configuration and HTTP API details |
| `paymentRequirements` | object | Canonical x402 payment details, networks, and prices |
| `freeEndpoints` | array | List of public endpoints that require no payment |
| `operationalPolicies` | object | Rate limits, idempotency rules, and receipt TTL |
| `securityBoundaries` | object | Fail-closed rules, non-custodial signing boundaries, disclaimers |

---

## Integration Reference

### 1. Model Context Protocol (MCP)

The `integrations.mcp` section details how to connect via MCP:
- **Transport:** `stdio`
- **Package Identifier:** `verify402-mcp`
- **Tarball URL:** Published GitHub release asset for direct `npx` execution without local cloning.
- **Registry Name:** `io.github.a32116150-ctrl/verify402-mcp` (matches official MCP Registry name).
- **Tools:**
  - `preflight_gate`: Free pre-signing gate for payment requests and raw transactions.
  - `verify_arbitrage`: Paid ($0.05) cross-venue arbitrage reality check.
  - `check_token_safety`: Paid ($0.10) token gate with live contract facts and a quote-based sellability check (not a transfer simulation).
  - `get_best_route`: Paid ($0.03) execution book across DEX venues at one pinned block.
  - `verify_quote_fairness`: Paid ($0.05) third-party quote auditor.
  - `get_trade_depth`: Paid ($0.05) trade capacity and position sizing ladder.

### 2. x402 Payment Settlement

The `paymentRequirements` section specifies:
- **Scheme:** `exact` (standard x402 v2 payment)
- **Networks:**
  - Base mainnet (`eip155:8453`), USDC asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  - Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **Facilitators:** PayAI (`https://facilitator.payai.network`) and Coinbase CDP.
- **Headers:** 402 challenge serves `WWW-Authenticate: x402`. Retries include proof in `x-payment` or `payment-signature`.

### 3. Operational Policies

- **Rate Limits:** `POST /preflight` enforces 60 requests/minute per IP with a concurrency cap of 8.
- **Idempotency:** Callers can provide `x-idempotency-key` on paid routes. A settled verdict is cached and replayable up to 3 times within 600 seconds without incurring a second charge. Use `crypto.randomUUID()` or at least 32 URL-safe characters with at least 16 distinct characters; weak keys return `400 weak_idempotency_key`. The key is a secret: a leaked key allows replay until the TTL/replay cap. Recovery is not a durable ledger and does not survive a restart.
- **Receipts:** Preflight responses include an HMAC-SHA256 receipt valid for 90 seconds (configurable 15–300s). `POST /preflight/verify` re-checks the HMAC and expiry.

---

## Programmatic Consumption Example

```javascript
import axios from "axios";

const manifest = await axios.get("https://verify402.onrender.com/.well-known/verify402.json").then(r => r.data);

console.log("Service:", manifest.name, manifest.version);
console.log("Free tools:", manifest.integrations.mcp.tools.filter(t => t.type === "free").map(t => t.name));
console.log("Supported networks:", manifest.paymentRequirements.supportedNetworks.map(n => n.name));
```
