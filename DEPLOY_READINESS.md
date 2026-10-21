# Deploy Readiness Report

## Verified offline

- `npm test` passed: offline suite, RPC suite, discovery tests, discovery script, env-example test, claims test, smoke offline tests.
- `npm run test:offline` passed; only the 12 RPC-dependent tests were skipped.
- `npm run test:counts` reports `TOTAL 197 185 12`.
- Idempotency TTL, preflight limits, prices, health/ready shapes, and banned claims are checked across OpenAPI, manifest, and runtime constants.
- Security headers, CORS behavior, graceful shutdown, and startup guards are covered by automated tests.
- MCP package dry-run includes `paid-call.mjs` and every import of `index.mjs`.

## Verified only after deploy

- Live `/ready` chain read latency and block freshness.
- Real RPC provider behavior under production traffic.
- Live document consistency across `/info`, `/openapi.json`, `/.well-known/verify402.json`, `/.well-known/x402`, and `/llms.txt`.
- Live security headers and absence of `x-powered-by` on the deployed host/CDN.
- Optional one real paid call with `SMOKE_PAID=1` on a testnet target only.

Run after deploy:

```sh
SMOKE_BASE_URL=<url> npm run post-deploy
```

Paste the full output to the reviewer.

## Host environment variables

Required in mainnet:

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
4. Run `SMOKE_BASE_URL=<url> npm run post-deploy`.
5. If an RPC key was rotated, keep the old key until rollback is complete, then revoke it.

## Actions requiring your account access

1. Open the host dashboard and set or update the environment variables listed above.
2. Open the RPC provider dashboard and create or revoke RPC keys.
3. Run `npm login` and publish `verify402-mcp` only after explicitly approving the recommended `1.0.3` to `1.0.4` patch bump.
