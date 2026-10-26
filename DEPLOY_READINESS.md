# Deploy Readiness Report

Rule: X402_MODE=testnet only on free instances. Mainnet requires an always-on paid instance.

## Immutable npm release boundary

- Published `verify402-mcp@1.0.8` and `1.0.7` are immutable and default the bridge to Base Sepolia testnet (`eip155:84532`). The older `1.0.6`, `1.0.5`, and `1.0.4` artifacts are also immutable and must not be republished.
- This source tree is `1.0.9`: it removes the `@x402` client SDK from the published bridge and implements the x402 v2 payer locally on viem, so a clean install audits clean. It keeps the `1.0.8` payout-provenance correction (`sellerPayoutWallets` is an allowlist; only a verified seller manifest adds `payee_payout_binding`), the x402 preflight hook, and anonymous MCP client labels.
- `server.json` and the service manifest describe the **source** release: `VERIFY402_NETWORKS` is optional with an explicit `eip155:84532` default, and Base mainnet is an opt-in (`eip155:8453`).
- The `1.0.9` package is published on npm, active in the MCP Registry, published as GitHub release `mcp-v1.0.9`, and deployed on Render; `/info` reports `1.0.9` and the free-only post-deploy check passed 29/29. Do not attach this source tree to an existing version or move an existing `mcp-v1.0.x` tag.

## Mode-aware runtime metadata and the static site

- `/info`, `/llms.txt`, OpenAPI, the agent card, the service manifest, and `/.well-known/x402` are built from the configured `X402_MODE`; a mainnet-mode process does not publish testnet payment copy.
- The static HTML pages remain an explicitly testnet-demo site. They are not rendered mode-aware. A mainnet deployment must not treat those pages as evidence that mainnet settlement was validated.
- Mainnet settlement mechanics are preserved but were not exercised by this repair. Mainnet is **not** claimed production-ready.

## Verified offline

- `npm run test:offline` passed in this repair pass. The 12 RPC-dependent tests were skipped.
- `node test/discovery.test.mjs` (8/8), `node scripts/check-discovery.mjs` (35/35), `node test/env-example.test.mjs`, `node test/smoke.test.mjs` (28/28), `node test/release-consistency.test.mjs` (14/14), `node test/post-deploy.test.mjs` (11/11), `node test/policy-reconcile.test.mjs` (11/11), and the bridge policy/payer/bridge-client tests (86/86) passed.
- `npm run test:counts` reports `TOTAL 409 397 12`; `test:offline` now includes smoke, discovery, env-example, and the cross-layer policy reconciliation.
- Full `npm test` and `npm run test:rpc` were **not** rerun in this repair pass; they require live RPC access and are not claimed as passed here.
- No paid call, live RPC read, or deployment was performed in this repair pass; the paid smoke, the settlement receipt, and the live 402 are unverified against a real service.
- Idempotency TTL, preflight limits, prices, health/ready shapes, and banned claims are checked across OpenAPI, manifest, and runtime constants.
- Security headers, CORS behavior, graceful shutdown, and startup guards are covered by automated tests.
- The discovery test verifies the published MCP package includes `paid-call.mjs` and every local runtime import of `index.mjs`.

## Verified only after deploy

- Live `/ready` chain read latency and block freshness.
- Real RPC provider behavior under production traffic.
- Live document consistency across `/info`, `/openapi.json`, `/.well-known/verify402.json`, `/.well-known/x402`, and `/llms.txt`.
- Live security headers and absence of `x-powered-by` on the deployed host/CDN.
- Optional one real paid call with `SMOKE_PAID=1` on a testnet target only, via `npm run smoke`. `npm run post-deploy` is always free-only and rejects any `EXPECTED_MODE` other than `testnet`; mainnet deployment checks are not implemented there yet.

Run after deploy:

```sh
SMOKE_BASE_URL=<url> EXPECTED_VERSION=1.0.9 EXPECTED_MODE=testnet npm run post-deploy
```

Paste the full output to the reviewer.


## Hosting status

This demo runs on a free host. Free instances spin down after about 15 minutes idle, can take about a minute to wake, can restart at any time, and have an ephemeral filesystem. Recovery records and /usage counters are in memory and are lost on restart. X402_MODE=testnet only on free; mainnet requires an always-on paid instance.

## Host environment variables

Required in mainnet (always-on paid instance only):

- `X402_MODE=mainnet`
- `AGENT_URL=https://<canonical host>` (canonical public origin; do not derive from Host)
- `PREFLIGHT_SECRET=<openssl rand -hex 32>` (HMAC secret for receipts)
- `FACILITATOR_URL=<facilitator endpoint>` (or CDP credentials below)
- `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` when using Coinbase CDP
- `PAY_TO_EVM` and `PAY_TO_SVM` (payment destination addresses)

Common optional values:

- `PORT` (host-provided)
- `READY_CHAIN_ID` (default 1)
- `SHUTDOWN_TIMEOUT_MS` (default 10000)
- `ETH_RPC_URL`, `ARB_RPC_URL`, `BASE_RPC_URL` (private RPC endpoints)
- `PRICE`, `SAFETY_PRICE`, `ROUTE_PRICE`, `QUOTECHECK_PRICE`, `DEPTH_PRICE`

## RPC key rotation

1. Create a new RPC key in the provider dashboard.
2. Set the new key only in the host environment (`ETH_RPC_URL`, `ARB_RPC_URL`, or `BASE_RPC_URL`).
3. Redeploy the service.
4. Confirm `/ready` returns `ok: true` and a recent `blockNumber`.
5. Revoke the old key in the provider dashboard.
6. Never commit the new key, paste it into tickets, or print it in logs.

## Rollback

1. Revert the deployed commit or redeploy the previous known-good commit.
2. Restore the previous host environment if it changed.
3. Confirm `/health`, `/ready`, and `/preflight` work.
4. Run `SMOKE_BASE_URL=<url> EXPECTED_VERSION=<rollback version> EXPECTED_MODE=testnet npm run post-deploy` (the default expects `1.0.9`, so a `1.0.3` rollback must state its own expected version).
5. If an RPC key was rotated, keep the old key until rollback is complete, then revoke it.

## Actions requiring your account access

1. Open the host dashboard and set or update the environment variables listed above.
2. Open the RPC provider dashboard and create or revoke RPC keys.
3. `verify402-mcp@1.0.9` is published on npm and is `latest`; do not republish it. Future changes require a new patch version and a fresh release gate. Do not move the `mcp-v1.0.9` tag onto later commits.
