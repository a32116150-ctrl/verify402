# Staging reproduction: `503 payment_unresolved` (x402#4293)

A public, live reproduction of the 503 path for x402-foundation/x402#4293.
It runs on a **separate testnet instance**, never on production. The mainnet
process refuses to start with either fault switch set.

## Why two faults are needed

A SIGKILL alone does not produce a 503. After a restart, if the rail can be
read, reconciliation resolves the record either way (promote and replay, or
proven not-settled past `validBefore`). `503 payment_unresolved` appears only
when a settlement was dispatched **and** the rail cannot be read, after at least
three failed reconciliations spanning five minutes, past the five-minute stage
window (`IDEMPOTENCY_STAGE_TTL_MS`).

So the run injects both:

1. `VERIFY402_CRASH_AT=promote:before`: the process dies after the facilitator
   settled the payment, before the result is written. The durable row holds a
   `settling` marker with `settleOutcome: "unknown"`.
2. `VERIFY402_STAGING_RAIL_FAULT=1`: every reconciliation read of the rail
   (EIP-3009 `authorizationState`) throws, so neither side can be proven.

## Instance

- `X402_MODE` unset (testnet: Base Sepolia, `eip155:84532`).
- Its own `RECOVERY_DB_PATH` on a persistent disk, its own port and hostname.
  Never share the production database file.
- Same build as production.

## Run

```sh
# Phase A: one paid call that settles, then the process dies before promote.
VERIFY402_CRASH_AT=promote:before RECOVERY_DB_PATH=/srv/v402-staging/recovery.sqlite PORT=8402 node src/server.mjs
#   caller: POST /verify with x-idempotency-key: <KEY>, pays testnet USDC
#   -> process SIGKILLs itself after settlement; the caller's response is lost

# Phase B: restart over the same database with the rail read failing.
VERIFY402_STAGING_RAIL_FAULT=1 RECOVERY_DB_PATH=/srv/v402-staging/recovery.sqlite PORT=8402 node src/server.mjs
```

Then the caller retries with the **same key and the same payment**:

| When | Expected answer |
|---|---|
| Within 5 min of staging | `409 operation_in_flight`, `Retry-After: 1`, `retry: same_payment` |
| Past 5 min, fewer than 3 failed reconciliations or under 5 min of failures | still `409` (transient failure can still resolve) |
| Past 5 min, 3+ failures spanning 5+ min | `503 payment_unresolved`, **no** `Retry-After`, typed reason naming the rail failure, `retry: same_payment` |

Retry about once a minute for at least ten minutes. Each retry starts one
reconciliation attempt (this needs the fix in the Unreleased changelog entry:
before it, only the first failure counted and the key stayed at 409).

## What to capture and post

- Each response verbatim (status, `Retry-After`, body).
- The settlement transaction on Base Sepolia (proves the payment landed once).
- The payer balance before and after (exactly one charge).
- `/info` → `recovery.observability.stuck` before and after.
- The `ALARM recovery stuck` log line.

## Afterwards

Stop the instance, unset both switches, and keep the database file for the
record. Tests covering this path: `test/recovery.test.mjs` (staging rail fault
escalation) and `test/recovery-durable.test.mjs` (mainnet refuses both
switches).
