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
- **Tarball URL:** npm package tarball (`https://registry.npmjs.org/verify402-mcp/-/verify402-mcp-1.0.4.tgz`) for direct `npx` execution without local cloning. A GitHub release asset is optional and is not required for installation.
- **Registry Name:** `io.github.a32116150-ctrl/verify402-mcp` (matches official MCP Registry name).
- **Published package boundary:** npm `verify402-mcp@1.0.4` is immutable and its built-in paid-call default is Base mainnet (`eip155:8453`). The manifest declares no `VERIFY402_NETWORKS` default and marks it required. For the public Base Sepolia demo, clients must set `VERIFY402_NETWORKS=eip155:84532` explicitly. The local source-tree default is testnet, but that is a future-package change, not a change to the published artifact.
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
- **Networks (public demo):**
  - Base Sepolia (`eip155:84532`), testnet USDC asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
  - Solana devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`), testnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- **Facilitator (public demo):** the public `https://x402.org/facilitator`.
- **Explicit mainnet:** a separate future deployment may use Base mainnet (`eip155:8453`) and Solana mainnet with a production facilitator such as PayAI or Coinbase CDP. It requires separate readiness verification and is not the demo default.
- **Headers:** 402 challenge serves `WWW-Authenticate: x402`. Retries include proof in `PAYMENT-SIGNATURE` (current x402 v2 header); the legacy `x-payment` alias is also accepted.

### 3. Operational Policies

> **Process-local state:** recovery records and `/usage` counters live only in this process. A restart or deploy loses both: a previously settled idempotency key may be charged again, and usage counts reset. Neither is shared across instances.

- **Rate Limits:** `POST /preflight` enforces 60 requests/minute per IP with a concurrency cap of 8.
- **Idempotency:** Callers can provide `x-idempotency-key` on paid routes. A settled verdict is cached and replayable up to 3 times within 600 seconds without incurring a second charge. Use `crypto.randomUUID()` or at least 32 URL-safe characters with at least 16 distinct characters; weak keys return `400 weak_idempotency_key`. The key is a secret: a leaked key allows replay until the TTL/replay cap. Recovery is not a durable ledger and does not survive a restart.
- **Receipts:** Preflight responses include an HMAC-SHA256 receipt valid for 90 seconds (configurable 15–300s). `POST /preflight/verify` re-checks the HMAC and expiry.
- **CORS:** Free read-only discovery (`GET`/`HEAD`/`OPTIONS`) allows any origin. `POST /preflight` and paid routes send no `Access-Control-Allow-Origin`; browser-based agents must use a server-side client, the MCP bridge, or an SDK.
- **Security headers:** Every response sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a static-site CSP. `x-powered-by` is disabled.
- **Shutdown:** `SIGTERM`/`SIGINT` stop new connections, drain in-flight requests up to `SHUTDOWN_TIMEOUT_MS` (default 10000ms), then exit `0`; a drain timeout force-closes and exits `1`.

---

## Programmatic Consumption Example

```javascript
import axios from "axios";

const manifest = await axios.get("https://verify402.onrender.com/.well-known/verify402.json").then(r => r.data);

console.log("Service:", manifest.name, manifest.version);
console.log("Free tools:", manifest.integrations.mcp.tools.filter(t => t.type === "free").map(t => t.name));
console.log("Supported networks:", manifest.paymentRequirements.supportedNetworks.map(n => n.name));
```
