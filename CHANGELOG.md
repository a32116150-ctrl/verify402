# Changelog

All notable changes to verify402. This file records repository changes; it does
not imply a deploy or an npm publish.

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
