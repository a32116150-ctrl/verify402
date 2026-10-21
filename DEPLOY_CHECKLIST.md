# verify402 — Deploy Checklist

Use this before every production deploy. It is a gate, not a suggestion.

## 1. Secret rotation (do this first if logs are older than the redaction change)

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

## 2. Pre-deploy verification

- [ ] `npm test` passes.
- [ ] `npm run test:counts` prints the expected offline/RPC split for this commit.
- [ ] `node test/log-redaction.test.mjs` passes and prints no `SECRETKEY123` or `SECRETKEY456`.
- [ ] `git status --short` is clean after the test run.
- [ ] The deploy environment has no `BYPASS_PAYMENT=1`.
- [ ] `X402_MODE` and `FACILITATOR_URL` are the intended production values.
- [ ] `/ready` returns 200 against the deployed instance.
- [ ] A paid request returns a typed response and a settlement, or the route is deliberately disabled.

## 3. Post-deploy log check

- [ ] Trigger one deliberate RPC failure against a test endpoint, or inspect the first real 503.
- [ ] Grep the new log lines for `http://`, `https://`, `apikey`, `authorization`, `x-payment`, and `x-idempotency-key`.
- [ ] Confirm every URL is `scheme://host/***` and every sensitive value is `[REDACTED]` or `idem:<8 hex>`.
- [ ] If a full URL or key appears, roll back, rotate the key, and fix the logger before serving paid traffic.

## 4. Rollback

- [ ] Keep the previous commit and environment values available.
- [ ] Rolling back the redaction change does not un-expose old logs; rotation is still required.
