# verify402 — Phase 0 Audit

**Date:** 2026-10-20
**Repository:** `/Users/mac/Desktop/verify402`
**Commit:** `4a8fb1c` (`site: preload the Hairline bundle`)
**Mode:** audit only. No application code, routes, schemas, tests, or deployment configuration were changed.

---

## Hotfix resolution — 2026-10-21

This section is additive. The original audit below is preserved as the Phase 0 baseline.
Base commit: `4a8fb1c`. No npm version was published, nothing was deployed, and
`LICENSE` was not touched. The live service remains on the old commit until a
separate, explicit deploy.

### Resolved

| ID | Finding | Resolution | Commit(s) |
|---|---|---|---|
| C-1 | The recovery companion was a forgeable free read. | Removed the content-hash companion alias and every payer-scope check derived from `x-payment`, `payment-signature`, or `authorization.from`. The caller's original idempotency key plus the same request fingerprint is the only replay credential. Promotion still requires an operationId and a facilitator-confirmed settlement; the settlement payer is stored as `verified_payer` for audit only. | `001fd08` |
| C-2 | Transport/decode failures became market facts. | Quotes are typed `ok` / `no_pool` / `revert` / `transport` / `decode`. Any transport or decode failure in a configured venue aborts the measurement with `ok:false` and HTTP 503; it never becomes `AVOID`, `no_edge`, `unknown`, or `illiquid`. `no_pool` and `revert` remain legitimate unavailable-market facts. Failed measurements are not cached and not staged for settlement. | `5e176a0`, `d0bdb14` |
| C-3 | "Sellability" was a quote, not a sell; venue coverage was overstated. | Public copy now says **quote-based sellability check**. "Honeypot test" and "every venue" claims are gone. `notChecked` names unconfigured venues and untested transfer tax, blacklist, pause, and max-transaction restrictions. A banned-string regression test covers the public surfaces. | `5e176a0`, `7a7bf8f` |
| H-1 | Paid responses lacked `checked` / `notChecked`. | Every paid 200 and every typed failure on `/verify`, `/safety`, `/route`, `/quotecheck`, and `/depth` now carries non-empty `checked[]` and `notChecked[]`. Failures claim only request validation, not work that did not run. | `d0bdb14` |
| H-4 | Transaction preflight silently assumed Ethereum. | Every paid route and every transaction preflight now requires an integer `chainId`: missing => `400 missing_chain`, wrong type => `400 invalid_chain`, unregistered => `400 unsupported_chain`. No chain-1 default. Contract code is read on the named chain. | `c65d65f`, `7a7bf8f`, `8fa4457` |
| H-6 | `/health` was always healthy and errors could leak RPC detail. | Added a public error boundary with a stable code plus `requestId`/`x-request-id`; provider messages, viem details, and RPC URLs are logged server-side only. `/health` remains liveness; `/ready` is a deep latest-block check with a 3-second timeout. | `d0bdb14` |
| M-5 | A payment `PASS` could be entirely structural. | `PASS` is retained for backward compatibility. When `from`, payment proof, or a mainnet measurement is missing (including testnet and Solana structural checks), the response adds `structural_only: true` and `structural_only_reasons[]`. | `c65d65f` |
| L-4 | No dedicated safety or HTTP integration tests. | Added `test/safety.test.mjs`, `test/http.test.mjs`, `test/measure-typed.test.mjs`, `test/honesty.test.mjs`, and `test/claims.test.mjs`, plus H-4/M-5 cases in `test/preflight.test.mjs`. | `5e176a0`, `c65d65f`, `d0bdb14`, `7a7bf8f` |

#### C-1 regression record

Six C-1-named regression tests in `test/recovery.test.mjs` now define the contract:

1. `C-1: a content hash is not a second replay credential`
2. `C-1: a different key with a known body does not replay the victim's verdict`
3. `C-1: forged payer headers/scope cannot authorize a replay or spend the budget`
4. `C-1: a caller-supplied payer scope is ignored, not trusted`
5. `C-1: promotion records the facilitator payer for audit only`
6. `C-1: a fresh id cannot replay — only the original key survives a lost response`

The old companion-alias and payer-scope assertions were removed by design. There is no longer a content-hash companion read, and no payer scope derived from `x-payment`, `payment-signature`, or `authorization.from` is trusted: those inputs are attacker-controlled. The only replay credential is the caller's original idempotency key plus a matching request fingerprint. Promotion still requires an operationId and a facilitator-confirmed settlement; the verified payer is stored as `verified_payer` for audit only and cannot authorize a read.

The idempotency key is therefore a **bearer secret**. Hotfix 2 item 1 now enforces the entropy requirement for caller-supplied keys: a key must be a UUID v4 or a high-entropy URL-safe/hex value, never a guessable request-derived string. Callers should still generate it from a CSPRNG and treat it like a password.

### Still open

These were outside the approved hotfix scope. They are not silently marked done.

H-2, H-3, H-5, H-7, M-1, M-3, M-4, L-1, and L-2 are resolved in Hotfix 2 below.

| ID | Why it remains open |
|---|---|
| H-8 | Receipt verification is not yet bound to the caller's local intent. |
| M-2 | Preflight rate limiting is still per-process; concurrency is capped, not global. |
| L-3 | `/findings` remains a free chain read without its own rate limit. |

### Hotfix 2 — resolved 2026-10-21

| Item | Finding | Resolution | Commit |
|---|---|---|---|
| 1 | C-1 key entropy. | Idempotency keys are bearer credentials. UUID v4 or at least 32 URL-safe/hex characters with at least 16 distinct characters are accepted; weak keys return `400 weak_idempotency_key` with `crypto.randomUUID()` guidance. No key still means normal pay-per-call. Raw keys are never logged. The secrecy, replay, and leaked-key contract is in README, OpenAPI, the manifest, `/info`, `llms.txt`, and the site docs. | `b3aa5fc` |
| 2 | x402 version drift and settlement guard. | Root and MCP x402 packages are pinned exactly to `2.28.0`. The source guard remains, and a real `paymentMiddleware` + `ExactEvmScheme` test with a fake facilitator proves a `>=400` response never calls `settle` while a `200` does. | `4b807d9` |
| 3 | H-2 pinned block. | One block is pinned through `preTradeCheck`, `tokenFacts`, `sellabilityProbe`, `quoteAllVenues`, and both round-trip legs on `/safety`, `/verify`, `/route`, `/quotecheck`, and `/depth`. The measurement block is canonical in `evidence_bundle`; the pre-fetch cache key was aligned. Fake-client regression test added. | `7ffacdd` |
| 4 | H-3 depth decimals. | `/depth` uses real token decimals from `tokenFacts` for `gotTokens`. `impliedPriceBase` is the primary field; `impliedPriceUsd` remains only as a deprecated alias for known USD-stable bases, otherwise `null`. Six- and eight-decimal tests added. | `c1d7715` |
| 5 | H-5 MCP recovery. | Every MCP paid operation generates one high-entropy `x-idempotency-key`, retries lost responses/timeouts with the same key, surfaces `recovery.replayed`, and never auto-retries `402`/`409`. Tests cover 402, lost-response replay, and no double payment. The package `files` list now includes `paid-call.mjs`, and a packaging regression test covers local runtime imports. | `ceb4770`, `31ffade` |
| 6 | H-7 Host-derived identity. | Public identity never derives from `Host`. `AGENT_URL` is required and validated in mainnet (startup fails without it); testnet/local uses `TRUSTED_HOSTS` plus a default allowlist and returns `400 untrusted_host` otherwise. Forged-Host test added. | `ea9c6f3` |
| 7 | M-1 numeric validation. | Every paid numeric input is validated at the route boundary with explicit ranges, JSON numbers only, BigInt bps/ratios, uint256 raw limits, and one `badRequest` helper with stable codes. A table-driven malformed-input test exercises every paid route and asserts no 500s. | `29788b0` |
| 8 | L-1 exact 1:1 quote. | `quoteV2` accepts a legitimate `out == amountIn` result. Only zero and structurally wrong decodes fail. A stable-swap 1:1 test proves the shape guard is still active. | `a1d1317` |
| 9 | M-3 process-local state. | Recovery and `/usage` are documented as process-local and lost on restart in README, `docs/service-manifest.md`, `/info`, OpenAPI, the manifest, and `llms.txt`. Mainnet now refuses startup without `PREFLIGHT_SECRET`. `.env.example` lists every discovered server, registration, test, and MCP env var, including `PREFLIGHT_SECRET`, `ROUTE_PRICE`, `QUOTECHECK_PRICE`, `DEPTH_PRICE`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `AGENT_URL`, and `TEST_OFFLINE`, with placeholders only. | `7cb6405` |
| 10 | M-4 discovery drift. | `src/contract.mjs`, recovery, and preflight now supply shared TTL, concurrency, price, health/readiness-shape, and banned-claim values. Tests compare OpenAPI, manifest, `/info`, and live runtime for idempotency TTL, preflight concurrency, health/ready shapes, prices, and banned claims. Docs no longer quote fixed test counts; they point at `npm run test:counts`. Fixed TTL 300/600, concurrency 5/8, health fields, 409 wording, responseHash description, stale “NOT YET” publishing status, `DEPLOY.md` 5/5, and stale test counts. Added `/ready` to OpenAPI. | `21c6fbd` |
| 11 | L-2 hygiene. | Every response sets `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and a static-site CSP; `x-powered-by` is disabled. Free read-only discovery GET/HEAD/OPTIONS allows any origin; paid routes and `/preflight` emit no wildcard. `SIGTERM`/`SIGINT` stop new connections, drain in-flight requests up to `SHUTDOWN_TIMEOUT_MS`, then exit 0, or force-close and exit 1 on timeout. Header/CORS and drain/timeout tests added. | `ca673fd` |

### Addendum — logging, offline mode, audit consistency

| Item | Change | Commit |
|---|---|---|
| A | Central log redaction for URLs, credentials, headers, API keys, and idempotency keys; raw viem/`HttpRequestError` and stacks are formatted through it. `DEPLOY_CHECKLIST.md` records the rotation gate. | `74d579c` |
| B | `TEST_OFFLINE=1` uses one closed endpoint with no public fallback. `npm run test:offline` skips RPC-required tests; `npm run test:rpc` runs only those. Per-test classification lives in `test/rpc-manifest.json`; `npm run test:counts` derives counts from the sources. `quotecheck` no longer has a top-level RPC rejection. | `c952178` |
| C | This section; section 2 is marked as the `4a8fb1c` historical baseline; the C-1 regression record is above. | `d55c1a2` |

### Verification counts

Counts are not maintained by hand. Run:

```bash
npm run test:counts
```

That script derives per-file totals from the `check(...)` / `test(...)` declarations and the RPC subset from `test/rpc-manifest.json`. For the Hotfix 2 completion run, `npm test`, `npm run test:offline`, and `npm run test:counts` all exited 0. The raw summary lines are in the completion report; no fixed count is quoted here, so this section cannot go stale.

`npm test` runs the offline suite, the RPC-required suite, discovery tests, and `scripts/check-discovery.mjs`. `TEST_OFFLINE=1` still forces one closed endpoint with no public fallback.

### Public-facing text changed

- `README.md`: quote-based sellability, no honeypot proof, no companion alias, key-only recovery, required `chainId`, typed 503s, `requestId`, `/ready`, and `notChecked` limits.
- `mcp-bridge/index.mjs` and `mcp-bridge/README.md`: tool descriptions now say quote-based sellability; paid tools require `chainId`; preflight documents `structural_only`.
- `src/openapi.mjs`: required `chainId` on every paid route and transaction preflight; `checked`/`notChecked`, `quote_status`, `unavailable_reason`, `requestId`, typed 400/503 descriptions, 600-second key-only recovery.
- `src/manifest.mjs`: quote-based tool descriptions, `/ready`, 600-second key-only recovery, `requestValidation`, `errors`, `noProviderDetail`, `settlementOnFailure`, preflight concurrency 8.
- `src/landing.html`, `src/site/checks.html`, `src/site/docs.html`, `src/site/mcp.html`, `src/site/proof.html`: removed honeypot/every-venue claims; added quote-based wording and chainId/readiness notes.
- `docs/ai-agent-guide.md`, `docs/service-manifest.md`, `docs/x402-discovery.md`: same claim and contract corrections.
- Runtime `/info` and `/llms.txt` (served by `src/server.mjs`): quote-based sellability, required `chainId`, no companion alias, deep readiness, and typed-error guidance.

### Operational docs changed

- `DEPLOY_CHECKLIST.md`: paid always-on testnet/mainnet environment, pre-deploy gates, `npm run smoke` checks (including one paid testnet call), log checks, and a rollback plan. No deploy was performed.
- `CHANGELOG.md`: Hotfix 2 entry and the recommendation to patch-bump `verify402-mcp` to `1.0.4` when publication is approved. Nothing was published.

---


## 0. Executive verdict

verify402 is a real, working service, not a demo. The free preflight gate is the strongest part of the product: it has a clear three-state contract, explicit `checked` / `notChecked` lists, pinned-block freshness checks, HMAC receipts, fail-closed RPC handling, and a useful reference executor. The paid measurement engine is also substantive: it quotes through venue contracts at one block rather than reimplementing AMM math.

The current paid product is narrower than its strongest marketing language, and there are several places where an outage or a forged input can produce a confident but wrong answer. The most important issues are:

1. The idempotency “companion” recovery path can be used as a **free read of a settled paid verdict** by forging the unverified payer scope in the `x-payment` header.
2. RPC / transport failures are currently indistinguishable from “no pool / cannot fill,” so an outage can become a paid `AVOID`, `no_edge`, `unknown`, or `illiquid` verdict.
3. `/safety` describes a “honeypot test” and a sell probe, but it only asks quoters for a price. It does not execute or simulate a transfer, and it only knows the configured venues (Base has no V2 router configured and no non-Uniswap venue adapter).
4. A transaction preflight with no `chainId` silently checks Ethereum (`chainId = 1`) instead of refusing or asking.
5. The paid routes do not carry the same `checked` / `notChecked` honesty contract as `/preflight`, and some published claims (`every venue`, `honeypot test`, `pinned block`) are stronger than the implementation.

**Test status (historical baseline at `4a8fb1c`):** the Phase 0 suite passed at that commit. Do not quote its count as current; run `npm run test:counts` for the source-derived split. The baseline table is preserved in §2 and marked historical.

**Recommendation:** keep the free gate as the headline. Do not expand paid claims, pricing, or “trust layer” positioning until the critical findings in §6 are fixed and regression-tested. Phase 1 should start with correctness and failure classification, not new surface area.

---

## 1. Scope and method

I read the following, in the repository:

- `README.md`, `DEPLOY.md`, `DEPLOY_GO_LIVE.md`, `AGENTS.md`, `package.json`, `render.yaml`, `Dockerfile`
- `src/server.mjs`, `src/preflight.mjs`, `src/recovery.mjs`, `src/measure.mjs`, `src/safety.mjs`, `src/quotecheck.mjs`, `src/depth.mjs`, `src/config.mjs`, `src/dexscreener.mjs`, `src/usage.mjs`, `src/manifest.mjs`, `src/openapi.mjs`
- `mcp-bridge/index.mjs`, `budget.mjs`, `first-payment.mjs`, `payment-policy.mjs`, `README.md`, `llms-install.md`, `package.json`, `test/payment-policy.test.mjs`
- `test/*.mjs`, `scripts/check-discovery.mjs`
- `docs/*.md`, including the discovery audit, production discovery verification, service manifest, x402 discovery, agent guide, registry publishing, maintenance, and distribution checklist
- `examples/preflight-guard.mjs`, `examples/README.md`

I ran:

```bash
git status --short
git log --oneline -5
npm test
```

I also ran isolated, local-only checks against the recovery module to confirm the companion-key behavior described in §6. I did not read, print, or modify `.env` or credential files. I did not publish, deploy, move funds, or send a transaction.

The local `mcp-bridge/.env` file exists but is ignored by git; it was not read. Only `.env.example` files are tracked.

---

## 2. Test result and coverage — baseline at `4a8fb1c` (historical)

> **Historical baseline.** The table and limitations in this section describe commit `4a8fb1c` only. They are preserved to show what Phase 0 looked like and must not be quoted as current status. The current, script-generated counts are in **Verification counts** above.

Command:

```bash
cd /Users/mac/Desktop/verify402
npm test
```

Result:

| Suite | Checks | Network required | Result |
|---|---:|---|---|
| `test/recovery.test.mjs` | 25 | no | 25 passed |
| `test/measure.test.mjs` | 5 | **yes, mainnet RPC** | 5 passed |
| `test/quotecheck.test.mjs` | 6 | **yes, mainnet RPC** | 6 passed |
| `test/depth.test.mjs` | 5 | **yes, mainnet RPC** | 5 passed |
| `test/preflight.test.mjs` | 25 | no (injected client) | 25 passed |
| `test/preflight-guard.test.mjs` | 8 | no (fake HTTP) | 8 passed |
| `test/usage.test.mjs` | 13 | no | 13 passed |
| `mcp-bridge/test/payment-policy.test.mjs` | 12 | no | 12 passed |
| `test/discovery.test.mjs` | 5 | no | 5 passed |
| `scripts/check-discovery.mjs` | 33 | no (live HTTP skipped) | 33 passed |
| **Total** | **137** | **16 require mainnet RPC** | **137 passed, 0 failed** |

The network-required checks are exactly the three engine suites above. The measure suite also asserts that all configured venues have bytecode, that QuoterV2 agrees with a V2 router, that a $100k USDC round trip is not invented as profitable, that output is monotonic in size, and that a pinned block is deterministic. Those are good tests, and they passed on this run.

### What the tests do not cover

- `src/safety.mjs` has **no test file**. `preTradeCheck`, `tokenFacts`, `sellabilityProbe`, and the `/safety` route are untested.
- There are no HTTP integration tests for `/verify`, `/safety`, `/route`, `/quotecheck`, `/depth`, `/findings`, `/health`, or `/preflight`.
- The x402 settlement path, `onAfterSettle` promotion, and the recovery middleware are tested at the module level but not end-to-end through the real payment middleware.
- There is no test for rate limiting, concurrency limits, host-header handling, malformed input returning 500 instead of 400, or RPC failure classification.
- The MCP paid tools are not tested against a fake 402 or a lost response; only the payment policy is tested.
- No test asserts the paid-route honesty contract (`checked` / `notChecked`).

`npm test` is not offline-safe at `4a8fb1c`: a machine without mainnet RPC access will fail the 16 engine checks. That was true at the baseline. Current status: `npm run test:offline` sets `TEST_OFFLINE=1`, uses one closed endpoint with no public fallback, and skips the twelve RPC-required tests; `npm run test:rpc` runs only those twelve. See **Verification counts** above.

---

## 3. Architecture

### 3.1 Runtime shape

```text
HTTP client / MCP bridge
        |
        v
Express app (src/server.mjs)
  - express.json({ limit: "64kb" })
  - recovery middleware (runs before the paywall)
  - x402 paymentMiddleware (unless BYPASS_PAYMENT=1)
  - free routes: /preflight, /preflight/verify, /findings, /usage, discovery
  - paid routes: /verify, /safety, /route, /quotecheck, /depth
  - static site, landing page, OpenAPI, manifest, agent card
        |
        +--> src/measure.mjs   -> viem public clients -> RPC
        +--> src/safety.mjs    -> measure + Dexscreener
        +--> src/quotecheck.mjs
        +--> src/depth.mjs
        +--> src/recovery.mjs  -> in-memory replay store
        +--> src/usage.mjs     -> in-memory counters
        +--> src/openapi.mjs / src/manifest.mjs -> discovery contracts
```

### 3.2 Payment and settlement

- `X402_MODE` is `testnet` unless explicitly `mainnet`.
- Testnet uses Base Sepolia + Solana devnet and the public `https://x402.org/facilitator` by default.
- Mainnet uses Base + Solana mainnet and requires `FACILITATOR_URL`; CDP is used when `CDP_API_KEY_ID` is set.
- `BYPASS_PAYMENT=1` unmounts the paywall, prints a loud warning, and refuses to run with `X402_MODE=mainnet`.
- Paid responses are settled by the x402 middleware. The `onAfterSettle` hook promotes a staged recovery record only after a confirmed settlement with a transaction reference.
- Prices come from environment variables with defaults: `/verify` `$0.05`, `/safety` `$0.10`, `/route` `$0.03`, `/quotecheck` `$0.05`, `/depth` `$0.05`.
- The x402 402 challenge is the authoritative price; discovery documents repeat the same defaults.

### 3.3 State

All operational state is process-local and in memory:

- recovery: `Map` of staged/settled entries, TTL 10 minutes, max 3 replays, max 1,000 keys
- paid measurement cache: max 500 `(route, params, block)` results
- free-gate usage counters
- `/findings` snapshot and per-pair cache
- preflight per-IP buckets and global in-flight counter

A restart or deploy clears all of it. That matters for recovery: a caller who paid and lost the response can only replay if the same process is still alive and the record survived.

### 3.4 Preflight

`POST /preflight` accepts two intent kinds:

- `payment`: an x402 payment request (scheme, network, asset, amount, payTo, resource, timeout, authorization window)
- `transaction`: an EVM chain transaction (`to`, `data`, `value`, optional `from`)

The result is `PASS`, `CAUTION`, or `BLOCK`, with typed `reasons`, `checked`, `notChecked`, optional `block`, optional `simulation`, and an HMAC receipt. `sign_allowed` is false only for `BLOCK`; `requires_ack` is true for `CAUTION`.

Default receipt TTL is 90 seconds; accepted range is 15–300 seconds. EVM mainnet intents are bound to a fresh latest block where the chain is readable; a block older than 120 seconds is a hard block. A missing block timestamp is a 503, not a pass. Testnet EVM payment intents are accepted structurally without a block read. Paid-chain simulation is EVM-only and only for chains in the measurement registry (`1`, `42161`, `8453`).

### 3.5 MCP bridge

Package `verify402-mcp@1.0.3`, stdio transport. Free mode exposes `preflight_gate` without a wallet. Paid mode adds:

- `verify_arbitrage`
- `check_token_safety`
- `get_best_route`
- `verify_quote_fairness`
- `get_trade_depth`

The paid bridge is EVM-only (`ExactEvmScheme`), defaults to Base mainnet, and enforces network/payee/resource policy plus a per-payment USD cap. The free gate is deliberately separate from the paying client.

---

## 4. Public surface

### 4.1 Routes

| Route | Method | Price | Purpose |
|---|---|---:|---|
| `/` | GET | free | Landing HTML for browsers/crawlers, plain-text menu otherwise |
| `/health` | GET | free | Liveness only; always returns `ok: true` |
| `/info` | GET | free | Machine-readable capabilities and prices |
| `/usage` | GET | free | Process-local free-gate counters |
| `/findings` | GET | free | Cached Ethereum-majors snapshot |
| `/preflight` | POST | free | Pre-signing gate |
| `/preflight/verify` | POST | free | HMAC + expiry verification |
| `/verify` | POST | $0.05 | Cross-venue arbitrage round trip |
| `/safety` | POST | $0.10 | Token pre-trade gate |
| `/route` | POST | $0.03 | Venue quote book |
| `/quotecheck` | POST | $0.05 | Quote fairness audit |
| `/depth` | POST | $0.05 | Size ladder / capacity |
| `/openapi.json` | GET | free | OpenAPI 3.1 |
| `/llms.txt` | GET | free | LLM discovery text |
| `/sitemap.xml`, `/robots.txt` | GET | free | Discovery |
| `/.well-known/verify402.json` | GET | free | Service manifest |
| `/.well-known/x402` | GET | free | x402 capability manifest |
| `/.well-known/agent-card.json`, `/.well-known/agent-registration.json` | GET | free | ERC-8004 / A2A agent card |
| `/.well-known/402index-verify.txt` | GET | free | Public domain-ownership hash |
| static site | GET | free | `/start`, `/checks`, `/live`, `/proof`, `/docs`, `/mcp`, etc. |

### 4.2 Preflight coverage

**Payment intent**

Checked when applicable:

- scheme (`exact`)
- network (CAIP-2, supported family)
- asset (canonical USDC check where known)
- amount (positive raw integer; policy cap when canonical asset and network are known)
- `payTo` (format, policy allowlist, burn/blocked addresses)
- resource (https, policy `expectedResource`)
- `maxTimeoutSeconds` (positive, policy cap)
- optional payer balance and block freshness for supported EVM mainnet chains
- receipt signing and expiry

Deliberately not checked (reported in `notChecked`):

- payment signature / signed payload
- facilitator settlement
- recipient reputation
- sanctions screening
- off-chain promises
- counterparty identity / tool metadata
- prompt injection / hidden Unicode in tool output

**Transaction intent**

Checked when applicable:

- chain membership
- `from` / `to` address format and checksum where mixed-case
- zero/dead recipient and policy allowlists
- native value format and policy cap
- calldata decode for known selectors (ERC-20 transfer, approve, transferFrom, permit; Uniswap V2/V3; universal-router style selectors)
- target bytecode presence
- ERC-20 metadata for token calls
- `eth_call` simulation when `from` is present
- block freshness

Deliberately not checked:

- state-change / balance-delta simulation
- gas price/limit chosen by the signer
- raw signed-transaction binding
- contract audit
- recipient reputation
- sanctions screening
- off-chain promises
- counterparty identity / tool metadata
- prompt injection / hidden Unicode in tool output

### 4.3 Paid-route coverage

| Route | What it actually measures | What it does not measure |
|---|---|---|
| `/verify` | Best buy and sell quote at one pinned block; gross/net after configured gas and flash-loan premium | Execution, MEV, private orderflow, bridge/CEX liquidity, venues not in config, balance-delta simulation |
| `/safety` | Contract metadata, Dexscreener pair/signals, a quote for a USD-sized sell, a quote-based round trip at the intended size, optional price sanity | Actual token transfer / sell execution, transfer tax, blacklist, pause, max-tx, holder concentration, contract audit, sanctions, venues not in config |
| `/route` | Every configured venue quote for one pair/size at one pinned block, direct and WETH-routed | Aggregators, unconfigured DEXs, execution, slippage protection, MEV |
| `/quotecheck` | Compares an offered amount to the configured venue book at one pinned block | That the offer is executable, that `venueClaimed` is true, that `chainIn` is the chain that produced the offer, signature/provenance |
| `/depth` | Entry/exit quotes at a size ladder, round-trip cost, impact, capacity under a tolerance | Real execution, state changes, venues not in config, correct decimals for arbitrary tokens (see H-3) |

### 4.4 Honesty contract

`/preflight` returns both `checked` and `notChecked` on every 200 response. The paid routes do not:

- `/verify` returns neither.
- `/safety` returns `checked` but no `notChecked`.
- `/route` returns neither.
- `/quotecheck` returns `checked` but no `notChecked`.
- `/depth` returns `checked` but no `notChecked`.

Some error returns (`ok: false`) also omit both. This is a direct gap against the stated product requirement and the trust proposition.

---

## 5. What is strong and should be preserved

1. **The three-state preflight semantic.** `PASS` is explicitly “the listed checks passed at this block,” not “safe.” Keep that language and the `notChecked` list.
2. **Fail-closed chain reading in `/preflight`.** `getBlockSafe` turns RPC/rate-limit/timestamp failures into 503 with no receipt. That is the right behavior.
3. **Block freshness.** The 30-second caution and 120-second hard block are concrete and testable.
4. **Typed reasons.** Reason codes make the gate usable by an executor instead of forcing an LLM to interpret prose.
5. **Receipt HMAC and expiry.** The receipt is a useful primitive even if it needs stronger intent binding later.
6. **Reference executor ordering.** `examples/preflight-guard.mjs` refuses BLOCK, requires acknowledgement for CAUTION, verifies the receipt, and only then calls the signer. It is the right shape.
7. **Quote at one block, from venue contracts.** `measure.mjs` avoids reimplementing V3 tick math. The comments and tests show this was learned the hard way; keep it.
8. **Evidence bundle and response hash.** The canonicalization and response-hash recipe are a good foundation for attestations, even though the binding needs work.
9. **Payment policy in the MCP bridge.** Network/payee/resource allowlists, no redirects, and a separate free client are the right defenses.
10. **Backward-compatible discovery.** OpenAPI, manifest, MCP registry metadata, and site are all present and mostly consistent.

---

## 6. Findings

Severity is about impact on the product’s core promise: a paid answer should be true, and a `PASS` should mean exactly what it says. “Critical” means a user can get a wrong or free answer under realistic conditions.

### C-1. Critical — the recovery companion path is a forgeable free read

**Evidence**

- `src/server.mjs:129-139` derives `paymentScope` from the raw `x-payment` / `payment-signature` header by base64-decoding JSON and reading `payload.authorization.from`. It does not verify the payment signature.
- `src/server.mjs:148-160` runs the recovery lookup **before** `paymentMiddleware`.
- `src/recovery.mjs:201-226` checks the companion key when the presented idempotency key is unknown; it requires only that the forged `scope` equals the stored scope.
- `src/recovery.mjs:85-130` stores the companion alias as a hash of the request content, and the scope as the unverified header value.

**Reproduction (local, no network, no secrets):**

```bash
node --input-type=module -e '
import { recordSettlement, lookupRecovery } from "./src/recovery.mjs";
const victim = "0x1111111111111111111111111111111111111111";
const companion = "abc123";
recordSettlement("victim-key", { ok: true, verdict: "TRUST" }, companion, {
  settledNow: true, requestHash: companion, scope: victim,
});
const forged = lookupRecovery({
  key: "attacker-chosen-key", companionKey: companion,
  requestHash: companion, scope: victim,
});
console.log(Boolean(forged?.hit), forged?.hit?.payload?.verdict, forged?.hit?.replays);
'
```

Observed:

```text
true TRUST 1
```

**Impact**

An attacker who knows a settled request body and the payer address can present any idempotency key plus a forged base64 `x-payment` header naming that payer. The companion alias is derived from the request body, not from a secret. The recovery middleware returns the settled payload before the x402 paywall runs. This gives a free read of paid verdicts and consumes the victim’s three-replay budget, causing denial of recovery for the legitimate caller.

This is exactly the “verified payer scope” issue raised in the x402 review. The settlement hook verifies the payer at promotion, but the replay path does not.

**Fix direction**

- Never treat a raw `x-payment` header as identity.
- Derive payer scope only from a verified payment proof / facilitator verification, or from a server-issued opaque recovery token.
- Either remove the content companion until it can be bound to a verified payer, or make the companion a keyed value that requires a secret only the original caller has.
- Add a test that forges `authorization.from` and asserts no replay.
- Keep the staged/settled gate and `operationId` promotion; those parts are sound.

**Phase:** 1 or immediate security hotfix; also required before Phase 6 attestations.

---

### C-2. Critical — RPC failures are reported as substantive market facts

**Evidence**

- `src/measure.mjs:91-106` (`quoteV3`) catches every error and returns `null`.
- `src/measure.mjs:109-142` (`quoteV2`) does the same.
- `src/measure.mjs:188-245` (`quoteAllVenues`) turns every `null` / rejection into `unavailable: "no pool or cannot fill size"`.
- `src/safety.mjs:207-215` treats no quotes as `canSell: false` and returns `AVOID` (“cannot be exited”).
- `src/depth.mjs:110-117` reports `fillable: false` / “pair is effectively illiquid.”
- `src/verify` returns `ok: false` with “no venue ... could quote” (`src/measure.mjs:302-310`).
- `src/quotecheck.mjs:122-124` returns `unknown`.

**Impact**

A rate limit, timeout, failed RPC URL, decode mismatch, or provider outage becomes a confident paid answer. On a truth service, that is worse than a 503: it is a false accusation against a token, a false “no edge,” or a false “unknown.” The current catch-all also hides programming errors in decoding.

**Fix direction**

- Introduce a typed result such as `{ ok: false, kind: "transport" | "revert" | "decode" | "no_pool" }`.
- Only `no_pool` / empty data / genuine revert may become “unavailable.”
- Transport and decode failures must propagate as `ok: false` with no verdict, or as a 503, never as `AVOID` / `no_edge` / `unknown`.
- Add tests with a client that throws, a client that returns malformed data, and a client that returns a real revert.
- Preserve current response fields; add a typed `unavailable_reason` or `quote_status` field rather than removing `unavailable`.

**Phase:** 1 (engine correctness) and 3 (safety verdicts).

---

### C-3. Critical — “sellability” is a quote, not a sell; venue coverage is narrow

**Evidence**

- `src/safety.mjs:90-130` calls `quoteAllVenues` for the sell direction and returns `canSell: quoted`. It never sends a transfer or a router call with `from`, and it never simulates a state change.
- `src/safety.mjs:12-20` calls this the “honeypot” question, “answered by doing the thing rather than asking a flag.” It is doing a quote, not the thing.
- `src/measure.mjs:188-245` only enumerates `c.v3Fees` and `c.v2Routers`.
- `src/config.mjs:76-80`: Base has `v2Routers: []`; its only configured venue family is Uniswap V3. There is no Aerodrome or other Base DEX adapter.
- `mcp-bridge/index.mjs` and `README.md` describe `check_token_safety` as a “honeypot test” and “every venue.”

**Impact**

- A token that quotes but reverts on transfer (blacklist, pause, max-tx, transfer tax, trading-disable) can be reported as `TRUST`.
- A token whose liquidity is primarily on an unconfigured venue can be reported as `AVOID` (“cannot be exited”) even though it is tradable.
- The paid tool’s description is materially stronger than the measurement. This is the exact class of overclaim the honesty contract exists to prevent.

**Fix direction**

- Rename the check to “quoteable sell” until an actual transfer simulation exists, or implement a real sell simulation via a router `eth_call` with a funded `from` and state overrides where supported.
- Add venue adapters for the chains the product sells (at minimum a Base-native venue; do not claim “every venue” without them).
- Add explicit `notChecked` entries: transfer restrictions, taxes, blacklist, pause, max-tx, holder concentration, contract audit, sanctions.
- Add `test/safety.test.mjs` with: quoter-only token, reverting-transfer token, unconfigured-venue token, and malformed metadata.

**Phase:** 3 (token-safety hardening), with claim changes in Phase 9.

---

### H-1. High — paid responses do not carry `checked` / `notChecked`

**Evidence**

- `/preflight` returns both (`src/preflight.mjs:1170+` and route at `src/server.mjs:974`).
- `/safety` returns `checked` only (`src/safety.mjs:309`).
- `/quotecheck` returns `checked` only (`src/quotecheck.mjs:164`).
- `/depth` returns `checked` only (`src/depth.mjs:176`).
- `/route` returns neither; `/verify` returns neither (it has a `caveats` array at `src/measure.mjs:409`, not the contract fields) (`src/server.mjs:1435-1445`, `src/measure.mjs:369+`).

**Impact**

The paid product does not meet the stated honesty contract. A buyer cannot tell what was measured versus assumed, and the free gate is held to a stronger standard than the paid verdicts. This also makes the new “trust layer” positioning hard to defend.

**Fix direction**

- Add `checked` and `notChecked` to every 200 response on every paid route. Additive only.
- Use the actual limitations from §4.3, not generic caveats.
- Document the arrays in OpenAPI and MCP tool descriptions.
- Add a test that walks each route and asserts both arrays exist and are non-empty on success and on typed failure.

**Phase:** 1/3, and required before Phase 4 benchmark.

---

### H-2. High — `/safety` is not pinned to one block, but `evidence_bundle` claims one

**Evidence**

- `src/server.mjs:1364-1385` fetches a block number only for the cache key and then passes `pinnedBlock` into the evidence bundle.
- `src/safety.mjs:152-300` does not accept or use a block number. `tokenFacts`, Dexscreener, `sellabilityProbe`, and the buy/sell round trip all use latest state, at different moments.
- `src/measure.mjs:284-390` (`/verify`) does pin its own block, so the evidence bundle’s `pinnedBlock` from `src/server.mjs:1313` can also differ from the result’s actual `blockNumber`.
- `src/server.mjs:1469`, `1510`, and `1313` fetch a block before calling the measurement, then the measurement fetches its own block.

**Impact**

The response can say “measured at block N” while the facts came from N+1, N+2, or several seconds later. For `/safety`, the “round trip” can mix an entry quote and an exit quote from different blocks. That breaks reproducibility and the meaning of `evidence_bundle.pinnedBlock`.

**Fix direction**

- Thread one `blockNumber` through `preTradeCheck`, `tokenFacts`, `sellabilityProbe`, `quoteAllVenues`, and both legs.
- Use the measurement’s own block as the canonical `pinnedBlock` in the evidence bundle, not the pre-fetch cache key block.
- Add a test with a fake client that returns different blocks and asserts every quote call receives the same pinned number.

**Phase:** 1/3/4.

---

### H-3. High — `/depth` uses registry decimals or 18, not the token’s actual decimals

**Evidence**

- `src/depth.mjs:29-37` looks up decimals only in the configured registry; unknown tokens return `null`.
- `src/depth.mjs:147-150` uses `chainTokenDecimals(...) ?? 18` for `gotTokens` and `impliedPriceUsd`.
- `tokenFacts` already returns the real `decimals` (`src/safety.mjs:52-88`), but `/depth` does not pass it into the ladder.
- `src/depth.mjs:148` uses `base.decimals >= 0`, which is always true, so the `null` branch is unreachable.

**Impact**

For the long-tail tokens this product is for, `gotTokens` and `impliedPriceUsd` can be off by orders of magnitude (6- or 8-decimal tokens treated as 18). The risk/capacity fields based on percentages are less affected, but the human-readable price is wrong. If a caller passes a non-USD `baseSymbol`, `impliedPriceUsd` is also mislabeled.

**Fix direction**

- Pass `facts.decimals` from `tokenFacts` into the ladder and use it for `gotTokens` / `impliedPriceUsd`.
- Rename `impliedPriceUsd` to `impliedPriceBase` or return `null` when the base is not a known USD stable.
- Add a test with a 6-decimal and an 8-decimal token.

**Phase:** 3/4.

---

### H-4. High — transaction preflight silently assumes Ethereum

**Evidence**

- `src/preflight.mjs:1007`: `const chainId = Number(raw.chainId ?? body.chainId ?? 1);`
- The paid routes also default `chainId` to `1` (`src/server.mjs:1293`, `1346`, `1398`, `1457`, `1496`).

**Impact**

An agent on Base or Arbitrum that omits `chainId` gets an Ethereum check. If the target address exists on both chains, the simulation and contract-code checks can pass against the wrong state. That is a false `PASS` on a transaction the agent will sign on another chain. Even when it blocks, the reason is misleading.

**Fix direction**

- Require `chainId` for transaction intents. If absent, return a 400 `missing_chain` rather than defaulting.
- For paid routes, keep the default only if it is clearly documented and safe; better to require `chainId` or return a caution with `assumed_chain`.
- Add tests for missing chain, string chain, and an address with code on one chain but not another.

**Phase:** 1.

---

### H-5. High — MCP paid tools do not use idempotency keys or recovery

**Evidence**

- `mcp-bridge/index.mjs:253-355` calls `paidApi.post(...)` with no `x-idempotency-key` and no retry/recovery handling.
- The server’s recovery contract is only useful if the client sends the key on the first call.
- The MCP bridge is the primary distribution surface.

**Impact**

If a paid MCP call settles but the HTTP response is lost, the bridge cannot replay it. The next call pays again. The server-side recovery feature is effectively bypassed for the main client.

**Fix direction**

- Generate one idempotency key per tool operation and send it on the first call.
- On timeout/network error, retry with the same key and surface `recovery.replayed`.
- Do not retry on 402 or 409 without user-visible explanation.
- Add a fake-402 test and a lost-response test.

**Phase:** 8 (SDK/integrations), but it is also a paid-product reliability prerequisite.

---

### H-6. High — `/health` is always healthy; errors can leak RPC details

**Evidence**

- `src/server.mjs:1065-1067` always returns `ok: true`.
- `src/server.mjs:1335`, `1389`, `1449`, `1487`, `1524` return `{ error: e.message }` for paid-route failures.
- `src/server.mjs:993-997` returns `detail: e.message` from `/preflight` 503.
- `vim`/viem transport errors can include the configured RPC URL; if a private RPC URL contains an API key, that key can reach the client.

**Impact**

A Render health check can stay green while every measurement route is failing. Error messages can expose internal provider URLs/keys and implementation details. This is both an availability and a security issue.

**Fix direction**

- Keep `/health` as liveness, add `/ready` or `/health?deep=1` that checks a latest block and (optionally) facilitator reachability with a short timeout.
- Map external errors to a stable public code and a generic message; log the detail with a request ID.
- Never echo `e.message` from RPC/viem to a caller.
- Add `PREFLIGHT_SECRET` and the missing price/env keys to `.env.example`.

**Phase:** 5 (reliability/ops).

---

### H-7. High — the agent card trusts the Host header

**Evidence**

- `src/server.mjs:467-468`: `const base = process.env.AGENT_URL || `${req.protocol}://${req.get("host")}``.
- The response is served with `Cache-Control: public, max-age=3600` (`src/server.mjs:519-521`).

**Impact**

A caller can request `/.well-known/agent-card.json` with an arbitrary `Host` and receive a card advertising that host in `url`, `image`, and all `services` endpoints. With a shared cache, this becomes cache poisoning. Even without a cache, the public identity file is wrong for that request.

**Fix direction**

- Require an explicit canonical `AGENT_URL` in production, or validate `Host` against an allowlist.
- Do not derive public identity URLs from request headers.
- Add a test with a forged Host.

**Phase:** 5.

---

### H-8. High — receipt verification does not bind to the caller’s local intent

**Evidence**

- `src/preflight.mjs:603-620` (`verifyReceipt`) verifies spec, HMAC, and expiry only.
- It returns `intentHash` from the receipt but does not accept or recompute the caller’s intent.
- `examples/preflight-guard.mjs` compares `checked.intentHash === pre.intentHash`; both values come from the gate response, not from a local canonicalization.

**Impact**

The receipt is a server attestation of “this intent hash at this block,” but an executor cannot independently prove the receipt corresponds to the transaction it is about to sign without reimplementing the canonicalization. The current guard trusts the gate for the binding. That is acceptable if the gate is trusted, but it is not the “bound to the exact intent” property the docs imply.

**Fix direction**

- Let `/preflight/verify` accept `{ receipt, intent }` and recompute the canonical hash, comparing it to `receipt.intentHash`.
- Export a small canonicalization helper from the SDK.
- Add tests with a swapped intent and a tampered receipt.
- Keep the existing `{ receipt }` form for backward compatibility.

**Phase:** 6 (asymmetric attestations), with a Phase 1 API addition.

---

### M-1. Medium — input validation still produces 500s and precision loss

**Evidence**

- `/quotecheck` parses `amountIn` with `BigInt(amountIn)` outside the `try` (`src/quotecheck.mjs:59`); a non-integer string throws through the route to 500 (`src/server.mjs:1486-1488`).
- `/verify` converts `minNet` with `BigInt(Math.round(minNet * 10 ** decimals))`; `NaN`, `Infinity`, a negative `minNet`, or a huge `size` can throw or lose precision (`src/server.mjs:1320-1325`).
- `/safety` accepts any positive finite `intendedUsd` with no upper bound; a huge finite value can throw in the `BigInt` conversion (`src/safety.mjs:238`). The route rejects `Infinity`, but not a finite value large enough to overflow the scaling arithmetic.
- `/depth` converts `sizeUsd` with `Math.round(sizeUsd * 10 ** base.decimals)`; it caps at $1M, so less severe, but `Number` precision is still a limit.
- `/quotecheck` compares `Number(quotedOut) / Number(chainBest)`; 18-decimal values can lose wei-level precision.

**Impact**

Malformed paid requests can produce 500 instead of 400, and large sizes can be silently rounded. For a paid API, 500s are expensive and erode trust; silent rounding can change the verdict.

**Fix direction**

- Validate all numeric inputs at the route boundary with explicit ranges.
- Use `BigInt` arithmetic for ratios (bps) rather than `Number`.
- Add a shared `badRequest` helper with stable error codes.
- Add a table-driven malformed-input test for every paid route.

**Phase:** 1/5.

---

### M-2. Medium — preflight rate limiting assumes a trustworthy proxy and is globally concurrency-limited

**Evidence**

- `app.set("trust proxy", 1)` (`src/server.mjs:96`).
- Per-IP buckets are in memory (`src/server.mjs:926-950`).
- `PREFLIGHT_MAX_IN_FLIGHT = 8` is global, not per IP (`src/server.mjs:958`).
- `/findings` is free and can trigger RPC work with no rate limit.

**Impact**

On a direct connection, a client-supplied `X-Forwarded-For` may be trusted depending on the proxy chain. Even with correct Render headers, an attacker with many IPs can exhaust the eight global in-flight slots and block all preflight users. `/findings` can consume RPC quota.

**Fix direction**

- Verify the proxy chain assumption in production; add a test with and without `X-Forwarded-For`.
- Add per-client and global token buckets; separate read-only discovery from chain-reading routes.
- Add a small global RPC budget and a circuit breaker.

**Phase:** 5.

---

### M-3. Medium — recovery and usage state are process-local

**Evidence**

- `src/recovery.mjs` uses module-level `Map`s.
- `src/usage.mjs` uses module-level counters.
- `src/server.mjs` cache and findings snapshot are in memory.
- `src/preflight.mjs:93-94`: if `PREFLIGHT_SECRET` is unset, the receipt HMAC key is a random per-process value. A receipt issued by one instance is not verifiable by another. `/info` discloses whether the source is `env` or `ephemeral`.

**Impact**

A deploy, crash, or Render restart loses all replay records. A caller who paid and lost the response cannot recover after a restart. Usage counts reset. For a paid recovery guarantee, “10 minutes” is only true within one process lifetime. If the service is horizontally scaled, a client can receive a receipt from one instance and be rejected by `/preflight/verify` on another unless `PREFLIGHT_SECRET` is set consistently.

**Fix direction**

- Either state the process-local limitation prominently and keep only short TTLs, or move recovery records to a durable store (Redis/Postgres/KV) with the same TTL and replay cap.
- Add a startup/deploy note to the recovery docs.
- Do not promise cross-restart recovery until it exists.

**Phase:** 5.

---

### M-4. Medium — discovery and documentation have drifted from runtime

**Evidence**

- `src/openapi.mjs:89` and `:115` say idempotency TTL **300s**; `src/recovery.mjs:25` is **600s**.
- `src/openapi.mjs:153` mentions “concurrent in-flight operation” as a 409 cause; the recovery lookup has no concurrent-in-flight conflict.
- `src/openapi.mjs:216-230` requires `/health` fields `status`, `mode`, `networks`; the handler returns `ok`, `mode`, `price`, `preflight`, `networks`.
- `src/openapi.mjs:21` describes `responseHash` as canonical JSON `{ route, payload }`; `src/recovery.mjs:281-300` excludes `evidence_bundle`, `recovery`, `cache`, and `elapsedMs`.
- `src/manifest.mjs:208` and `docs/service-manifest.md:64` say preflight concurrency **5**; `src/server.mjs:927` is **8**.
- `docs/production-discovery-verification.md:16` says **123** tests/assertions; the current run is **137**.
- `docs/mcp-registry-publishing.md` still says npm and registry publishing are “NOT YET,” although `1.0.3` is published.
- `DEPLOY.md` says `npm test # 5/5`; the current suite is 137 checks.
- `.env.example` does not list `PREFLIGHT_SECRET`, `ROUTE_PRICE`, `QUOTECHECK_PRICE`, `DEPTH_PRICE`, or the CDP variables.

**Impact**

Discovery consumers and operators get contradictory contracts. For a service whose product is truth, stale metadata is a credibility problem. It also makes automated clients parse the wrong health or idempotency fields.

**Fix direction**

- Generate discovery contracts from one runtime source of truth, or add assertions that compare them.
- Add `test/discovery.test.mjs` assertions for TTL, concurrency, health shape, price parity, and test count.
- Update the docs in the same change as any behavior change.

**Phase:** 9, with small fixes as part of each phase.

---

### M-5. Medium — a payment `PASS` can be entirely structural

**Evidence**

- `src/preflight.mjs:898-917`: `from` is optional, and the payer balance is only read when `from`, a canonical USDC asset, and a measurement-supported EVM mainnet chain are all present.
- `src/preflight.mjs:688-696`: the payment `notChecked` list includes payment signature and facilitator settlement, but the top-level verdict can still be `PASS`.
- `src/preflight.mjs:913-917`: testnet EVM payment intents (`measurement: false`) do not read a block at all.

**Impact**

An agent can receive `PASS` for a well-formed payment challenge that has no payer, no balance check, no signature check, no settlement check, and (on testnet) no pinned block. The `notChecked` list is honest, but the word `PASS` is doing more work than the evidence supports. This is acceptable for a structural gate only if the documentation is explicit; it is not acceptable if `PASS` is marketed as “safe to sign.”

**Fix direction**

- Require `from` for a `PASS` on payment intents, or downgrade to `CAUTION` with `from_missing` when it is absent.
- Keep `notChecked` visible and add a `structural_only: true` flag for challenges with no payer/proof.
- Qualify testnet behavior in the docs: structural checks, no block binding.
- Add tests for `PASS` with no `from`, `PASS` with no proof, and testnet payment.

**Phase:** 1, with wording changes in Phase 9.

---

### L-1. Low — `quoteV2` rejects a legitimate exact 1:1 output

**Evidence**

- `src/measure.mjs:126-134`: if `out === amountIn`, return `null` to guard against the historical decode bug.

**Impact**

A legitimate stablecoin swap that returns exactly the input amount is reported as unavailable. This is rare but plausible for 6-decimal same-value pairs.

**Fix direction**

- Keep the structural `findUintArray` check and verify router/path/output length, then only treat equality as an echo when the decoded shape is wrong. Or add a separate `decode_guard` reason without discarding a valid result.

**Phase:** 1.

---

### L-2. Low — no security headers / CORS policy / graceful shutdown

**Evidence**

- No Helmet/security headers, no `app.disable("x-powered-by")`, no explicit CORS policy.
- `app.listen` has no SIGTERM/SIGINT handler.
- Static HTML is served with `no-store`, but discovery is public.

**Impact**

Mostly hygiene for a server-to-server API. Security headers matter for the human-facing site; graceful shutdown matters for deploys and in-flight measurements.

**Fix direction**

- Add Helmet or equivalent headers for HTML, a restrictive CORS policy for API routes, and a SIGTERM handler that stops accepting new work and closes the server.
- Do not add permissive `*` CORS to paid routes.

**Phase:** 5.

---

### L-3. Low — `/findings` is a free, expensive chain read with no rate limit

**Evidence**

- `src/server.mjs:945-1000` starts a refresh, coalesces it, and serves stale data, but there is no per-IP limit.
- Cold start triggers a full measurement pass.

**Impact**

A burst can consume RPC quota and delay the first paid or free-gate requests on a small instance. The cache and stale-while-revalidate design limits the damage, but not the cost.

**Fix direction**

- Share the preflight/RPC budget across `/findings`.
- Add a small per-IP discovery bucket and a global refresh lock (already present).

**Phase:** 5.

---

### L-4. Low — no dedicated safety or HTTP integration tests

This is the single largest test gap. `safety.mjs` is the most claim-sensitive module and has no tests. The route layer has no tests, so a change to `express.json`, recovery ordering, or a status code can break paid behavior without a red test. Add `test/safety.test.mjs` and `test/http.test.mjs` (or a supertest-style harness) before Phase 3.

**Phase:** 3/4.

---

## 7. Dead code, duplication, and maintainability

- `src/depth.mjs:29-37` duplicates token metadata logic that already exists in `safety.mjs:52-88`; this duplication caused H-3.
- `src/server.mjs` repeats block-number fetch + cache key construction in five paid routes; a shared `measureAtBlock` helper would make the pinned-block contract consistent.
- `src/openapi.mjs`, `src/manifest.mjs`, `src/server.mjs`, and `docs/*` independently encode prices, networks, TTLs, and concurrency. They already disagree (M-4).
- `mcp-bridge/index.mjs` repeats paid tool request shapes; an idempotency wrapper would be a single place to add recovery.
- No obvious unused modules. `quoteV3Path`, `bestRouteBook`, `expiredRecoveryInfo`, and the budget helpers are all reachable.

---

## 8. Prioritized plan

### Before Phase 1 (security/correctness hotfix)

1. **C-1**: remove or bind the companion recovery path; never trust the raw `x-payment` header for payer identity. Add the forged-scope regression test.
2. **C-2**: classify quote failures; stop turning transport errors into `AVOID` / `no_edge` / `unknown`.
3. **H-1**: add `checked` / `notChecked` to every paid response.
4. **H-4**: require `chainId` for transaction preflight (or return a typed caution, not a silent Ethereum default).
5. Update any public claim that says “honeypot test” or “every venue” until C-3 is fixed.

### Phase 1 — preflight depth and `/preflight/deep`

- Add `/preflight/deep` as a new paid or separately gated route; do not change existing `/preflight` fields.
- Add intent binding to `/preflight/verify` (H-8) as an optional `{ receipt, intent }` form.
- Add typed exit reasons and tests for RPC transport vs revert.
- Implement deterministic block threading and a shared `measureAtBlock`.
- Add HTTP-level tests for 400/409/429/503.

### Phase 2 — reputation store

- Do not build reputation on an unverified payer scope. Use the verified settlement payer only.
- Keep reputation additive; no change to existing verdicts without a new field or versioned route.
- Add a clear “reputation is not sanctions screening” `notChecked` entry.

### Phase 3 — token-safety hardening

- Real sell simulation or an explicit “quoteable only” rename.
- Add venue adapters for the chains you sell; do not claim “every venue” without them.
- Fix decimals (H-3) and block pinning (H-2).
- Add `test/safety.test.mjs` with the cases listed in C-3.

### Phase 4 — public accuracy benchmark

- Build the benchmark only from real, reproducible runs. Every number in the report must be traceable to a command, a block, and a commit.
- Include false-positive and false-negative cases, not just happy paths.
- Publish `notChecked` next to every result.

### Phase 5 — reliability/ops

- `/ready` or deep health; RPC circuit breaker; global budget; structured logs with request IDs; sanitized errors.
- Durable recovery or an explicit process-local limitation.
- No deployment in this phase; document hosting and failure modes.

### Phase 6 — asymmetric attestations

- Replace or supplement the HMAC receipt with a public-key signature.
- Bind the signature to the exact intent and block; publish a verifier that recomputes the intent hash locally.
- Keep the HMAC path for backward compatibility.

### Phase 7 — API tiers

- Add tiers as new fields/routes, not by changing existing prices or response shapes.
- Keep the free gate genuinely free and walletless.

### Phase 8 — SDK/integrations

- Idempotency in the MCP bridge and SDK.
- A single canonicalization helper for intent hashing.
- Fake-402 and lost-response tests.

### Phase 9 — repositioning/docs/licensing

- Align README, OpenAPI, manifest, docs, and MCP descriptions with the actual checks.
- Create `LICENSING_OPTIONS.md` only; do not modify `LICENSE`.
- Keep the `PASS` disclaimer visible wherever `PASS` is shown.

---

## 9. Backward-compatibility constraints for the next phases

- Do not rename or remove existing endpoints, MCP tools, response fields, or receipt fields.
- Add new behavior in new fields, new endpoints, or versioned routes.
- Keep the free `/preflight` and `/preflight/verify` available without a wallet.
- Keep `PASS` / `CAUTION` / `BLOCK` semantics; a `PASS` must never become “safe.”
- Keep fail-closed behavior on chain read failure.
- Keep x402 prices authoritative over discovery metadata; make metadata match.
- Do not print, commit, or paste secrets, private keys, or `.env` contents.
- Do not publish npm without explicit approval; `1.0.3` remains the approved version.
- Do not deploy in Phase 5; document hosting instead.

---

## 10. Bottom line

The free preflight gate is a credible product and the right headline. The paid measurement engine is real but currently overclaims in three places: venue coverage, honeypot/sellability, and failure classification. The recovery companion bug is the most urgent because it breaks the paid trust boundary directly. Fix C-1 through C-3 and H-1/H-2/H-4, add the missing safety and HTTP tests, then proceed with the phased plan.

No code has been changed. This file is the Phase 0 deliverable for review.
