# Verify402 — External Review Handoff

**Review date:** 2026-10-21, 18:00–18:30 UTC  
**Repository:** `/Users/mac/Desktop/verify402`  
**Reviewed commit:** `248923f` (`docs(deploy): add mainnet switch checklist and wallet safety`)  
**Live service:** <https://verify402.onrender.com>  
**MCP package:** `verify402-mcp@1.0.4` on npm  
**Review type:** read-only security, correctness, release, and commercial-readiness review  
**Changes made for this review:** this file only. No source, tests, package metadata, environment, deployment, Git history, npm publication, or on-chain transaction was changed.

> **Evidence labels used below**
>
> - **[V] Verified** — observed directly in source, the published package, the live HTTP service, a public registry, or an on-chain RPC during this review.
> - **[C] Claim** — stated by a repository document or project-authored text, but not independently proven here.
> - **[U] Unknown / not verifiable** — requires dashboard, credential, private infrastructure, real payment, or external usage data that this review does not have.
>
> A feature existing in code is not treated as proof that it works in production. A `PASS` is not treated as “safe”; the repository’s own honesty contract says the opposite, and this report preserves that distinction.

---

## 1. Executive summary

### Bottom line

Verify402 is a **working testnet demonstration of a real measurement service**, with unusually strong fail-closed instincts and an honest `checked` / `notChecked` contract. It is **not mainnet-ready and not commercially ready**.

The strongest parts are real:

- The free preflight gate is live and fail-closed: a sample payment intent returned `PASS` with `structural_only: true`, a pinned block, explicit `checked` and `notChecked` lists, and an HMAC receipt; `POST /preflight/verify` returned `valid: true` for that receipt. **[V]**
- All five paid routes are payment-gated: `/verify`, `/safety`, `/route`, `/quotecheck`, and `/depth` returned HTTP `402` without payment. **[V]**
- The paid measurement engine uses pinned-block Uniswap QuoterV2 and venue-router quotes, with typed transport/decode failures and a real 100k-USDC “do not invent profit” test. **[V]**
- Hotfix 2 fixed the original critical/high audit findings except H-8, and the live service rejects weak idempotency keys (`400 weak_idempotency_key`), which is consistent with that hotfix being deployed. **[V]**
- `npm test`’s configured scripts passed on 2026-10-21 (206 declared tests: 194 offline, 12 RPC; 205 wired, with `test/post-deploy.test.mjs` excluded). The live post-deploy checker passed 22/22 checks. **[V]**

The blockers are equally real:

- **Release surfaces disagree.** npm is `1.0.4`; GitHub, the MCP Registry, and the live service are still `1.0.3`. The `mcp-v1.0.4` GitHub release and tarball return `404`; the repository’s own `1.0.4` tarball links are broken. The npm `gitHead` points to local commit `248923f`, which is not on the public remote. **[V]**
- **The live service is testnet, but the documented paid MCP setup is mainnet.** The live 402 challenge is Base Sepolia (`eip155:84532`); the MCP bridge defaults to Base mainnet (`eip155:8453`) and the README tells users to fund Base mainnet USDC. A local policy check against the live challenge fails with “402 offered no payment on an allowed network/payee.” **[V]**
- **There is no verified mainnet settlement path.** Only the operator’s Base Sepolia `$0.03` test transaction is documented; I verified that receipt on Base Sepolia, but it is not mainnet revenue. No mainnet facilitator, paid always-on host, or real mainnet payment is verified. **[V]/[U]**
- **H-8 remains open.** `/preflight/verify` validates the receipt HMAC and expiry but does not recompute the caller’s local intent; the reference guard compares two hashes that both came from the gate. The “bound to the exact intent” claim is therefore server-attested, not independently enforceable. **[V]**
- **Recovery is process-local.** A restart or deploy can lose the replay record after settlement, and concurrent duplicate requests with the same key are not reserved in-flight. That is a real double-charge risk for paid retries. The audit record calls M-3 “resolved” because it was documented; it was not technically eliminated. **[V]**
- **Three repository documents claim production mainnet**, while live `/health` says `testnet`. This is a trust problem for a service whose core product is honest measurement. **[V]**
- **There is no external customer, revenue, or market-validation evidence in the repository**, and `SUPPORT.md` itself says there is no funding and no external payment yet. I have not invented any. **[C]/[U]**

### Readiness verdict

| Question | Answer |
|---|---|
| Is the free gate live and usable? | **Yes**, on the testnet demo. **[V]** |
| Are paid routes correctly paywalled? | **Yes**, they return 402 without payment. Paid delivery is not verified live. **[V]/[U]** |
| Is the live service mainnet? | **No.** `/health` says `testnet`; the 402 rail is Base Sepolia. **[V]** |
| Is it safe to advertise as mainnet-ready? | **No.** No mainnet settlement, no paid always-on host, no explicit mainnet payee/facilitator validation. |
| Is it commercially ready? | **No.** Testnet revenue, no customers/revenue evidence, no durable recovery, no legal/terms/SLA, release drift. |
| Is the measurement engine credible? | **Largely yes for what it claims**, with explicit venue and execution limits. It is not an execution simulator or safety proof. **[V]** |
| Is the published MCP package source-verifiable? | **Partially.** The tarball matches local `mcp-bridge` files byte-for-byte, but its `gitHead` commit is not public. **[V]** |

### Smallest path, in one sentence

**Reconcile one version and deploy that exact commit; make the live rail and the MCP default agree; move to an always-on paid host with an explicitly configured mainnet facilitator and payees; fix H-8; add in-flight idempotency protection or durable recovery; then make one small real mainnet payment and verify settlement, replay, and restart behavior before calling it production.**

That is a technical path, not a commercial one. Commercial readiness additionally requires support, legal terms, monitoring, and evidence of demand.

---

## 2. Scope, method, and evidence limits

### What was inspected

- Source: `src/server.mjs`, `src/preflight.mjs`, `src/recovery.mjs`, `src/config.mjs`, `src/measure.mjs`, `src/safety.mjs`, `src/depth.mjs`, `src/quotecheck.mjs`, `src/openapi.mjs`, `src/manifest.mjs`, `src/contract.mjs`, `src/public-url.mjs`, site assets, deployment files.
- MCP bridge: `mcp-bridge/index.mjs`, `paid-call.mjs`, `payment-policy.mjs`, `budget.mjs`, `package.json`, `package-lock.json`, `README.md`, `.env.example`.
- Tests and scripts: `package.json`, `test/*`, `scripts/smoke.mjs`, `scripts/post-deploy-check.mjs`, `scripts/test-counts.mjs`, `scripts/check-discovery.mjs`.
- Documents: `README.md`, `AUDIT.md`, `DEPLOY_READINESS.md`, `MAINNET_SWITCH_CHECKLIST.md`, `RENDER_ENV_TESTNET.md`, `SUPPORT.md`, `docs/*`, `examples/*`.
- Public artifacts: npm registry metadata and tarball, GitHub tags/releases/assets, MCP Registry versions, live HTTP surfaces, Base Sepolia RPC receipt.
- Git: local branch, remote, tags, commit timestamps.

### What was not done

- No source or test edits, no dependency installation, no package publication, no deployment, no environment changes.
- No blockchain transaction was signed or sent.
- No paid live call was made; `SMOKE_PAID` was not enabled.
- No `.env` or credential file was read for values. Credential values are not included in this report.
- No Render dashboard, npm account, GitHub settings, MCP Registry account, or wallet was accessed.
- No external customer, revenue, usage, or market data was available.

### Evidence limits that matter

1. **Actual Render environment values** cannot be confirmed from the repository. Live behavior shows `testnet`, a configured `PREFLIGHT_SECRET` (the live `/info` says receipts use the env secret), and testnet payment requirements. It does not reveal the secret value or the exact dashboard configuration.
2. **The deployed commit cannot be proven.** Live version strings and static-file `Last-Modified` are consistent with `origin/master` at `181e5cb`, but the deployment system does not expose a commit identifier. It is not local HEAD `248923f`: the live manifest still points at `mcp-v1.0.3`, while local `1.0.4` prep points at `mcp-v1.0.4`.
3. **Live settlement behavior is unverified.** The only verified settlement is the documented Base Sepolia transaction. No mainnet facilitator, no real mainnet payment, and no live paid response were observed.
4. **Cold-start behavior was not measured.** The service was warm during probing; post-deploy wake took 822 ms. The repository’s “about 60 seconds after idle” statement is plausible but not independently tested here.
5. **Commercial claims cannot be validated.** There is no analytics, customer list, invoice, or revenue ledger. I make no usage, revenue, or demand claim.

---

## 3. Repository and Git state

### Current state **[V]**

| Item | Value |
|---|---|
| Local branch | `master` |
| Local HEAD | `248923f` |
| Origin HEAD | `181e5cb` |
| Ahead/behind | `2` commits ahead of `origin/master`, `0` behind |
| Working tree | Clean before this report; only this untracked report added |
| Local tags | `mcp-v1.0.3`, `mcp-v1.0.2`, `mcp-v1.0.1`, `mcp-v1.0.0` |
| Latest GitHub tag | `mcp-v1.0.3`; no `mcp-v1.0.4` |
| Root package | `verify402@0.1.0`, private; not the published package |
| MCP package | `verify402-mcp@1.0.4` |
| Node / npm used | Node `22.23.3`, npm `10.9.9` (recorded in prior run) |

Commits ahead of origin:

- `2d4bda3` — `chore(mcp): prepare verify402-mcp 1.0.4`
- `248923f` — `docs(deploy): add mainnet switch checklist and wallet safety`

### CI and publication provenance

- CI was reported green on pushed HEAD `181e5cb` earlier in this review. I did not re-query CI during final report writing.
- Local HEAD `248923f` is **not pushed**, so it has no public CI result.
- npm `verify402-mcp@1.0.4` reports `gitHead` `248923f7948198e2a1712d6608f0a723524d0088`, i.e. the unpublished local commit. The public GitHub commit page for that hash returns `404`. That makes the published package **not source-reproducible from the public repository** even though its local files match.
- No `git add -A`, commit, tag, publish, or deploy was performed for this task.

### Repository hygiene observations

- The root package is private and versioned `0.1.0`; the service version is expressed in several unrelated places (`src/manifest.mjs`, `src/openapi.mjs`, `src/server.mjs`, `src/site/mcp.html`, `mcp-bridge/package.json`, `server.json`). There is no single version source of truth.
- A local `mcp-bridge/.env` exists and is gitignored. It is not in the npm tarball’s file list, and no value was read. This is the correct publication behavior, but credential handling still depends on the operator.

---

## 4. Architecture and request flows

### Components

| Component | Role |
|---|---|
| `src/server.mjs` | Express 5 HTTP server; discovery; free gate; paid routes; x402 middleware; static site; MCP metadata; health/readiness; shutdown. |
| `src/preflight.mjs` | Payment/transaction preflight validation, receipt HMAC, `/preflight/verify`. |
| `src/recovery.mjs` | Caller-key idempotency, staged/settled promotion, evidence hashes. |
| `src/measure.mjs` | Pinned-block quote collection and round-trip arb measurement. |
| `src/safety.mjs` | Contract facts, quote-based sellability, Dexscreener scam signals. |
| `src/depth.mjs` | USD-size ladder, impact, capacity. |
| `src/quotecheck.mjs` | Compare an offered quote with the configured venue book. |
| `src/config.mjs` | Chains, tokens, venues, RPC defaults/fallbacks, gas assumptions. |
| `mcp-bridge/` | `verify402-mcp` stdio MCP server and x402 payer. |
| `src/site/` | Static human pages (`/start`, `/checks`, `/live`, `/proof`, `/docs`, `/donate`, `/mcp`, `/preflight`). |
| `render.yaml` | Render Blueprint: free plan, Node runtime, testnet, `/health` health check. |

The server is one Node process with in-memory maps for recovery, usage counts, measurement cache, and the free `/findings` snapshot. There is no database, queue, background worker, or durable ledger in the server.

### Flow 1 — Free preflight

1. Client `POST /preflight` with `kind: "payment"` or `kind: "transaction"`.
2. `preflightRateLimit` enforces 60 requests/minute/IP; `preflightConcurrency` caps global in-flight requests at 8.
3. `paymentPreflight` or `transactionPreflight` normalizes the intent, reads chain state where applicable, and builds typed reasons.
4. `finish()` computes `verdict`, `sign_allowed`, `requires_ack`, `checked`, `notChecked`, `intent`, `intentHash`, block data, and an HMAC receipt.
5. If the chain cannot be read for an EVM intent, the route returns `503` and **no receipt**. The caller is expected to refuse to sign.
6. Client may call `POST /preflight/verify` with the receipt. That verifies spec, HMAC, and expiry only; see H-8.

The free gate deliberately has no CORS header; browser-based agents must call it server-side. **[V]**

### Flow 2 — Paid x402 call

1. Client calls a paid route with no payment.
2. Recovery middleware runs first. A settled `x-idempotency-key` replay returns the stored response without payment; a key reused with different body returns `409`; a weak key returns `400`.
3. `@x402/express` `paymentMiddleware` returns HTTP `402` with a `payment-required` header containing `x402Version`, `resource`, `accepts[]`, and Bazaar discovery data.
4. Client signs an exact-scheme authorization for the selected network/asset/amount/payee and retries with the payment proof (`PAYMENT-SIGNATURE` for x402 v2; `x-payment` is the legacy header).
5. Middleware verifies the payment, invokes the handler, and does not settle on any response `>= 400` (covered by `test/x402-settlement.test.mjs`).
6. Handler returns the verdict plus `evidence_bundle` (`requestHash`, `responseHash`, `pinnedBlock`, `mode`).
7. `recordSettlement` stages the response under the caller key; `onAfterSettle` promotes it only after a facilitator-confirmed success with a transaction reference.
8. On success the client receives the verdict with the settlement response; subsequent retries with the same key can replay within 10 minutes, up to 3 replays.

The staged/settled promotion is deliberately fail-closed: pending or failed settlement never creates a free replay. The weakness is that staged records are not visible for in-flight deduplication; see finding P1-2.

### Flow 3 — Free `/findings`

1. On process start, the server prewarms a snapshot of five Ethereum pairs (all configured non-USDC tokens) at `$100k` round trips.
2. `refreshFindings()` coalesces refreshes; pairs run at concurrency 2 with a 26-second per-pair budget.
3. A snapshot is served for 120 seconds; after that, stale-while-revalidate returns the old snapshot marked `stale: true` and refreshes behind it.
4. Results are cached per pair for 5 minutes. A failed pair becomes `unavailable`, not a fabricated verdict.
5. The route has no per-IP rate limit (L-3).

This is a trust-building showcase, not a general measurement endpoint. It is Ethereum-only and fixed-size.

### Flow 4 — MCP bridge

1. MCP client starts `npx -y verify402-mcp` over stdio.
2. With no `EVM_PRIVATE_KEY`, only `preflight_gate` is registered; nothing can be charged.
3. With a key, five paid tools are registered. Each paid operation creates one `crypto.randomUUID()` idempotency key.
4. `paid-call.mjs` retries transport/5xx failures with the same key; it never retries `402` or `409`.
5. The x402 client applies per-payment caps and USDC default-asset controls; `payment-policy.mjs` then requires an allowed EVM network, the configured payee, the configured server origin, and a known paid route.
6. Axios redirects are refused by the bridge.

The bridge is a payer, not the server. It does not sign trades and does not hold the server’s HMAC secret.

### Deployment topology

`render.yaml` defines one free Render web service:

- `plan: free`, `runtime: node`, `buildCommand: npm ci`, `startCommand: node src/server.mjs`, `healthCheckPath: /health`.
- `X402_MODE=testnet`, `FACILITATOR_URL=https://x402.org/facilitator`, `PREFLIGHT_SECRET` generated by Render.
- No persistent disk, database, queue, or second instance.

Live `/info` agrees that the instance is on a free host and state is process-local. **[V]**

---

## 5. Endpoint and tool inventory

### Free HTTP surfaces

| Method/path | Purpose | Limits / behavior |
|---|---|---|
| `POST /preflight` | Validate a payment or transaction before signing; return PASS/CAUTION/BLOCK + receipt. | 60/min/IP; global 8 in-flight; no CORS; 64 KB JSON body; 503 + no receipt on chain read failure. |
| `POST /preflight/verify` | Verify receipt HMAC and expiry. | 60/min/IP; no concurrency cap; no CORS. |
| `GET /findings` | Free Ethereum majors showcase. | Cached 120s; per-pair 26s budget; concurrency 2; **no rate limit** (L-3). |
| `GET /usage` | Anonymous process-local free-gate counters. | No auth; resets on restart; not a unique-agent count. |
| `GET /health` | Liveness only. | Does not read chain; returns mode, price, network label, `/ready`. |
| `GET /ready` | Deep readiness. | 3s chain read; `READY_CHAIN_ID` default 1; returns 503 on failure. |
| `GET /info` | Machine-readable service description. | Prices, recovery, preflight, MCP, hosting, state persistence. |
| `GET /openapi.json` | OpenAPI 3.1 contract. | Documents paid routes, x402, headers, error schemas. |
| `GET /llms.txt` | Agent-oriented plain text. | Discovery claims and commands. |
| `GET /robots.txt`, `GET /sitemap.xml` | Crawler discovery. | Static. |
| `GET /.well-known/verify402.json` | Canonical service manifest. | MCP version/tarball/registry URLs, prices, policies. |
| `GET /.well-known/x402` | x402 capability manifest. | Resource list and protocol metadata. |
| `GET /.well-known/agent-card.json` | A2A/agent identity card. | Canonical origin from `AGENT_URL` or trusted Host allowlist. |
| `GET /.well-known/agent-registration.json` | ERC-8004-style registration. | Same canonical-origin rule. |
| `GET /.well-known/402index-verify.txt` | Domain verification. | Static. |
| `GET /` | HTML landing page for browsers/crawlers; plain menu for machines. | Content negotiation. |
| `GET /start`, `/checks`, `/live`, `/proof`, `/docs`, `/donate`, `/mcp`, `/preflight` | Human pages. | Static; HTML `no-store`; assets cached 300s. |

### Paid HTTP surfaces

All paid routes are `POST`, require JSON, require `chainId`, return `402` without payment, and return `200` with an evidence bundle when paid. Prices are configured in `src/contract.mjs` and can be overridden by environment variables; the 402 challenge is authoritative.

| Route | Price | Required inputs | What it actually measures |
|---|---:|---|---|
| `/verify` | $0.05 | `chainId`, `target`; optional `base` (default USDC), `size` (default 100,000 base units), `minNet` (default 0) | Best buy quote and best sell quote at one pinned block; nets configured gas and 5 bps flash-loan premium; verdict `edge` / `no_edge` / `no_edge_costs_ate_it`. |
| `/safety` | $0.10 | `chainId`, `tokenAddress`; optional `intendedUsd` (default 500), `offeredPriceUsd`, `baseSymbol` | ERC-20 contract facts, quote-based sellability (USD-sized), Dexscreener signals, phantom-price check; verdict `TRUST` / `CAUTION` / `AVOID`. Not a transfer simulation or audit. |
| `/route` | $0.03 | `chainId`, `tokenIn`, `tokenOut`, `amountIn` (raw atomic units) | All configured venue quotes, direct and WETH-routed, at one pinned block; best first. |
| `/quotecheck` | $0.05 | `chainId`, `tokenIn`, `tokenOut`, `amountIn`, `quotedOut`; optional `venueClaimed` | Compares an external quote against the configured book; `fair` / `overpaying` / `too_good_to_be_true` / `unknown`. |
| `/depth` | $0.05 | `chainId`, `tokenAddress`; optional `baseSymbol`, `maxRoundTripPct` (default 1.0), `sizesUsd` | Up to six USD sizes (default 100/1,000/10,000/100,000; max 1,000,000), per-size impact and round-trip cost, capacity under tolerance. |

### MCP tools

| Tool | Type | Price | Notes |
|---|---|---:|---|
| `preflight_gate` | Free | $0 | Works with no wallet; returns the same gate result and receipt. |
| `verify_arbitrage` | Paid | $0.05 | EVM x402; calls `/verify`. |
| `check_token_safety` | Paid | $0.10 | EVM x402; calls `/safety`. |
| `get_best_route` | Paid | $0.03 | EVM x402; calls `/route`. |
| `verify_quote_fairness` | Paid | $0.05 | EVM x402; calls `/quotecheck`. |
| `get_trade_depth` | Paid | $0.05 | EVM x402; calls `/depth`. |

The bridge is EVM-only for paid calls. The server advertises a Solana rail, but the MCP bridge does not implement a Solana payer.

### Headers and error behavior

- Idempotency: `x-idempotency-key` (or `idempotency-key`) on the first paid call. UUID v4 or at least 32 URL-safe characters with 16 distinct characters; weak keys get `400 weak_idempotency_key`.
- Payment proof: x402 v2 `PAYMENT-SIGNATURE`; legacy `x-payment` is documented. The paid routes accept both through the installed middleware.
- Errors: stable codes (`missing_chain`, `invalid_chain`, `unsupported_chain`, `invalid_size`, `rpc_unavailable`, `weak_idempotency_key`, `recovery_conflict`, etc.), `requestId` in body and `x-request-id`, no provider detail in the public body.
- 503 means no verdict and no settlement; the settlement guard is tested with a real fake facilitator.
- Paid and preflight POST routes emit no `Access-Control-Allow-Origin`; only free read-only discovery GET/HEAD/OPTIONS allow any origin.

---

## 6. Mainnet / testnet audit

### Observed live state **[V]**

| Surface | Observation |
|---|---|
| `GET /health` | `200`, `mode: "testnet"`, `price: "$0.05"`, `networks: "Base Sepolia / Solana devnet"`. |
| `GET /ready` | `200`, `ready: true`, `mode: "testnet"`, `chainId: 1` (Ethereum mainnet), block around `26,242,730` at probe time, 143 ms. |
| `GET /info` | MCP version `1.0.3`; hosting free; `state_persistence.scope: "process-local"`; payment network `eip155:84532`; payee is the code default (address redacted here). |
| `GET /.well-known/verify402.json` | `version: "1.0.3"`; tarball `mcp-v1.0.3`; registry version `1.0.3`; six tools. |
| `GET /openapi.json` | `openapi: "3.1.0"`, `info.version: "1.0.3"`. |
| `GET /mcp` | Human page says `verify402-mcp v1.0.3`; tarball/pinned link 1.0.3. |
| `POST /verify` without payment | `402`; testnet Base Sepolia exact-scheme requirement, `50000` = $0.05, testnet USDC, `maxTimeoutSeconds: 300`; Bazaar extension present; no CORS header. |
| `POST /preflight` sample | `200 PASS`, `structural_only: true`, pinned block, `checked` includes scheme/network/asset/amount/payee/resource/block freshness, receipt returned. |
| `POST /preflight/verify` | `200 valid: true`, `verdict: PASS`, same block/intent hash. |
| Weak idempotency key on `/verify` | `400 weak_idempotency_key`, before payment. |

### The important distinction: testnet rail, mainnet truth

The live service charges **testnet USDC** but measures **Ethereum/Arbitrum/Base mainnet** state:

- Payment mode controls the x402 rail (`eip155:84532` / Solana devnet).
- `READY_CHAIN_ID` defaults to `1`, and `/findings` measures Ethereum mainnet.
- Paid route bodies use `chainId: 1`, `42161`, or `8453` for mainnet analysis.
- `evidence_bundle.mode` is the payment mode (`testnet`), not the measurement chain.

This is a legitimate demo design, but it is easy to misread. It must be stated explicitly: **testnet USDC buys mainnet analysis; it is not mainnet revenue.** The repo mostly says this in README and `DEPLOY_READINESS`, but three discovery documents contradict it.

### What the code enforces in mainnet mode **[V]**

`src/server.mjs` requires:

- `X402_MODE=mainnet` exactly; any other value falls back to testnet.
- `AGENT_URL` absolute http(s), no credentials/query/fragment; cannot be derived from `Host`.
- `PREFLIGHT_SECRET` non-empty.
- `MAINNET_ALWAYS_ON_CONFIRMED=yes` or `REQUIRE_ALWAYS_ON=1`.
- `FACILITATOR_URL` non-empty unless a CDP key is configured.
- `BYPASS_PAYMENT=1` is refused.
- `ALLOW_MAINNET_ON_FREE_TIER` set is refused.
- If `FACILITATOR_URL` points at the CDP endpoint, `CDP_API_KEY_ID` is required.

It does **not** enforce:

- That `PAY_TO_EVM` / `PAY_TO_SVM` are explicitly set; both have hard-coded defaults.
- That `FACILITATOR_URL` is actually a mainnet-capable facilitator (the testnet `x402.org` URL is not rejected in mainnet mode).
- That the host is actually always-on. `MAINNET_ALWAYS_ON_CONFIRMED` is a self-assertion, not platform detection.
- That the payee is controlled by the operator or distinct from the project’s default.
- That the mainnet facilitator supports the chosen network/asset combination before going live.

These are checklist assumptions, not technical guarantees.

### Mainnet readiness gaps

| Requirement | Status |
|---|---|
| Always-on paid host | **Missing.** `render.yaml` is free; mainnet requires a paid instance per `MAINNET_SWITCH_CHECKLIST.md`. |
| Mainnet facilitator | **Not verified.** The code supports PayAI/CDP, but no mainnet facilitator is configured on live; no mainnet settlement exists. |
| Explicit mainnet payees | **Not enforced.** Defaults exist; docs call them required. |
| Real mainnet payment | **None.** Only Base Sepolia `$0.03` proof. |
| Durable paid-state/replay | **Missing.** Process-local only. |
| Mainnet monitoring/rollback | **Documented only**, not evidenced by a live mainnet run. |
| Production legal/support | **Missing.** No ToS/privacy/refund/SLA found. |

### Smallest mainnet switch, concretely

1. Move the service to an always-on paid Render instance (or equivalent).
2. Set `X402_MODE=mainnet`, a canonical `AGENT_URL`, a strong `PREFLIGHT_SECRET`, `MAINNET_ALWAYS_ON_CONFIRMED=yes`, and a real mainnet facilitator (`FACILITATOR_URL` or CDP).
3. Set explicit `PAY_TO_EVM` and `PAY_TO_SVM`; do not rely on defaults.
4. Keep `BYPASS_PAYMENT` and `ALLOW_MAINNET_ON_FREE_TIER` unset.
5. Confirm `/health` says mainnet, `/ready` reads the intended chain, and the 402 challenge shows `eip155:8453` / Solana mainnet with the expected payee and atomic amount.
6. Make one small real mainnet payment; verify the `PAYMENT-RESPONSE` transaction on-chain and the payee balance delta.
7. Repeat the same call with a fresh `x-idempotency-key` to verify replay, then restart the service and repeat to expose the process-local gap.
8. Add an external `/ready` monitor; decide whether `/health` or `/ready` drives platform restarts.

Do not call the service “mainnet” until step 6 succeeds. A 402 challenge is not a settlement.

---

## 7. x402 implementation

### Protocol and packages **[V]**

- x402 v2, exact scheme.
- Root service pins `@x402/core`, `@x402/evm`, `@x402/express`, `@x402/extensions`, `@x402/svm` to exactly `2.28.0`.
- `@coinbase/cdp-sdk` is `^1.59.0` for the optional CDP facilitator path.
- The MCP bridge pins `@x402/axios` and `@x402/evm` to `2.28.0`.
- The facilitator client is `createCdpFacilitatorClient()` when mainnet + `CDP_API_KEY_ID`, otherwise `HTTPFacilitatorClient({ url: FACILITATOR_URL })`.
- Live testnet uses the public x402.org facilitator by repository configuration; the exact live facilitator URL is not exposed by the HTTP surface.

### Challenge and settlement

- The live `/verify` challenge has `x402Version: 2`, a resource URL, two exact-scheme accepts (EVM and Solana in code), and a Bazaar extension.
- The observed EVM requirement was Base Sepolia, testnet USDC, `50000` atomic units ($0.05 at 6 decimals), `maxTimeoutSeconds: 300`.
- The `payment-required` header is the authoritative challenge; client code should decode that, not assume a price from docs.
- `onAfterSettle` promotes recovery only when `ctx.result.success === true`, a transaction reference exists, the response body names exactly one staged `operationId`, and the projected response hash matches.
- `test/x402-settlement.test.mjs` proves a `503` response does not call `settle`, while a `200` control does. It does not prove live facilitator delivery or mainnet success.

### Idempotency and recovery

- `lookupRecovery` runs before the paywall.
- The caller key is the only credential; payer headers are untrusted.
- The key is bound to the canonical request body; changing the body returns `409`.
- TTL is 10 minutes, max 3 replays, max 1,000 keys.
- A staged record is not replayable until settlement is confirmed; failed/pending settlement promotes nothing.
- A replay returns the same payload with `recovery.replayed` and the replay count.
- If the key is leaked, the holder can replay until TTL/cap; there is no revocation.
- Recovery state is process-local and lost on restart/deploy.

**New concurrent-duplicate gap (not in the audit’s open list):** `lookupRecovery` returns `null` for a staged (in-flight) entry, so two concurrent requests with the same key can both reach the handler and pay. `recordSettlement` overwrites the map entry; the first response’s `operationId` may no longer be present when its `onAfterSettle` runs, so its settlement may not be promotable. The same-payer retry can therefore be charged twice while only the second operation becomes replayable. This is distinct from the documented “lost response after settlement” case. The bridge retries on timeout with the same key, so a slow paid call can trigger it. There is no test for concurrent same-key requests.

### Client-side payment policy

`mcp-bridge/payment-policy.mjs` is a strong design:

- Default allowed network: `eip155:8453` (Base mainnet).
- Default payee: the project’s configured EVM payee.
- Default resource prefix: the configured verify402 server.
- Rejects 402s with no allowed network/payee, a different resource origin/path, or a requirement that changes after selection.
- `MAX_PAYMENT_USD` is enforced before signing.
- `MAX_DAILY_USD` is optional and uses a local ledger; an attempted charge is recorded before payment, so failures can over-count (conservative, documented in code comments).
- Axios redirects are refused by the bridge.

**But the default network does not match the live service.** The live challenge offers `eip155:84532`; the bridge defaults to `eip155:8453`. A local policy check against the live accepts list produced:

> `402 offered no payment on an allowed network/payee (allowed networks: eip155:8453; payee: ...)`

The documented paid MCP configuration in `mcp-bridge/README.md` sets `VERIFY402_NETWORKS=eip155:8453` and tells the user to fund Base mainnet. That configuration cannot pay the current live service. A user must set `VERIFY402_NETWORKS=eip155:84532` for the demo and use testnet USDC, or the operator must deploy mainnet.

### The non-MCP example is weaker

`mcp-bridge/first-payment.mjs` is a useful manual test, but it is not the safe bridge:

- It registers `eip155:*`, so it will pay any EVM chain the server requests.
- It does not enforce the verify402 payee or a known resource beyond the configured server URL.
- It does not set `maxRedirects: 0`.
- It relies on a $0.25 cap only.

It is an example, not part of the npm package’s runtime, but the README points Node users to it. Do not present it as the production payer pattern; use `payment-policy.mjs` or add equivalent checks.

### Solana

- The server registers `ExactSvmScheme` and advertises Solana mainnet/devnet.
- The MCP bridge only registers an EVM scheme and its policy parser only accepts `eip155:<chainId>`.
- The live challenge is Base Sepolia. The Solana rail is implemented server-side but not exercised by this review.

---

## 8. Receipt and preflight security

### What the gate checks

**Payment intent:** scheme (`exact` expected), network support, asset/canonical USDC, positive atomic amount, payee format/burn addresses/optional allowlist, resource URL/optional expected resource, timeout, authorization window, facilitator URL/optional allowlist, optional payer address/balance, EVM block freshness. Solana payment checks are structural only (no slot binding or balance).

**Transaction intent:** integer `chainId` (no Ethereum default), recipient/format/optional allowlist, value, calldata/decoding, contract code, ERC-20 metadata for transfer/approve/transferFrom, `eth_call` simulation if `from` is supplied, block freshness. No state overrides, no balance-delta simulation, no MEV/transfer-tax/blacklist/pause checks.

The response is intentionally three-state:

- `PASS` — every check in `checked` passed at this block.
- `CAUTION` — at least one decision is needed; `requires_ack: true`.
- `BLOCK` — at least one hard check failed; `sign_allowed: false`.

The `checked` / `notChecked` lists are the product’s honesty contract. They are present on both free and paid responses. Keep them.

### Fail-closed behavior

- If the EVM chain cannot be read, `/preflight` returns `503` and no receipt. This is tested and explicit in `/info`, OpenAPI, and docs.
- `/preflight/verify` returns `invalid` for bad spec, bad signature, bad expiry, or expiry.
- Paid routes return `503` on transport/decode failure instead of a guessed verdict.
- The x402 settlement guard prevents a `503` from settling. This is a strong property.

### Receipt construction **[V]**

`makeReceipt()` signs a canonical payload with HMAC-SHA256 using `PREFLIGHT_SECRET` (or an ephemeral per-process secret if the env var is absent). It includes:

- `spec: verify402/preflight-receipt@1`
- `id`, `kind`, `verdict`, `intentHash`
- `blockNumber`, `blockHash`
- `issuedAt`, `expiresAt`, `ttlSeconds`
- `checked`, `notChecked`
- `algorithm: "hmac-sha256"`

Default TTL is 90 seconds; maximum is 300. Live `/info` says receipts use `PREFLIGHT_SECRET`, so the live secret is configured and stable across restarts; the value was not read. Mainnet refuses startup without it.

### H-8 — the receipt is not bound to the caller’s local intent

`verifyReceipt()` checks the spec, HMAC (timing-safe), and expiry, then returns the receipt’s `intentHash` and block. It does not accept the caller’s intent or recompute the hash.

`examples/preflight-guard.mjs` compares:

```js
checked.intentHash === pre.intentHash
```

Both values came from the gate response. That proves the gate is internally consistent, not that the receipt corresponds to the exact transaction the caller is about to sign. An executor cannot independently prove binding without reimplementing the canonicalization. This is the remaining high finding in `AUDIT.md`.

Recommended fix: keep the existing `{ receipt }` form for compatibility, add an optional `{ receipt, intent }` form, recompute `sha256(canonicalStable(intent))` and compare, export a canonicalization helper, and test swapped-intent and tampered-receipt cases. This is a Phase 1 API addition and Phase 6 hardening item.

### `structural_only` can be cleared by an unverified proof

The gate sets `structural_only: true` when:

- no payer `from` is supplied;
- no proof/signature is supplied;
- the EVM rail is testnet (no block binding/balance);
- the rail is Solana (no slot binding/balance).

If a mainnet payment has a `from` and any non-null `proof`/`payload`/`signature`, `structural_only` is `false`, even though the gate does not verify the proof. `test/preflight.test.mjs` uses the literal string `"0xsigned"` and expects `structural_only: false`. The `notChecked` list still says “payment signature / signed payload” and “facilitator settlement,” so the data is technically honest, but the flag name can mislead an operator who reads only `structural_only`.

Recommended fix: either verify the signed payload, or rename/document the flag as “inputs present” and make the summary say “proof supplied, not verified.” Do not let a dummy string look like verification.

### Payee allowlisting is optional

`payee` is checked for format and burn addresses. `policy.allowedPayTo` is enforced only when the caller supplies it. Without a policy, a structurally valid payment to an arbitrary attacker address can return `PASS` (with `structural_only` as applicable). This is consistent with “PASS is not safe,” but the docs and MCP tool should make “pass `allowedPayTo`” the default recommendation for any real signer. The live sample I sent used a fake non-burn payee and returned `PASS` because no allowlist was supplied; that is expected behavior, not a vulnerability in the gate’s stated contract.

### Rate limiting and abuse

- `/preflight` is 60/min/IP with a global 8 in-flight cap.
- Buckets are in-memory and per-process; `trust proxy=1` assumes the Render proxy chain.
- An attacker with many IPs can exhaust the global 8 slots; a single process can be blocked for all users.
- `/findings` has no per-IP limit and can trigger RPC work.
- `/preflight/verify` has the per-IP bucket but no concurrency cap.
- These are M-2 and L-3; they are operational risks, not cryptographic failures.

### Headers, CORS, Host, and logs

- Security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a CSP, and no `x-powered-by`.
- CORS: free discovery GET/HEAD/OPTIONS allow any origin; paid and preflight POSTs do not. This is intentional and tested.
- Host: mainnet requires `AGENT_URL`; testnet uses a trusted-host allowlist and rejects untrusted Host with `400 untrusted_host`; forged-Host tests exist.
- Logs: redaction of payment/authorization/idempotency headers and secret-like patterns; tested.
- Missing hardening: no `Strict-Transport-Security` and no `Permissions-Policy` header were observed. Low severity behind Render’s HTTPS, but worth adding.

---

## 9. Verification-engine correctness

### Engine summary

| Route | Method | What is measured | What is not |
|---|---|---|---|
| `/verify` | `measureRoundTrip` | Best buy on configured venues, exact sell of the bought amount, gas at pinned block, 5 bps flash premium, net bps. | Execution success, MEV, bridge/CEX liquidity, unconfigured venues, state changes, future blocks. |
| `/route` | `quoteAllVenues` | Direct and WETH-routed quotes at one block, best first. | Split routes, aggregators, unconfigured DEXs, execution. |
| `/quotecheck` | `quotecheck` | External quote vs configured book, ratio/shortfall. | Whether the claimed venue is real outside the configured book; execution. |
| `/safety` | `tokenFacts` + `sellabilityProbe` + `scamSignals` | Contract metadata, quote-based USD-sized sellability, market signals, phantom price. | Transfer execution, tax, blacklist, pause, max-tx, holder concentration, audit, sanctions. |
| `/depth` | `depthProfile` | Up to six sizes; buy/sell quotes; impact, round-trip cost, capacity under tolerance; real decimals. | Execution, MEV, unconfigured venues, full order book. |

### Strengths

- **Pinned block:** both legs use the same block; `evidence_bundle.pinnedBlock` is canonical. This was a Hotfix 2 fix (H-2) and is covered by `test/pinned-block.test.mjs`.
- **No locally invented venue math:** V3 uses QuoterV2; V2 uses `getAmountsOut`; routed quotes use the router’s own path math. This is the right architecture for a truth service.
- **Typed failure boundary:** `ok` / `no_pool` / `revert` / `transport` / `decode`; hard transport/decode failures become 503, not “no edge.” This prevents provider failures from becoming market facts.
- **Precision:** bps math uses `1_000_000n` for two decimals; the regression that rendered −292 USDC as −0.29 bps is covered. **V**
- **Gas and premium:** gas units 320,000 and 5 bps flash premium are deliberately conservative and disclosed. **V**
- **Decimals:** `/depth` uses the token’s real on-chain decimals; 6- and 8-decimal tests exist. **V**
- **Determinism:** identical request at same pinned block should produce the same measurement; tested.
- **Honesty:** `notChecked` is comprehensive and route-specific; “no profit promise” and “PASS is not safe” are repeated.

### Coverage and limits

- Ethereum: Uniswap V3 fee tiers 100/500/3000/10000; Uniswap V2 and Sushi V2; tokens USDC/WETH/WBTC/DAI/USDT.
- Arbitrum: same V3 fee tiers and V2 routers; tokens USDC/WETH/WBTC/USDT/ARB.
- Base: V3 fee tiers only; no configured V2 router; tokens USDC/WETH/cbBTC/DAI. Aerodrome, Uniswap V4, PancakeSwap and other Base-native venues are **not** included.
- No aggregator, bridge, CEX, or split-route execution.
- No balance-delta simulation; no execution guarantee.
- `/safety` can say `TRUST` when no configured venue is dangerous by its quote/signals, but it is not a honeypot proof. This is explicitly documented.
- Dexscreener is external context; missing data is noted, not fabricated.

### RPC dependency

- RPC clients use one configured URL with 15s timeout and two retries, or fall back across public endpoints with 5s timeouts.
- A public RPC can throttle a cloud egress IP; a single slow endpoint can consume the pair budget.
- `findings` caps pairs at 2 concurrent and 26s each, but paid routes can still make many sequential quote calls.
- There is no global RPC budget/circuit breaker across routes.

The engine is credible for “what configured venues quoted at this block.” It is not an execution simulator, and it does not claim to be.

---

## 10. Render free-tier reliability

### What the repo and live service say

- Render Blueprint uses `plan: free`, one web service, no disk, no database, no queue.
- Free instances “spin down after about 15 minutes idle, can take about a minute to wake, can restart at any time, and have an ephemeral filesystem” (`DEPLOY_READINESS.md`). Live `/info` says `freeTier: true`, `coldStartSeconds: 60`.
- The live service was warm during this review; post-deploy wake was 822 ms. Cold start was not measured.

### Reliability consequences

| Property | Consequence |
|---|---|
| Sleep after idle | First request can take ~1 minute; an agent may time out before the 402/preflight response. |
| Single process | Recovery, `/usage`, cache, and `/findings` snapshot are lost on restart/deploy; no cross-instance state. |
| Ephemeral filesystem | No durable server-side replay or settlement ledger. |
| `/health` as Render health check | A process that cannot reach any RPC still looks healthy; `/ready` is not wired to traffic or restarts. |
| Public RPCs | Rate limits and provider behavior become user-visible latency/503s. |
| 8 global preflight slots | One burst can block all free-gate users; no per-IP fairness beyond the 60/min bucket. |
| `findings` refresh in web process | Cold start spends boot time measuring; a refresh burst competes with paid/free traffic. |
| No always-on guarantee | Mainnet forbidden by the project’s own rule; commercial paid use needs a paid plan. |

### Observed versus documented

- Verified: live free routes return quickly when warm; paid routes return 402; `/findings` returns a snapshot; post-deploy 22/22.
- Not verified: actual cold start, behavior under 8 concurrent RPC-heavy preflights, behavior during a deploy/restart mid-payment, Render platform limits, RPC provider rate-limit thresholds.
- Because recovery is process-local, a restart between settlement and retry can cause a second charge. That is not a theoretical edge case for a paid mainnet service; it is a standard deploy event.

---

## 11. Test evidence

### Counts **[V]**

`npm run test:counts` reports:

- **206 declared tests** across 24 files.
- **194 offline**, **12 RPC-required**.
- **205 exercised by configured scripts**; `test/post-deploy.test.mjs` (1 test) is not wired into `npm test`.

### Last full run

- `npm test` on 2026-10-21 exited `0`.
- All 12 RPC tests ran; intentional fetch-failure logs did not fail the suite.
- This is a prior run in the review, not repeated line-by-line while writing this report.

### Live post-deploy

`SMOKE_BASE_URL=https://verify402.onrender.com npm run post-deploy` passed **22/22** checks:

- wake service;
- 10 smoke checks (including known-bad preflight BLOCK, missing chain 400, weak idempotency key 400, paid route 402, no CORS wildcard, agent card canonical host);
- `/info`, `/openapi.json`, `/.well-known/verify402.json`, `/.well-known/x402`, `/llms.txt` fetch;
- banned-phrase scan on all five documents;
- security headers on all five;
- prices agree `/info` vs manifest vs OpenAPI;
- x402 resource list;
- idempotency TTL and preflight limits agree.

This proves the live service is internally consistent **for the 1.0.3 contract**. It does not prove version 1.0.4 correctness, mainnet settlement, or paid delivery.

### Standalone post-deploy test fails

`node test/post-deploy.test.mjs` exits `1`:

- Its mock server’s `smoke` fixture lacks five current checks:
  - `/preflight` known-bad payload returns BLOCK;
  - missing `chainId` returns `400 missing_chain`;
  - weak key on paid route returns `400`;
  - paid route 402 has no CORS wildcard;
  - agent card canonical host.
- Its `/llms.txt` mock lacks `nosniff`.
- Result: `0/1` tests pass; post-deploy reports `20/22`.

This is a **test-fixture drift**, not a live failure. It means CI does not protect the post-deploy contract. The live checker passes because the real service has the new behavior.

### Coverage highlights

- `test/preflight.test.mjs` (33): receipt/HMAC, PASS/CAUTION/BLOCK, payment/transaction, block freshness, malformed inputs, H-8-adjacent shape.
- `test/recovery.test.mjs` (28): staged not replayable, promotion, TTL, replay cap, key entropy, request binding, evidence hashes.
- `test/http.test.mjs` (24): routes, CORS, headers, 402, malformed inputs, weak key, Host spoofing, limits.
- `test/preflight-guard.test.mjs` (8): reference executor ordering.
- `test/measure.test.mjs` (5 RPC): venues exist, QuoterV2 vs V2, no invented profit, monotonicity, determinism.
- `test/x402-settlement.test.mjs` (2): real middleware/fake facilitator; 503 no settle, 200 settle.
- `test/payment-policy.test.mjs` (12), `test/paid-call.test.mjs` (7): network/payee/resource allowlists, retry/idempotency.
- `test/offline-mode.test.mjs`, `test/pinned-block.test.mjs`, `test/depth-decimals.test.mjs`, `test/measure-typed.test.mjs`, `test/safety.test.mjs`, `test/honesty.test.mjs`, `test/usage.test.mjs`, `test/shutdown.test.mjs`, `test/claims.test.mjs`, `test/log-redaction.test.mjs`, `test/quotecheck.test.mjs`, `test/depth.test.mjs`.

### Test gaps

- No live paid test in this review; no mainnet settlement test.
- No concurrent same-key idempotency test.
- No restart-between-settlement-and-retry test.
- No cold-start timing test.
- No multi-instance recovery test.
- No mainnet payee/facilitator misconfiguration test.
- No version-consistency test across manifest/OpenAPI/site/package/GitHub/registry.
- No test that the documented MCP default network can pay the current live challenge.
- No test that README’s `payment` header instruction works as written.
- RPC tests depend on public providers; they are not hermetic and can be flaky.

---

## 12. Release and distribution

### Version matrix **[V]**

| Surface | Version / state | Evidence |
|---|---|---|
| Local repo HEAD | `248923f`; 2 ahead of origin; clean | `git status`, `git log` |
| Local MCP package | `1.0.4` | `mcp-bridge/package.json` |
| npm `latest` | `1.0.4` | npm registry |
| npm `1.0.4` tarball | published; core files byte-match local `mcp-bridge` | downloaded tarball; SHA-256 compare |
| npm `gitHead` | `248923f...`; **not public** | npm metadata; GitHub commit page 404 |
| GitHub tag `mcp-v1.0.4` | absent | tag list; release URL 404 |
| GitHub release tarball `1.0.4` | **404** | `releases/download/mcp-v1.0.4/...` |
| GitHub release `mcp-v1.0.3` | exists; tarball 302 to asset | release check |
| MCP Registry `1.0.4` | **404** | registry API |
| MCP Registry `1.0.3` | active (200) | registry API |
| Live service | `1.0.3` strings; testnet | `/info`, `/openapi.json`, manifest, `/mcp` |
| `src/manifest.mjs` | `version: 1.0.3`, but tarball/registry URLs `1.0.4` | source |
| `src/openapi.mjs` | `info.version: 1.0.3` | source |
| `src/server.mjs` `/info` | MCP version `1.0.3` | source |
| `src/site/mcp.html` | says `v1.0.4` and links `mcp-v1.0.4` | source |
| `mcp-bridge/package-lock.json` | root version `1.0.3` | source |
| `server.json` | `1.0.4` | source |
| `DEPLOY_READINESS.md` | says 197 tests; tells operator to publish 1.0.4 after approval | stale |

### What the package match does and does not prove

**Proves:** the npm `1.0.4` tarball contains 10 files; `index.mjs`, `paid-call.mjs`, `payment-policy.mjs`, `budget.mjs`, `log.mjs`, and `README.md` are byte-identical to local `mcp-bridge` at `248923f`. The tarball does not include a `.env` or tests.

**Does not prove:** the package can be rebuilt from the public repo. Its `gitHead` is an unpushed commit. The GitHub release/registry/live service are older. The npm package is only the MCP bridge, not the server.

### Broken distribution links

The following repository text points at a `1.0.4` tarball that returns 404:

- `README.md` (pinned fallback command)
- `mcp-bridge/llms-install.md`
- `examples/ONBOARDING.md`
- `src/site/mcp.html` (if deployed)
- `src/manifest.mjs` (machine-readable tarball URL)
- `src/manifest.mjs` registry URL (1.0.4 version does not exist)

`README.md`, `mcp-bridge/llms-install.md`, and `examples/ONBOARDING.md` are user-facing. A user following the fallback path gets a 404 instead of an install.

### Release conclusion

The safest immediate state is **not** “publish more.” It is:

1. Decide whether `1.0.4` is the release or revert the version prep.
2. If `1.0.4` is the release, push `248923f`, create `mcp-v1.0.4`, attach the tarball, publish the MCP Registry `1.0.4`, update all manifests/links/version strings, and deploy the same commit.
3. If `1.0.4` is not ready, stop advertising it and restore a single `1.0.3` source of truth.
4. Add a version-consistency test that fails when npm/GitHub/registry/live/manifest disagree.

No new npm publication should occur without explicit approval.

---

## 13. Documentation review

### What is good

The project’s documentation is substantially better than typical crypto/agent projects:

- `README.md` repeatedly says a `PASS` is not a guarantee, `no_edge` is normal, and the paid checks are not execution or safety guarantees.
- `AUDIT.md` records original findings, Hotfix 2, what remains open, and a phased plan. It is candid about process-local state and the H-8 binding gap.
- `DEPLOY_READINESS.md` and `MAINNET_SWITCH_CHECKLIST.md` correctly say testnet only on free, mainnet needs always-on, and mainnet needs a real facilitator.
- Machine-readable `/info`, OpenAPI, manifest, and `/llms.txt` mostly agree on prices, TTLs, limits, and headers; the live post-deploy check verifies this.
- `SUPPORT.md` is unusually honest about no funding and no external payment.

That honesty is the commercial asset. It should not be undermined by stale “mainnet” claims.

### Contradictions and drift

| Issue | Evidence | Impact |
|---|---|---|
| Three docs claim live mainnet | `docs/production-discovery-verification.md:6`, `docs/x402-discovery.md:6`, `docs/discovery-audit.md:5` say mainnet / Base mainnet; live `/health` says testnet. | A reviewer or buyer is told the opposite of the live payment rail. |
| `docs/production-discovery-verification.md` reports `/health` mainnet | It claims a mainnet payload; current `/health` is testnet. | The verification report is stale and should be marked historical or corrected. |
| README paid setup is mainnet | `README.md` and `mcp-bridge/README.md` tell users to fund Base mainnet and set `eip155:8453`; live offers `eip155:84532`. | Default paid MCP setup cannot pay the live demo. |
| README step 6 uses `payment` header | `README.md:504` says “Re-send … with the `payment` header”; the actual x402 v2 header is `PAYMENT-SIGNATURE` (legacy `x-payment`). | A developer following the README will not pay correctly. |
| README mainnet command is incomplete | `README.md:192` omits `PREFLIGHT_SECRET` and `MAINNET_ALWAYS_ON_CONFIRMED`; mainnet startup refuses without them. | The documented command fails closed. |
| OpenAPI `/verify` default size is 1000 | `src/openapi.mjs:699` says default 1000; `src/config.mjs` `DEFAULT_SIZE` is 100,000 and the handler uses it. | Machine clients get a different default than the implementation. |
| OpenAPI server description says mainnet | `src/openapi.mjs` servers description says Base mainnet/Solana mainnet; live is testnet. | Discovery consumers misread the deployment. |
| `DEPLOY_READINESS.md` says 197 tests | Current count is 206; it also says publish 1.0.4 after approval, but 1.0.4 is already published. | Stale operational guidance. |
| MCP registry/version claims | README says “MCP Registry active” (true for 1.0.3, not 1.0.4); `src/manifest` mixes 1.0.3 version with 1.0.4 URLs. | Users cannot tell which artifact is current. |
| `src/site/mcp.html` says 1.0.4 | Local page links `mcp-v1.0.4`, which 404s. | Deploying local HEAD would publish broken links. |
| `mcp-bridge/package-lock.json` root 1.0.3 | Package is 1.0.4. `npm ci` still works, but reproducibility metadata is inconsistent. | Low, but should be regenerated. |

### Documentation recommendation

- Mark `docs/production-discovery-verification.md`, `docs/x402-discovery.md`, and `docs/discovery-audit.md` as **historical/testnet** unless and until a mainnet deployment is verified.
- Put one explicit banner on `/mcp`, README, and MCP README: **“The public demo charges testnet USDC and measures mainnet chains. It is not a mainnet payment service.”**
- Make the paid MCP quickstart match the live rail, or hide paid tools on the demo until mainnet is ready.
- Fix the `payment` header, the `/verify` default, and the mainnet command.
- Add version and mode consistency tests to CI so these cannot drift silently.

---

## 14. Commercial readiness

### Current commercial state

| Dimension | Assessment |
|---|---|
| Live product | A credible testnet demo with a free gate and five paid routes. |
| Real revenue | **None verified.** The only settlement proof is the operator’s Base Sepolia `$0.03` transaction. |
| External customers | **None recorded.** `SUPPORT.md` says no funding and no first external payment. |
| Mainnet payments | **None verified.** No mainnet facilitator or paid mainnet call. |
| Distribution | npm `1.0.4`, stale GitHub/registry/live `1.0.3`; broken `1.0.4` fallback links. |
| Support | A contact exists in OpenAPI, but no SLA, status page, or support process is evident. |
| Legal | Apache-2.0 license; no ToS, privacy policy, refund policy, or risk disclosure beyond “not financial advice.” |
| Reliability | Free host, process-local state, no durable replay, no multi-instance. |
| Security assurance | Internal audit + strong tests; no third-party audit report; H-8 open. |
| Market validation | **No statistics in the repository.** I did not invent any. |

### The funnel is sensible

The product architecture is coherent:

1. Free `/preflight` lowers adoption friction and creates a habitual pre-signing check.
2. `/findings` provides a free, reproducible showcase and establishes the `no_edge` baseline.
3. The five paid routes answer distinct decisions: arb reality, token safety, route, quote fairness, size/capacity.
4. MCP exposes the same tools to agent clients; x402 removes account/billing friction.

The free gate is the right front door. The paid depth is technically substantive. That is a better product story than most “AI crypto” services.

### But the commercial blockers are front-loaded

1. **The default paid MCP setup cannot pay the live service.** This is the most immediate revenue blocker.
2. **The public demo uses testnet money.** No real revenue is possible until mainnet.
3. **No durable recovery.** A paid user who loses a response across a restart may pay twice; no refund path.
4. **Release drift.** A user cannot be sure whether npm, GitHub, the registry, or the live service is “the product.”
5. **No mainnet operations.** Facilitator, payees, always-on host, monitoring, rollback are unproven.
6. **No legal/support envelope.** Per-call crypto payments with no terms/refund/SLA are hard to sell to businesses.
7. **No demand evidence.** There is no customer, usage, or revenue data to support a commercial claim.

### Illustrative unit economics only

Prices are $0.03–$0.10 per call. At a hypothetical $7/month always-on host, hosting break-even would be roughly:

- 70 `/safety` calls/month at $0.10;
- 140 `/verify`, `/quotecheck`, or `/depth` calls/month at $0.05;
- 234 `/route` calls/month at $0.03.

This is arithmetic, not a forecast, and excludes RPC, facilitator, support, and free-gate costs. There is no evidence of demand at any of these volumes. Do not present it as market validation.

### Commercial verdict

**Not commercially ready.** It is a technically interesting, honest testnet demo that could become a paid product after release reconciliation, mainnet operations, durable recovery, and a support/legal envelope. The fastest way to damage it is to claim mainnet or customer traction before those exist.

---

## 15. Prioritized findings

Severity reflects impact on security, mainnet readiness, and commercial use. “Open” means unresolved in this review; some are operational rather than code defects.

| ID | Severity | Finding | Evidence | Why it matters | Recommended action |
|---|---|---|---|---|---|
| **P0-1** | Critical (release) | Release surfaces split across 1.0.3/1.0.4; `1.0.4` GitHub/release/registry artifacts missing; links 404; npm `gitHead` not public. | npm 1.0.4; GitHub/MCP/live 1.0.3; `mcp-v1.0.4` 404; npm gitHead `248923f` GitHub 404. | Users cannot reliably install, audit, or reproduce the release; deploying local HEAD would publish broken URLs. | Pick one version; push commit; tag/release/registry/publish consistently; update manifest/OpenAPI/site; add version-consistency CI. |
| **P0-2** | Critical (functional) | Live testnet rail vs mainnet MCP default; documented paid setup cannot pay live. | Live 402 `eip155:84532`; `DEFAULT_NETWORKS=["eip155:8453"]`; policy filter error; README tells users to fund Base mainnet. | Paid tools fail for the default user; no testnet-to-paid conversion. | Either point demo MCP defaults/docs at `eip155:84532`, or deploy mainnet and update all docs; add a live-network assertion. |
| **P0-3** | Critical (mainnet) | No verified mainnet settlement, facilitator, or always-on host. | Live testnet; `render.yaml` free; only Base Sepolia proof; no mainnet tx. | Cannot claim mainnet or real revenue. | Paid always-on host; real facilitator; explicit payees; one small mainnet payment; verify on-chain; then update claims. |
| **P1-1** | High (security) | H-8: receipt verification not bound to caller’s local intent. | `verifyReceipt` HMAC/expiry only; guard compares two server-provided hashes. | An executor cannot independently prove the receipt matches the transaction it is about to sign. | Add `{receipt,intent}` verification; export canonicalization; keep old form; tests. |
| **P1-2** | High (paid reliability) | Recovery is process-local; concurrent same-key requests are not reserved; restart can lose settled replay. | In-memory `settled` map; `lookupRecovery` ignores staged; `recordSettlement` overwrites; docs admit restart loss. | Paid retry can be charged twice; a deploy after settlement loses replay; mainnet commercial risk. | Add per-key in-flight lock/409; durable store for settled records; restart/duplicate tests. |
| **P1-3** | High (trust) | Three docs claim production mainnet; live is testnet. | `docs/production-discovery-verification.md`, `docs/x402-discovery.md`, `docs/discovery-audit.md` vs `/health`. | Buyers/reviewers are misled about the payment rail. | Mark historical or correct to testnet; add a deployment-mode banner/test. |
| **P1-4** | High (mainnet config) | Mainnet guard does not enforce explicit payees or a mainnet-capable facilitator; always-on is self-asserted. | `PAY_TO_*` defaults; `FACILITATOR_URL` only non-empty; `MAINNET_ALWAYS_ON_CONFIRMED` is an env string. | A fork/operator could route funds to the default payee or point at the testnet facilitator; free host could assert its way into mainnet. | Require explicit non-default `PAY_TO_*`; validate facilitator network; add a real always-on check/monitor; test startup refusals. |
| **P2-1** | Medium (honesty) | `structural_only` is cleared by a non-null but unverified proof. | `test/preflight.test.mjs` uses `"0xsigned"` and expects `false`; code never verifies proof. | An operator reading only the flag may think the proof was checked; `notChecked` still says it was not. | Verify proof or rename/document as “proof supplied, not verified”; update summary. |
| **P2-2** | Medium (abuse) | M-2/L-3: per-process preflight limits; global 8 in-flight; `/findings` has no rate limit. | `preflightBuckets` map; `PREFLIGHT_MAX_IN_FLIGHT`; `/findings` route. | One burst can exhaust the free gate; `/findings` can consume RPC quota. | Shared/global budget; per-IP discovery bucket; private RPC/circuit breaker. |
| **P2-3** | Medium (ops) | Render health check is `/health`, not `/ready`; a chain-broken process stays “healthy.” | `render.yaml`; `/health` no chain read; `/ready` deep check. | Traffic can be routed to an instance that cannot serve paid measurements. | Add external `/ready` monitor; decide restart policy; document `READY_CHAIN_ID` intent. |
| **P2-4** | Medium (CI) | Post-deploy test is unwired and its mock fails; live checker does not assert version/mainnet mode. | `npm test` excludes `test/post-deploy.test.mjs`; standalone exits 1; live 22/22 at 1.0.3. | Release/document drift can pass CI. | Fix fixture; add post-deploy/version/mode checks to CI; run live post-deploy on deploy. |
| **P2-5** | Medium (docs) | README/OpenAPI drift: `payment` header, incomplete mainnet command, `/verify` default 1000 vs 100000, server says mainnet, stale test counts. | Source lines; live behavior. | Onboarding and machine clients get wrong defaults/instructions. | Correct docs and add contract tests for defaults/mode/header names. |
| **P3-1** | Low (hardening) | No HSTS or Permissions-Policy; no ToS/privacy/refund/SLA. | Header probe; repository search. | Lower browser hardening; weak commercial/legal envelope. | Add headers; publish terms/privacy/support policy before charging mainnet. |
| **P3-2** | Low (client example) | `first-payment.mjs` uses `eip155:*`, no payee/resource allowlist, no redirect block. | Source. | A user copying the example can pay an unintended EVM 402 within the cap. | Use `payment-policy.mjs` or add allowlist/redirect refusal; label example non-production. |
| **P3-3** | Low (metadata) | `package-lock.json` root 1.0.3, root package 0.1.0, no single version source. | Source; `npm ci` still passes. | Confusing release provenance; easy future drift. | Regenerate lock; define one version constant; test. |

### Recommended order

1. **P0-1** release reconciliation (stop the bleeding).
2. **P0-2** live/client network agreement (make the demo usable or go mainnet).
3. **P0-3** mainnet host/facilitator/payee + one real smoke payment.
4. **P1-1** H-8 intent binding.
5. **P1-2** in-flight/durable recovery.
6. **P1-4** mainnet configuration enforcement.
7. **P2** operational/CI/doc fixes.
8. **P3** hardening/legal polish.

Do not invert this order. A new feature does not fix a release split or an unpayable default.

---

## 16. Smallest path to a mainnet-capable release

This is the minimum technical path, not a commercial launch plan. It preserves backward compatibility and the `checked`/`notChecked` contract.

### Gate 1 — one release identity

- Choose `1.0.4` (already on npm) and complete it, or withdraw it and restore `1.0.3`.
- If completing `1.0.4`: push `248923f`, create `mcp-v1.0.4`, attach the tarball, publish the MCP Registry version, update `src/manifest.mjs`, `src/openapi.mjs`, `src/server.mjs`, `src/site/mcp.html`, `server.json`, README, `llms-install.md`, and `examples/ONBOARDING.md`.
- Acceptance: every surface reports the same version; every link resolves; `npm view` `gitHead` is public; CI has a version-consistency test.

### Gate 2 — one payment mode story

- For the demo: set the bridge default and docs to `eip155:84532` (testnet) and label it “testnet USDC for mainnet analysis.”
- For mainnet: deploy mainnet and set the bridge default to `eip155:8453`.
- Do not ship both stories at once.
- Acceptance: a fresh user following the README can make a paid call against the live service; `payment-policy.filter` accepts the live 402; no 404 fallback.

### Gate 3 — mainnet host and configuration

- Paid always-on Render instance (or equivalent).
- `X402_MODE=mainnet`; canonical `AGENT_URL`; strong `PREFLIGHT_SECRET`; `MAINNET_ALWAYS_ON_CONFIRMED=yes`; real `FACILITATOR_URL`; explicit `PAY_TO_EVM`/`PAY_TO_SVM`; no `BYPASS_PAYMENT`/`ALLOW_MAINNET_ON_FREE_TIER`.
- Add a startup validation that the facilitator is not the known testnet-only URL and that payees are explicit (or deliberately documented defaults).
- Acceptance: `/health` says mainnet; `/ready` reads the expected chain; 402 shows mainnet network/asset/payee/price; external `/ready` monitor is green.

### Gate 4 — H-8

- Add optional `{ receipt, intent }` to `/preflight/verify`; recompute `sha256(canonicalStable(intent))`; compare to `receipt.intentHash`; keep `{ receipt }` for compatibility.
- Export a canonicalization helper; update `examples/preflight-guard.mjs`; add swapped-intent/tampered-receipt tests.
- Acceptance: an executor can prove the receipt is for the transaction it is about to sign without trusting the gate’s response body.

### Gate 5 — paid retry safety

- Minimum: an in-flight map/atomic reservation keyed by the idempotency key; return `409`/`425` or await the original instead of charging a concurrent duplicate.
- Mainnet: durable storage for settled recovery records (Postgres/Redis/durable KV) or an explicit, tested “no replay after restart” policy with a refund/support path. Single-instance process memory is not enough for a paid production service.
- Acceptance: two concurrent same-key requests produce one charge; restart between settlement and retry either replays or clearly reports “not recoverable” without silently charging again.

### Gate 6 — real mainnet smoke

- Make one small real mainnet payment (e.g. `/route` at $0.03).
- Verify `PAYMENT-RESPONSE` has a successful transaction; verify the on-chain transfer to the configured payee; verify the amount/network.
- Repeat with the same `x-idempotency-key`; verify `recovery.replayed`.
- Restart the service and repeat; verify the documented behavior.
- Acceptance: a public explorer receipt and a reproducible report; no claim before this exists.

### Gate 7 — commercial envelope

- Terms/privacy/refund policy; support contact/SLA; status page; uptime/alerting; incident/rollback runbook.
- Evidence of demand before revenue claims. No invented usage/revenue.
- Acceptance: a business buyer can understand what is measured, what is not, what happens on failure, and how to get help.

---

## Appendix A — Live evidence log

**Probe window:** 2026-10-21 18:00–18:30 UTC. The service was warm.

| Check | Result |
|---|---|
| `GET /health` | `200`; `mode: testnet`; `networks: Base Sepolia / Solana devnet`; `price: $0.05`; `ready: /ready`. |
| `GET /ready` | `200`; `ready: true`; `chainId: 1`; block around `26,242,730`; ~143 ms. |
| `GET /info` | `200`; MCP `1.0.3`; free host; `state_persistence` process-local; payment network `eip155:84532`; payee redacted. |
| `GET /.well-known/verify402.json` | `200`; `version: 1.0.3`; tarball `mcp-v1.0.3`; six tools. |
| `GET /openapi.json` | `200`; OpenAPI `3.1.0`; info version `1.0.3`; 16 paths. |
| `GET /findings` | `200`; cached Ethereum mainnet snapshot with `no_edge` rows at block around `26,242,579`; not a performance guarantee. |
| `GET /mcp` | `200`; page says `verify402-mcp v1.0.3`; 1.0.3 tarball link. |
| `POST /verify` (no payment) | `402`; `payment-required`; Base Sepolia exact, `50000` atomic USDC, `maxTimeoutSeconds: 300`; Bazaar present; no `Access-Control-Allow-Origin`. |
| `POST /verify` weak key | `400 weak_idempotency_key`; checked/notChecked present; no charge. |
| `POST /preflight` sample | `200 PASS`; `structural_only: true`; block ~`52,909,004`; checked scheme/network/asset/amount/payee/resource/block_freshness; receipt present. |
| `POST /preflight/verify` | `200 valid: true`; `verdict: PASS`; same block; `intentHash` 64 chars. |
| Security headers | `nosniff`, `Referrer-Policy`, `X-Frame-Options`, CSP, no `x-powered-by` on discovery surfaces. |
| CORS | Free discovery `*`; paid 402 has no ACAO. |
| Post-deploy | `SMOKE_BASE_URL=... npm run post-deploy` → 22/22 PASS, wake 822 ms. |
| Standalone post-deploy test | `node test/post-deploy.test.mjs` → exit 1; 20/22; stale mock; not a live failure. |
| Base Sepolia proof | tx receipt status `0x1`; chain `0x14a34` (84532); 30,000 USDC base units = $0.03; recipient matches the configured payee (address redacted). |
| npm 1.0.4 | published; `latest`; tarball downloads; core runtime files match local. |
| npm `gitHead` | `248923f...`; GitHub commit page `404`. |
| GitHub `mcp-v1.0.4` | tag/release/tarball `404`. |
| MCP Registry `1.0.4` | `404`; `1.0.3` active. |

**Not performed:** paid live call, mainnet payment, cold-start induction, Render dashboard inspection, env value read, npm publish, deploy, Git mutation.

### Base Sepolia settlement detail

The documented testnet proof transaction exists on Base Sepolia:

- status: success (`0x1`);
- chain: 84532;
- token transfer amount: `30,000` base units of testnet USDC (0.03 USDC at 6 decimals);
- recipient: the configured EVM payee (full address redacted);
- the transaction is a historical proof, not evidence of current mainnet revenue.

---

## Appendix B — Endpoint and tool inventory (compact)

### HTTP

- **Free:** `POST /preflight`, `POST /preflight/verify`, `GET /findings`, `GET /usage`, `GET /health`, `GET /ready`, `GET /info`, `GET /openapi.json`, `GET /llms.txt`, `GET /robots.txt`, `GET /sitemap.xml`, four `/.well-known/*` identity/discovery files, `GET /` and static pages.
- **Paid:** `POST /verify` ($0.05), `POST /safety` ($0.10), `POST /route` ($0.03), `POST /quotecheck` ($0.05), `POST /depth` ($0.05).
- **No endpoint:** `/preflight/deep` (Phase 1, not started), reputation, attestation issuance, refund, or admin.
- **Auth:** no accounts or API keys; paid auth is x402 proof; idempotency key is a bearer credential; free preflight is anonymous and rate-limited.
- **CORS:** free read-only discovery only; no wildcard on paid/preflight POSTs.
- **Body limit:** 64 KB JSON.

### MCP

- `preflight_gate` — free; no wallet.
- `verify_arbitrage` — $0.05; EVM x402.
- `check_token_safety` — $0.10; EVM x402.
- `get_best_route` — $0.03; EVM x402.
- `verify_quote_fairness` — $0.05; EVM x402.
- `get_trade_depth` — $0.05; EVM x402.
- Transport: stdio; npm package `verify402-mcp`; free mode registers only the gate.
- Paid default: Base mainnet (`eip155:8453`), which does not match the live testnet challenge.

---

## Appendix C — Test inventory

**Declared:** 206 tests; **offline:** 194; **RPC:** 12; **wired by configured scripts:** 205; `test/post-deploy.test.mjs` (1 test) is not wired.

| Area | Representative files | Count / notes |
|---|---|---|
| Preflight/receipt | `preflight.test.mjs`, `preflight-guard.test.mjs` | 33 + 8; gate, HMAC, block freshness, guard ordering. |
| Recovery/idempotency | `recovery.test.mjs` | 28; staged/promoted, TTL, replay cap, key entropy, evidence. |
| HTTP/security | `http.test.mjs`, `claims.test.mjs`, `log-redaction.test.mjs`, `shutdown.test.mjs` | 24 + 7 + 5 + 2; headers, CORS, Host, limits, redaction, drain. |
| Measurement | `measure.test.mjs`, `measure-typed.test.mjs`, `pinned-block.test.mjs`, `depth.test.mjs`, `depth-decimals.test.mjs`, `quotecheck.test.mjs` | 5 RPC + 12 + 6 + 5 + 4 + 6; quotes, errors, block pinning, decimals, fairness. |
| Safety/honesty | `safety.test.mjs`, `honesty.test.mjs` | 7 + 6; token checks, `notChecked`. |
| x402 | `x402-settlement.test.mjs`, `mcp-bridge/test/payment-policy.test.mjs`, `mcp-bridge/test/paid-call.test.mjs` | 2 + 12 + 7; settle guard, network/payee/resource, retry. |
| Discovery | `discovery.test.mjs`, `smoke.test.mjs`, `env-example.test.mjs` | 7 + 5 + 0; manifest/OpenAPI/llms/prices, smoke, env placeholders. |
| Offline mode | `offline-mode.test.mjs` | 1; no accidental mainnet in offline tests. |
| Post-deploy | `test/post-deploy.test.mjs` | 1; **not in `npm test`**; standalone fails on stale mock. |

**RPC test names:** all configured venues exist; QuoterV2 agrees with V2 within 5%; no invented profit on a 100k USDC round trip; output monotonic in size; deterministic at a pinned block; real quote fair; 50%-lowball overpaying; doubled quote too-good; no-liquidity unknown; WETH ladder fillable; $100 WETH under 3%; SHIB capacity under 2.5%.

**Gaps:** no live paid call, no mainnet settlement, no concurrent idempotency, no restart/replay test, no cold start, no mainnet misconfiguration test, no version consistency test, no MCP live-default test.

---

## Appendix D — Release/version matrix

| Artifact | Version/state | Resolves? | Matches local HEAD? |
|---|---|---|---|
| Local repo | `248923f`, ahead 2 | n/a | n/a |
| `mcp-bridge/package.json` | `1.0.4` | n/a | yes |
| npm `verify402-mcp` | `1.0.4`, latest | tarball 200 | core files byte-match local |
| npm `gitHead` | `248923f...` | GitHub page 404 | points at local commit, not public |
| GitHub tag `mcp-v1.0.4` | absent | 404 | n/a |
| GitHub release `mcp-v1.0.4` | absent | tarball 404 | n/a |
| GitHub tag/release `mcp-v1.0.3` | present | tarball 302/200 | older |
| MCP Registry | `1.0.3` active; `1.0.4` 404 | 1.0.3 200 | older |
| Live service | `1.0.3` strings; testnet | all tested routes 200/402 | no (1.0.3 vs 1.0.4) |
| `src/manifest.mjs` | version `1.0.3`; tarball/registry `1.0.4` | n/a | internally inconsistent |
| `src/openapi.mjs` | `1.0.3` | n/a | older version |
| `src/site/mcp.html` | `1.0.4` | links 404 | local-only future |
| `server.json` | `1.0.4` | registry 404 | unpublished |
| `mcp-bridge/package-lock.json` | root `1.0.3` | `npm ci` passes | metadata stale |

**Conclusion:** npm `1.0.4` matches local bridge code, but the public release, registry, and live service are `1.0.3`; the repo’s own `1.0.4` links are broken; npm’s source commit is not public.

---

## Appendix E — Environment and mainnet switch checklist

**No values are included here.** Names only; treat all secrets as write-only.

### Server environment (mainnet-relevant)

| Variable | Purpose | Mainnet status |
|---|---|---|
| `X402_MODE` | `mainnet` exact; other values fall back to testnet. | Required. |
| `AGENT_URL` | Canonical public origin; no Host derivation. | Required; startup refuses without it. |
| `PREFLIGHT_SECRET` | HMAC key for receipts. | Required; startup refuses without it. |
| `MAINNET_ALWAYS_ON_CONFIRMED` / `REQUIRE_ALWAYS_ON` | Human assertion of paid always-on host. | Required, but self-asserted. |
| `FACILITATOR_URL` | Mainnet facilitator endpoint. | Required unless CDP; compatibility not validated. |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Coinbase CDP facilitator credentials. | Optional; required for CDP URL. |
| `PAY_TO_EVM` / `PAY_TO_SVM` | Receiving addresses. | Docs say required; code has defaults and does not enforce. |
| `PRICE`, `SAFETY_PRICE`, `ROUTE_PRICE`, `QUOTECHECK_PRICE`, `DEPTH_PRICE` | Per-route prices. | Optional; challenge is authoritative. |
| `ETH_RPC_URL`, `ARB_RPC_URL`, `BASE_RPC_URL` | Private/paid RPC endpoints. | Recommended for production. |
| `READY_CHAIN_ID` | Chain for `/ready`; default 1. | Set intentionally. |
| `PORT` | HTTP port. | Host-provided. |
| `SHUTDOWN_TIMEOUT_MS` | Drain timeout; default 10,000. | Optional. |
| `BYPASS_PAYMENT` | Local dev bypass. | Must be unset in mainnet; startup refuses. |
| `ALLOW_MAINNET_ON_FREE_TIER` | Escape hatch. | Must be unset; startup refuses if set. |

### MCP client environment

| Variable | Purpose |
|---|---|
| `VERIFY402_URL` | Server base URL. |
| `EVM_PRIVATE_KEY` | Paid hot-wallet key; omit for free gate. |
| `MAX_PAYMENT_USD` | Per-payment cap (default $0.25). |
| `MAX_DAILY_USD` | Optional daily cap. |
| `SPEND_LEDGER_PATH` | Optional ledger path. |
| `VERIFY402_NETWORKS` | EVM network allowlist; default `eip155:8453`. |
| `VERIFY402_PAY_TO` | Payee allowlist; default project payee. |
| `VERIFY402_RESOURCE_PREFIX` | Server/resource allowlist. |
| `SMOKE_BASE_URL` | Post-deploy target. |

### Mainnet acceptance checklist

- [ ] One version across npm, GitHub, registry, live, manifest, OpenAPI, site.
- [ ] npm `gitHead` public.
- [ ] Paid always-on host; no free plan.
- [ ] `X402_MODE=mainnet`; `/health` says mainnet.
- [ ] `AGENT_URL` canonical; Host spoof rejected.
- [ ] `PREFLIGHT_SECRET` strong and stable.
- [ ] `MAINNET_ALWAYS_ON_CONFIRMED=yes`; external monitor proves uptime.
- [ ] Real mainnet facilitator; not the testnet-only URL.
- [ ] Explicit `PAY_TO_EVM`/`PAY_TO_SVM`; no defaults.
- [ ] 402 challenge shows mainnet network/asset/payee/price.
- [ ] One small real payment settles; explorer receipt verified.
- [ ] Same-key retry replays; no double charge.
- [ ] Restart between settlement and retry is understood and handled.
- [ ] `/ready` monitored externally; `/health` only liveness.
- [ ] H-8 intent binding fixed.
- [ ] Post-deploy/version/network tests in CI.
- [ ] Terms/privacy/support/refund policy published.
- [ ] No mainnet or customer claims before evidence exists.

---

## Final note

The most important finding is not a missing feature. It is a **mismatch between what the service honestly is today and what parts of its distribution surface imply**. The code is better than the release and documentation state. Fix the release, make the live rail and client default agree, finish the mainnet operations, and preserve the `checked` / `notChecked` honesty contract. Until then, treat Verify402 as a strong testnet demonstration, not a production or commercial service.

---

## Post-review repair pass (2026-10-21)

The focused repair pass applied the review's release and testnet-onboarding
recommendations without changing runtime payment policy or deploying:

- Added `src/version.mjs` (`RELEASE_VERSION = "1.0.4"`) and wired it into the
  service manifest, OpenAPI, `/info` (`version` and `mcp.version`), and the
  discovery checks. Fixed `mcp-bridge/package-lock.json` to `1.0.4`.
- Made public onboarding testnet-first: Base Sepolia `eip155:84532`, testnet
  USDC, explicit "analysis reads mainnet chain data; payments are testnet"
  wording, explicit `PAYMENT-SIGNATURE` (legacy `x-payment` accepted), and a
  separate explicit mainnet section.
- Replaced broken `mcp-v1.0.4` GitHub tarball links with the published npm
  tarball and pinned npm install. The service manifest now points at the npm
  tarball and the registry version list (both resolve).
- Added `test/release-consistency.test.mjs` and fixed/wired
  `test/post-deploy.test.mjs` into `test:offline`. Updated the post-deploy mock
  for the current `/preflight`, `/preflight/verify`, `/verify`, agent-card, and
  security-header behavior.
- Updated `PUBLISH_STEPS_FOR_ME.md`, `DEPLOY_READINESS.md`, `CHANGELOG.md`, and
  historical audit docs so npm `1.0.4`, registry/live `1.0.3`, and the manual
  release actions are not conflated.

Verification at the end of the repair pass:

- `npm test` exited `0` (full offline + RPC + discovery + smoke suite).
- `npm run test:counts` reported `TOTAL 211 199 12`.
- The live `post-deploy-check.mjs` still passed `22/22`; the live service still
  reports `1.0.3` and testnet payments, as expected before deploy.
- No npm publish, GitHub push/tag/release, MCP Registry publish, deploy, or
  paid call was performed.

Remaining known limitation: the published npm `1.0.4` tarball's own
`README.md` and `.env.example` still show the generic Base mainnet paid example.
Those files are immutable in npm `1.0.4`; fixing the npm page requires a future
package version. Repository root onboarding, `llms-install.md`, and `/mcp` are
corrected for the public testnet demo.
