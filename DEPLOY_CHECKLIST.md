# verify402 — Deploy Checklist

Rule: X402_MODE=testnet only on free instances. Mainnet requires an always-on paid instance.

Use this before every production deploy. It is a gate, not a suggestion. No step
in this file performs a deploy by itself.

## 1. Secret rotation (do this first if logs predate the redaction change)

- [ ] **Rotate every RPC provider key that may have appeared in previous logs.** Before the central redaction layer, a viem `HttpRequestError` could write the full RPC URL to stdout/stderr. If any configured endpoint used a key in the path, query string, or basic-auth userinfo, treat that key as exposed.
- [ ] Rotate the provider key in the provider's dashboard, then update `ETH_RPC_URL`, `ARB_RPC_URL`, and `BASE_RPC_URL` in the deploy environment.
- [ ] Do not paste the new URL into chat, an issue, a commit, or a test. Set it only in the hosting provider's secret store.
- [ ] Confirm the new URL is accepted by the provider before restarting the service.
- [ ] If logs were shipped to a third-party log service, purge or restrict access to the old log window. Redaction only protects new lines.

Current logging contract:

- URLs are logged as `scheme://host/***`; path, query, and userinfo are removed.
- `x-payment`, `payment-signature`, `authorization`, `x-api-key`, and similar headers are logged as `[REDACTED]`.
- API keys, passwords, tokens, and private keys in log metadata are `[REDACTED]`.
- Idempotency keys are logged only as `idem:<8-char SHA-256 prefix>`.
- Raw viem/`HttpRequestError` objects and stacks are formatted through the redaction layer; they are never passed to `console.*` unchanged.

## 2. Free host (testnet only): exact environment

This demo uses a Render free instance. Free instances spin down after about 15
minutes idle, can take about a minute to wake, can restart at any time, and have
an ephemeral filesystem. Recovery records and `/usage` counters are in memory and
are lost on restart. X402_MODE=testnet only on free; mainnet requires an
always-on paid instance. Do not horizontally scale a single deploy while recovery
and `/usage` are process-local; if you do, use sticky routing and accept that a
restart loses both.

### Testnet instance (use this for the paid smoke test)

| Variable | Required | Value / note |
|---|---|---|
| `X402_MODE` | yes | `testnet` |
| `FACILITATOR_URL` | yes | `https://x402.org/facilitator` for testnet |
| `AGENT_URL` | recommended | Canonical public origin, e.g. `https://verify402-testnet.example`; it wins over `Host` |
| `TRUSTED_HOSTS` | optional | Comma-separated hostnames allowed when `AGENT_URL` is unset; defaults include `verify402.onrender.com`, `localhost`, `127.0.0.1`, `::1` |
| `PREFLIGHT_SECRET` | strongly recommended | 32-byte hex, e.g. `openssl rand -hex 32`; without it receipts use a per-process key |
| `PAY_TO_EVM`, `PAY_TO_SVM` | yes | Testnet receiving wallets |
| `ETH_RPC_URL`, `ARB_RPC_URL`, `BASE_RPC_URL` | recommended | Dedicated provider endpoints; public defaults throttle |
| `READY_CHAIN_ID` | optional | Default `1`; must be a configured chain |
| `PORT` | host-provided | Do not hardcode if the platform injects it |
| `SHUTDOWN_TIMEOUT_MS` | optional | Default `10000`; keep it below the platform's termination grace period |

### Mainnet instance (paid, always-on)

| Variable | Required | Value / note |
|---|---|---|
| `X402_MODE` | yes | `mainnet` |
| `FACILITATOR_URL` | yes | Mainnet facilitator, e.g. `https://api.cdp.coinbase.com/platform/v2/x402` or a keyless mainnet facilitator |
| `AGENT_URL` | yes | Canonical `https://` origin with no credentials, query, or fragment. Startup fails without it. |
| `PREFLIGHT_SECRET` | yes | 32-byte hex, e.g. `openssl rand -hex 32`. Startup fails without it. |
| `PAY_TO_EVM`, `PAY_TO_SVM` | yes | Mainnet receiving wallets |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | only for CDP | Required when `FACILITATOR_URL` points at the CDP facilitator |
| `ETH_RPC_URL`, `ARB_RPC_URL`, `BASE_RPC_URL` | strongly recommended | Dedicated provider endpoints |
| `READY_CHAIN_ID` | optional | Default `1` |
| `PORT` | host-provided | Do not hardcode if the platform injects it |
| `SHUTDOWN_TIMEOUT_MS` | optional | Default `10000`; keep it below the platform's termination grace period |
| `PRICE`, `SAFETY_PRICE`, `ROUTE_PRICE`, `QUOTECHECK_PRICE`, `DEPTH_PRICE` | optional | Leave unset to use the defaults in `src/contract.mjs`; the 402 challenge is authoritative |

Never set any of these in a paid deploy:

- `BYPASS_PAYMENT=1` (unprotected paid routes; the server refuses mainnet).
- `TEST_OFFLINE=1`, `TEST_RPC_ONLY=1`, or `TEST_OFFLINE_RPC_URL` (test harness only).
- `SMOKE_PAID`, `SMOKE_BASE_URL`, or `EVM_PRIVATE_KEY` (operator-side smoke only; the buyer key must never live in the server environment).

## 3. Pre-deploy verification

- [ ] Record the deploy commit: `git rev-parse HEAD`.
- [ ] `git status --short` is clean.
- [ ] `npm test` exits 0.
- [ ] `npm run test:offline` exits 0.
- [ ] `npm run test:counts` exits 0 and prints the per-file offline/RPC split. Do not copy a fixed count into a document.
- [ ] `node test/log-redaction.test.mjs` passes and prints no `SECRETKEY123` or `SECRETKEY456`.
- [ ] The deploy environment has no `BYPASS_PAYMENT`.
- [ ] `X402_MODE` and `FACILITATOR_URL` are the intended values.
- [ ] `AGENT_URL` is the canonical origin, not the request Host.
- [ ] `PREFLIGHT_SECRET` is present in mainnet, and its value is not in the repository or logs.
- [ ] The host health check points at `/health`; traffic admission uses `/ready`.
- [ ] The previous deploy is still available in the hosting dashboard for rollback.

## 4. Deploy (operator action; not part of this repository task)

1. Deploy the recorded commit to the Render free instance (testnet only).
2. Wait for the platform to report the instance healthy.
3. Confirm the process logs `verify402 listening` and no startup refusal.
4. Run the smoke test in §5 against the deployed origin.
5. If smoke fails, use §6. Do not leave a failed instance receiving paid traffic.

## 5. Post-deploy smoke test

The script is `scripts/smoke.mjs` (`npm run smoke`). It always checks `/health`,
`/ready`, a free preflight call, and `/preflight/verify` with the returned
receipt. `SMOKE_PAID=1` additionally buys exactly one `/route` answer on a
**testnet** instance and refuses to run against mainnet.

Free checks:

```bash
SMOKE_BASE_URL=https://<testnet-or-mainnet-host> npm run smoke
```

Expected output ends with `smoke: PASS`. It verifies:

- `/health` returns `ok: true`;
- `/ready` returns 200, `ok: true`, `ready: true`, an integer chain ID and block;
- `POST /preflight` returns a three-state verdict, a receipt, and `checked`/`notChecked`;
- `POST /preflight/verify` accepts the receipt it just issued.

One paid testnet call:

```bash
# Buyer key stays in the operator shell or a non-committed local env file.
SMOKE_BASE_URL=https://<testnet-host> SMOKE_PAID=1 MAX_PAYMENT_USD=0.03 npm run smoke
```

Requirements:

- The target `/health` must report `mode: "testnet"`; the script aborts otherwise.
- `EVM_PRIVATE_KEY` must be set for a buyer wallet holding Base Sepolia USDC.
- `MAX_PAYMENT_USD` must cover the configured `/route` price (default cap in the
  smoke script is `0.03`).
- The paid call prints the settlement receipt. Verify the buyer debit and seller
  credit on the testnet explorer before declaring the deploy good.

Do not point `SMOKE_PAID=1` at mainnet. The first real mainnet payment is a
separate, explicit operator decision.

## 6. Rollback

1. Stop sending new paid traffic to the instance (remove it from the host's
   traffic pool or scale it to zero).
2. In the hosting dashboard, roll back to the previous deploy ID/commit. If the
   host cannot roll back, redeploy the previous recorded commit; do not
   `git reset --hard` a shared branch.
3. Do not roll back past `001fd08` while paid routes are public: that commit and
   its successors fix the C-1 free-replay path and C-2 failure classification.
4. There is no database migration to reverse. The measurement cache, recovery
   records, and `/usage` counters are process-local; both the failed deploy and
   the rollback discard them.
5. Expect paid recovery keys and usage counts to reset on both the failed
   deploy and the rollback. A caller whose response was lost may be charged
   again; keep the TTL short and tell affected callers.
6. Run `SMOKE_BASE_URL=https://<host> npm run smoke`. If rollback is to a
   testnet instance and a paid check is required, run the `SMOKE_PAID=1` form.
7. If the incident involved a leaked log line, rotate the affected key even
   after rollback. Rolling back code does not un-expose old logs.
8. Record the failed commit, the restored commit, the smoke result, and the
   customer-visible recovery window in the incident note.

## 7. Post-deploy log check

- [ ] Trigger one deliberate RPC failure against a test endpoint, or inspect the first real 503.
- [ ] Grep the new log lines for `http://`, `https://`, `apikey`, `authorization`, `x-payment`, and `x-idempotency-key`.
- [ ] Confirm every URL is `scheme://host/***` and every sensitive value is `[REDACTED]` or `idem:<8 hex>`.
- [ ] Confirm no `x-powered-by` header is present.
- [ ] Confirm paid responses and 402 challenges carry no `access-control-allow-origin`.
- [ ] If a full URL or key appears, stop paid traffic, roll back, rotate the key, and fix the logger before serving again.

## Post-deploy verification

- Run `SMOKE_BASE_URL=<url> npm run post-deploy` and paste the full output to the reviewer.
