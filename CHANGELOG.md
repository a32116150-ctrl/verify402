# Changelog

All notable changes to verify402. This file records repository changes; it does
not imply a deploy or an npm publish.

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

### `verify402-mcp` version recommendation

**Recommend a patch bump from `1.0.3` to `1.0.4` when publishing is approved.**
Do not publish in this hotfix.

Why a patch:

- The change is backward compatible: no MCP tool names, inputs, or existing
  response fields were removed.
- It fixes retry/recovery behavior and adds the missing `paid-call.mjs` package
  file. `1.0.3` is already published and must not be overwritten.
- A minor or major version would suggest a new tool surface or a breaking
  contract change, and there is neither.

No npm publish and no deploy were performed for this entry.
