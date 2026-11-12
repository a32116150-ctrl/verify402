# Changelog

All notable changes to verify402. This file records repository changes; it does
not imply a deploy or an npm publish.

## Unreleased

No version bump, deploy, or publish is implied by this section.

### Added

- Durable `/usage` counters. When `VERIFY402_USAGE_PATH` is set (or a durable
  path exists next to `RECOVERY_DB_PATH`), the free-gate call counters are
  written to a small JSON file and survive restart and deploy; otherwise they
  stay process-local and say so. Atomic write (tmp file + rename), corrupt file
  starts a fresh window with a warning, and `flushUsage()` runs on graceful
  shutdown. Includes new `byTool` and `mcpPings` buckets. The `/usage` response
  now states its persistence scope explicitly. Covered by new persistence tests
  in `test/usage.test.mjs`.
- `POST /inspect` now counts the target host in `byInspectHost` — hostname
  only, no path, no identity, counts-only. Sellers can see whether their
  endpoint is getting looked at without learning who called. Exposed on
  `GET /usage` and persisted with the same file as the other counters.
- Seller-signed terms manifests: `policy.sellerTermsManifest` (caller-pinned
  HTTPS origin, seller-signed, spec `verify402/seller-terms@1`) + the same
  fetch-verify discipline as the payout manifest. The challenge's network,
  asset, amount and timeout are bound to one seller publication: a drift of
  any of the four **BLOCKs** (`terms_mismatch`, naming the field); a resource
  with no published terms is a CAUTION (`terms_resource_unlisted`); a bad or
  expired manifest degrades like the payout manifest (`terms_manifest_*`);
  a match records `terms_match` and a signed `termsBinding` in the receipt.
  Ten tests cover the matching/mismatch matrix plus signature and expiry.

- `POST /usage/ping` — anonymous, opt-in usage pings from the MCP bridge. The
  bridge sends one line per tool call (`tool` + `ok: boolean`) only when the
  operator sets `VERIFY402_TELEMETRY=1`; never arguments, intents, results,
  wallets, or IPs. Tool name comes from a shared allowlist; pings are labelled
  by the `X-Verify402-Client` header, counted as `mcp:<tool>` in `byKind`,
  `byTool`, `byStatus`, and a new `byClientSource: "mcp-ping"` bucket. A failed
  ping never changes a tool's answer and the endpoint accepts at most 120/min
  per IP. A new `mcp-bridge/test/telemetry.test.mjs` pins the opt-in-off default,
  the minimal payload, and the never-throw guarantee.

- Two new free MCP tools in the bridge: `inspect_402` (read an x402 402
  challenge before paying it — endpoint URL or a challenge you already have;
  returns price, token, network, payee, the bound resource, a PASS / CAUTION /
  BLOCK verdict, typed reasons, and a receipt) and `directory_402` (the watched
  list of public x402 endpoints with protocol and sign verdicts and recorded
  changes). Both are registered without a wallet, are not bound to any paid
  route, and are advertised as free in the manifest and on the `/mcp` page.
  This is the first change to the published package since `1.0.9`, so a new
  package release is now meaningful rather than cosmetic. Five bridge tests
  cover the free-tool guarantees.
- `src/tokens.mjs`: a payment token registry for the chains the gate already
  supports — USDC, USDT, DAI, USDG, and WETH on Ethereum, Arbitrum, Base, the
  two testnet rails, and Solana mainnet/devnet. Addresses were cross-checked
  against CoinGecko's per-chain token lists and against the USDC addresses
  already in `config.mjs`; Solana uses the Circle-issued mint, not a bridged
  variant. A recognized dollar stable is now named instead of being flagged
  `non_canonical_asset`, and a USD cap can be enforced on it with the $1
  parity labelled as assumed, not verified. Volatile assets (WETH) get a
  `volatile_asset` caution because the gate cannot price them in USD; unknown
  addresses still get the old caution. The manifest now advertises the
  recognized assets per network. Covered by eight registry tests plus four
  preflight tests (suite now 477).

- `POST /inspect` and the `/inspect` page: a free, no-wallet x402 inspector.
  Paste an endpoint URL (GET or an empty POST) and the service fetches the
  `402` once, reads the `PAYMENT-REQUIRED` header or body challenge, and runs
  the same structural payment preflight an agent runs before signing on every
  accept. Returns price, token, network, payee, the bound `resource`, a
  PASS/CAUTION/BLOCK verdict, typed reasons, the checks that ran, and a
  receipt. A pasted challenge (JSON or base64 header) needs no fetch. The
  fetch is pinned to a validated public address (private/loopback refused,
  no redirects, 64 KB cap, 6 s timeout) so a second DNS answer cannot rebind
  it; the 402 is treated as untrusted data. `/inspect` has its own per-IP
  rate bucket (20/min) so preflight traffic cannot spend its budget, and it
  shares the in-flight cap. Covered by 13 unit tests plus three HTTP-level
  checks (suite now 477). Linked from the nav, footer, sitemap, landing page,
  and `llms.txt`; also listed in the plain-text root menu.
- `GET /directory.json` and the `/directory` page: a watched list of public
  x402 endpoints, re-inspected every 15 minutes. Each entry carries two
  verdicts: `protocol` (is the challenge well-formed x402? network-agnostic)
  and `sign` (should an agent on this instance's supported networks sign it?).
  The watch diffs status, price, payee, network, and both verdicts on every
  refresh and records the changes. Seed entries are data, not endorsements:
  this service's own `/verify`, Naven's Robinhood Chain demo, and three
  grug402 intentional edge cases (missing header, non-base64 header, legacy v1
  header). History is process-local unless `VERIFY402_DIRECTORY_FILE` is set;
  on a free host that file is ephemeral, so a restart starts a fresh history.
  `/inspect` now also accepts the legacy v1 `X-PAYMENT` header. Covered by ten
  unit tests plus two HTTP checks (suite now 477).

- `GET /explorer` and the `/activity` page: a testnet explorer with two tables.
  Payments are every ERC-20 transfer to the service payTo address on Base
  Sepolia, read from a public Blockscout indexer with explorer links, a USDC
  total, and `stale`/cache markers. Verdicts are the published findings rows
  (pair, verdict, net/gross bps, pinned block) with a recompute link. The page
  has a one-box search (tx hash, address, pair, verdict, date), a testnet
  ribbon, and `armed: false` for mainnet until it is armed. Linked from the nav,
  footer, sitemap, and `llms.txt`.
- `GET /npm-stats` and a home-page counter: last-7-day and last-30-day npm
  downloads for `verify402-mcp`, cached for an hour server-side. Labeled as
  downloads, not unique agents.
- `src/explorer.mjs` with exact fixed-point USDC formatting and normalization,
  covered by eight offline tests (suite now 477).
- Recovery audit (`npm run audit:recovery`, `test/recovery-concurrency.test.mjs`
  and `test/recovery-crash.test.mjs`, `docs/recovery-audit.md`): three concurrent
  copies through the real `@x402/express` middleware (3 handler runs and 3
  settles without the claim; 1 and 1 with it, losers 409 not 402), plus a
  ten-case crash matrix that SIGKILLs a process at each durable store write and
  asserts one charge, one handler run, and no replay before promotion. Kill
  points live in `src/recovery-store.mjs` behind `VERIFY402_CRASH_AT`, inert
  unless the audit sets them.

- `GET /usage/site`: aggregate HTML page views by path, referring host, and day
  for the human site, plus the count of skipped crawlers/clients. No cookies, no
  IP addresses, no query strings, no per-visitor identifiers, and no unique
  visitor claim. Counts persist to `<RECOVERY_DB_PATH dir>/site-analytics.json`
  (or `SITE_ANALYTICS_PATH`) and fall back to a process-local window that says
  so. See `docs/site-analytics.md`.
- `npm run check:durability` (`scripts/durability-cutover.mjs`): reads the live
  `/health` and `/info` and reports whether settlement recovery is durable.
  Exit 0 only when a restart replays a settled idempotency key instead of
  charging again.
- Boot warnings that name the two memory-only gaps (`RECOVERY_DB_PATH` unset,
  analytics process-local) instead of leaving them to be discovered on
  `/health`.

### Security

- `npm audit --omit=dev` is back to **0 vulnerabilities**. `@x402/*` moves from
  2.28.0 to 2.30.0 (zod 4.6.7, clearing GHSA-mrhx-c7xc-m3w5), `viem` to
  2.57.17, and the transitive `body-parser` to 2.4.0 (GHSA-27r3-jxmh-p828).
- `@coinbase/cdp-sdk` is no longer a hard dependency. It was only reachable when
  `MODE=mainnet` and `CDP_API_KEY_ID` were both set; that branch now imports it
  lazily and fails closed with an install hint. The live testnet deployment
  never took the branch, and the package's zod 3 tree was the last advisory in
  the audit.

### Changed

- `DEPLOY.md` 3.2: one-time durable-recovery cutover checklist (paid instance,
  1 GB disk at `/var/data`, `RECOVERY_DB_PATH`, verification, rollback).
- `render.yaml` carries the disk configuration as a commented block, because a
  free instance cannot attach one.
- `README.md` endpoint table lists `/usage` and `/usage/site`.

### Docs

- Historical deploy guides moved to `docs/archive/` with an index; current
  guidance stays in `DEPLOY.md`.
- `video/`, `renders/`, and `*.mp4` are ignored so local media cannot enter git.

## 1.0.9 — 2026-10-26

`verify402-mcp@1.0.9` removes the `@x402` client SDK from the published bridge
and implements the x402 v2 payer locally on `viem`. A clean install now reports
zero audit findings.

### Changed

- Removed the `@x402/axios` and `@x402/evm` dependencies. They pulled a nested
  `zod` 3.25.76 copy covered by
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
  (memory-exhaustion DoS; every 3.x is in range, no patched 3.x exists), and npm
  ignores `overrides` declared inside a dependency, so consumers could not clear
  the banner. Upstream: x402-foundation/x402#3953.
- Added `mcp-bridge/x402-client.mjs`: x402 v2 wire format
  (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`), scheme
  `exact`, EIP-3009 `transferWithAuthorization` with a random 32-byte nonce and
  `validBefore = now + maxTimeoutSeconds`. It signs only after the unchanged
  selection, policy, and tool-bound guard in `payment-policy.mjs` pass.
- No change to tools, routes, prices, spend caps, network allowlists, payee
  checks, settlement, or `/usage` labels.

### Verified

- Packed-tarball install: 123 packages, `npm audit` → **0 vulnerabilities**
  (was 5–6 high).
- 243/243 offline tests, discovery validation 35/35.
- Live end-to-end paid call: 0.03 Base Sepolia testnet USDC settled;
  transaction `0x2506afa3087f86cdf64072741be77d30d92613b74143118c5b5b72ca3c5825f7`
  with an on-chain Transfer from the payer to the configured payee.

### Release metadata

- npm: `verify402-mcp@1.0.9`, `gitHead
  60c7b6fcffb1c1d47561577b752d9c68b8ecba16`, shasum
  `ce1742d7b187b6881a7ba396d978de61c935750c`.
- MCP Registry: `1.0.9` active and latest
  (`publishedAt: 2026-10-26T11:56:38.535824Z`).
- GitHub: release `mcp-v1.0.9` published `2026-10-26T11:58:20Z`.
- Render: `/info` reports `1.0.9`; free-only post-deploy check passed 29/29.
- Clean install from the public registry: 123 packages, `npm audit` →
  0 vulnerabilities, no `@x402` in the tree.

## 1.0.8 — 2026-10-24

`verify402-mcp@1.0.8` corrects payout provenance, adds an automatic x402
preflight hook, and labels MCP traffic anonymously for usage attribution.

### Changed

- `policy.sellerPayoutWallets` is now a caller-supplied payout **allowlist**,
  not a binding. A match adds `payee_payout_allowlist`; a mismatch is
  **BLOCK** `payee_not_payout_wallet`. It never adds `payee_payout_binding`.
  This closes the circular case where a list copied from the 402 could look
  like independent provenance.
- Added `policy.sellerPayoutManifest` and the `verify402/seller-payout@1`
  manifest. The gate fetches a seller-signed manifest from a caller-pinned
  public HTTPS origin outside the 402, verifies the EIP-191 signature, chain,
  expiry, optional `expectedSigner`, and payee membership. Only a verified
  match adds `payee_payout_binding`.
- Payment responses now include `payeeBinding` with the provenance source,
  match result, origin, signer, expiry, and manifest hash when applicable.
  `payTo ownership / proven seller payout wallet` remains in `notChecked`;
  a signed seller manifest is a binding, not independent proof of wallet
  ownership.
- `examples/preflight-guard.mjs` now exports `createX402PreflightHook()` and
  `guardX402Payment()`. The hook maps an x402 v2 challenge to a payment intent,
  blocks on `BLOCK`, refuses unacknowledged `CAUTION`, verifies the receipt,
  and attaches it to `context.verify402` before signing.
- The MCP bridge now sends one shared anonymous label,
  `X-Verify402-Client: verify402-mcp/<version>`, on free and paid requests.
  `/usage` reports the label source (declared header or User-Agent), caps the
  number of distinct labels, and states that labels are self-declared and not
  identities. `client-id.mjs` reads the version from `package.json`.

### Release metadata

- npm: `verify402-mcp@1.0.8`, `gitHead
  d61fcfec31d5fd8d3884ccebe015d81821c0bac9`, shasum
  `b892f4da0277466666ba0ef9ba13f33ed930f8be`.
- MCP Registry: `1.0.8` active and latest
  (`publishedAt: 2026-10-24T10:55:44.461072Z`).
- GitHub: release `mcp-v1.0.8` published `2026-10-24T10:56:28Z`.
- Render: `/info` reports `1.0.8`; free-only post-deploy check passed 29/29.

## 1.0.7 — 2026-10-24

`verify402-mcp@1.0.7` adds opt-in caller-supplied obligation state and seller
payout binding to the free preflight gate.

### Added

- Optional caller-supplied obligation checks for payment intents.
  `payment.idempotencyKey` plus `policy.obligation.settledKeys` returns
  **BLOCK** `obligation_already_settled` for a re-presented key.
  `policy.obligation.spentUsd` plus `grantUsd` returns **BLOCK**
  `cumulative_spend_over_grant` when this payment would exceed the grant.
  The gate does not persist this state; `notChecked` names the missing
  cross-process ledger and any missing key/ledger input.
- Optional `policy.sellerPayoutWallets` binds `payTo` to caller-supplied seller
  payout addresses. A match adds `payee_payout_binding`; a mismatch is
  **BLOCK** `payee_not_payout_wallet`. This is a binding, not independent proof
  that the seller controls the wallet. **Superseded in Unreleased:** the
  caller-supplied list is now an allowlist; only a verified
  `policy.sellerPayoutManifest` adds `payee_payout_binding`.
- The preflight receipt now binds `payment.idempotencyKey` and the normalized
  obligation/payout policy through the existing intent hash.

### Changed

- `policy.allowedPayTo` matches now add `payee_allowlist` to `checked`.
- MCP `preflight_gate` exposes `payment.idempotencyKey`,
  `policy.obligation`, `policy.sellerPayoutWallets`, and the previously missing
  `policy.allowedResourceHosts`.

### Release metadata

- npm: `verify402-mcp@1.0.7`, `gitHead
  485256fda9072447ea4ae3b8a3420069c9efb765`.
- MCP Registry: `1.0.7` active and latest
  (`publishedAt: 2026-10-23T23:55:58.349764Z`).
- GitHub: release `mcp-v1.0.7` published `2026-10-23T23:58:30Z` and is the
  latest release.
- Render: `/info` reports `1.0.7`; free-only post-deploy check passed 29/29.

## 1.0.6 — 2026-10-23

`verify402-mcp@1.0.6` is the release that points at the fixed public
`/preflight` service. The MCP bridge itself still forwards the caller's
`policy` object; the behavior change is server-side and applies to clients
already using the public server.

### Fixed

- `payment.resource` is no longer accepted as an identity check just because it
  parses as a URL. With no `policy.expectedResource` or
  `policy.allowedResourceHosts`, the verdict is now **CAUTION**
  `resource_identity_unverified`, and `notChecked` names `resource identity`.
- `policy.allowedResourceHosts` binds the resource host. A matching host is a
  checked `resource_host` and can PASS; a foreign host is **BLOCK**
  `resource_host_not_allowed`. `policy.expectedResource` still performs exact
  URL binding.
- Unsupported but real networks such as `eip155:56` now say “not supported by
  this instance” and list the supported networks, instead of calling the chain
  unknown. The verdict remains **BLOCK**.

### Scope disclosures

- `notChecked` now names `payTo ownership / proven seller payout wallet` and
  `obligation state (idempotency key, cumulative spend, grant balance)`.
  Neither is implemented as a ledger or registry.

### Release metadata

- npm: `verify402-mcp@1.0.6`, `gitHead
  954702575b9df58a08e8dbdac45d680ecf3cc365`.
- MCP Registry: `1.0.6` active and latest
  (`publishedAt: 2026-10-23T22:12:34.131712Z`).
- GitHub: release `mcp-v1.0.6` is published and is the latest release.
- Render: `/info` reports `1.0.6`; free-only post-deploy check passed 29/29.

## 1.0.5 — 2026-10-22

`verify402-mcp@1.0.5` is published to npm. The package is immutable; do not
republish, overwrite, or unpublish it. No git tag, GitHub release, MCP Registry
entry, or deployment is implied by the npm publication: the MCP Registry entry
and the Render deployment remain pending and unverified. The previously
published `verify402-mcp@1.0.4` remains immutable.

### Security

- The 402 challenge is now validated as a whole before any signature exists.
  Every offered requirement must use an allowlisted EVM network, the
  configured payee, the canonical USDC contract *and* the canonical EIP-712
  domain for that network, pin EIP-3009, and stay inside the per-payment cap.
  A challenge that also offers Base mainnet is refused as a whole instead of
  being filtered down to the testnet option.
- `maxTimeoutSeconds` is validated as a positive integer no greater than
  `300`. The SDK signs `validBefore = now + maxTimeoutSeconds`, so a missing,
  string, fractional, zero, negative, or unbounded value is now refused rather
  than turned into a long-lived transferable authorization.
- Signing extensions are closed by default. `extra.assetTransferMethod` must
  be `eip3009`; `permit2` and any unvalidated `extra` key are refused. The
  `extra` allowlist is `name`, `version`, `assetTransferMethod`, `paymentFlow`.
- `VERIFY402_NETWORKS` is constrained to an explicit supported map
  (`eip155:84532` Base Sepolia, `eip155:8453` Base mainnet). An arbitrary
  `eip155:<chainId>` is refused instead of inferred from an asset the SDK
  happens to recognise. Base mainnet stays an explicit opt-in; the default is
  Base Sepolia testnet.
- An explicitly empty `VERIFY402_NETWORKS` or `VERIFY402_PAY_TO` fails closed
  instead of silently falling back to a default.
- The 402 resource must be an exact `origin + path` match with no query, no
  fragment, and no trailing-slash normalisation, and it must be one of the
  configured paid routes.
- The payer proves that the requirement it signs is the exact object the SDK
  selected out of the 402 challenge. A substituted or mutated requirement is
  refused, and the selected requirement is re-validated immediately before
  signing.
- The paid smoke reads the 402 challenge from the `PAYMENT-REQUIRED` header
  only. The response body is never used to authorise or override a payment, and
  the paid branch aborts before the payer is spawned when the header is
  missing, malformed, or refused by the shared policy.
- The paid smoke now requires genuine settlement evidence: a decodable
  `PAYMENT-RESPONSE` receipt whose settlement succeeded, on the expected
  network, with a transaction hash, and with a matching payer and amount when
  the receipt reports them. A paid run without that evidence exits non-zero.

### Release metadata

- The release version is `1.0.5` consistently across the package manifest, the
  lockfile, `server.json`, the service manifest, OpenAPI, the version module,
  the site, and the release-consistency assertions.
- The registry and manifest metadata now describe the real 1.0.5 default
  (Base Sepolia testnet, `isRequired: false`) instead of claiming a
  testnet default for the mainnet-defaulted 1.0.4 artifact.

### Tests

- New offline regression tests cover the `maxTimeoutSeconds` boundaries, the
  installed bridge's real x402 client path with a fake signer (a refused
  challenge never reaches the signer), the settlement-receipt gate, the
  header-first 402 parser, and a cross-layer reconciliation that requires the
  shared validator, the standalone payer, the installed bridge, and the paid
  smoke to reach the same accept/refuse decision for the same fixture.

## Unreleased — Hotfix 2 (2026-10-21)

### Security

- Idempotency keys are treated as bearer credentials. Weak, short, sequential,
  or repeated-block keys are rejected with `400 weak_idempotency_key`; callers
  are told to use `crypto.randomUUID()`. No key still means normal pay-per-call,
  and raw keys are never logged.
- The agent card and other public identity URLs no longer derive from `Host`.
  `AGENT_URL` is required in mainnet; testnet/local requests are checked against
  a host allowlist.
- Security headers (`nosniff`, referrer policy, frame protection, and a
  static-site CSP) are set on every response. `x-powered-by` is disabled.
- CORS is now explicit: free read-only discovery allows any origin; paid routes
  and free writes emit no wildcard.
- `SIGTERM`/`SIGINT` stop new connections, drain in-flight requests up to
  `SHUTDOWN_TIMEOUT_MS`, then exit `0`; a drain timeout force-closes and exits
  `1`.

### Correctness

- One pinned block is threaded through `/safety`, `/verify`, `/route`,
  `/quotecheck`, and `/depth`; the measurement block is canonical in the
  evidence bundle.
- `/depth` uses the token's real decimals. `impliedPriceBase` is the primary
  field; `impliedPriceUsd` remains only as a deprecated alias for known
  USD-stable bases.
- `quoteV2` accepts a legitimate exact 1:1 output while retaining the structural
  decode guard.
- All paid-route numeric inputs are validated at the boundary with explicit
  ranges, JSON numbers only, BigInt bps/ratios, and `uint256` raw limits. Bad
  input returns a stable 400, never a 500.
- x402 packages are pinned exactly to `2.28.0`; a real middleware test proves
  settlement is cancelled for every response `>= 400`.

### MCP bridge

- Every paid MCP operation generates one `x-idempotency-key` and reuses it on
  retry. Lost responses and timeouts are retried; `402` and `409` are not.
  `recovery.replayed` is surfaced to the caller.
- `paid-call.mjs` is included in the published package's `files` list. Without
  that entry a future publish would ship `index.mjs` with a missing import.

### Discovery and docs

- OpenAPI, the service manifest, `/info`, runtime responses, and tests now share
  TTL, preflight-concurrency, price, health/readiness-shape, and banned-claim
  values. `/ready` is documented in OpenAPI.
- Fixed stale discovery text: idempotency TTL, preflight concurrency, health
  fields, 409 wording, responseHash scope, npm/registry “NOT YET” status, and
  `DEPLOY.md`'s old test count. Docs point at `npm run test:counts` instead of
  hardcoding counts.
- Recovery and `/usage` are documented as process-local and lost on restart.
  Mainnet startup now requires both `AGENT_URL` and `PREFLIGHT_SECRET`.
- `.env.example` lists every discovered server, registration, test, and MCP
  environment variable using placeholders only.
- `DEPLOY_CHECKLIST.md` now covers a paid always-on host, rollback, and the
  `npm run smoke` post-deploy checks.

### Tests

- Added regression coverage for key entropy, x402 settlement cancellation,
  pinned blocks, depth decimals, MCP replay/no-double-payment, forged Host,
  malformed paid inputs, exact 1:1 quotes, discovery parity, security headers,
  CORS, and graceful shutdown.
- Offline mode still uses one closed endpoint with no public fallback;
  RPC-required tests are classified in `test/rpc-manifest.json`.

### `verify402-mcp` 1.0.4 release status

`verify402-mcp@1.0.4` was published to npm on 2026-10-21 and was the `latest`
tag until `1.0.5`. Do not publish 1.0.4 again and do not overwrite 1.0.3; npm
versions are immutable. The patch was backward compatible: no MCP tool names,
inputs, or existing response fields were removed, and it added the missing
`paid-call.mjs` package file.

The focused repair pass reconciles local package and lockfile metadata, the
service manifest, OpenAPI, `/info`, the `/mcp` page, and onboarding docs at
`1.0.4`. It also changes the source-tree bridge default to Base Sepolia
testnet and fails closed on a mainnet-only challenge. That runtime change is
**not** in the immutable published `1.0.4` package: npm `1.0.4` still defaults
to mainnet, so public-demo clients must set `VERIFY402_NETWORKS=eip155:84532`
until a future patch release is approved. It does not push, tag, publish, or
deploy. GitHub, the MCP Registry, and the live service remain on `1.0.3` until
the human-only steps in `PUBLISH_STEPS_FOR_ME.md` are completed.
