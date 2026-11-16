# Recovery audit

An implementation-level check of the settlement recovery path, in the same
spirit as the independent audit that shaped spec 0.5/0.6 of the recovery
extension: reproduce the failure modes, not just read the code.

Two things are exercised:

1. **Concurrency** — three copies of one signed payment, against the real
   `@x402/express` middleware and a fake facilitator.
2. **Crash matrix** — a real process is SIGKILLed at each durable write, before
   or after SQLite commits it, then a fresh process reopens the same database
   and answers the caller's retry.

Run it:

```sh
npm run audit:recovery
```

## 1. Concurrency

| Setup | Handler runs | Settle attempts | Responses |
|---|---|---|---|
| SDK alone (control) | 3 | 3 | 1×200, 2×402 `nonce_already_used` |
| With the pre-handler claim | 1 | 1 | 1×200, 2×409 `operation_in_flight` |

The control is the bug: the losers paid attention only after the work was done,
and they received a fresh payment challenge — an invitation to sign a second
authorization. The claim moves the decision before the handler and answers 409,
which cannot be mistaken for "pay again".

`test/recovery-concurrency.test.mjs` runs both rows on every push.

## 2. Crash matrix

Each row kills the process at the named write and restarts over the same
database. `charge` counts the simulated facilitator settlement; `state` is what
the caller's retry sees.

| Kill point | Charge | State after restart | Free replay |
|---|---|---|---|
| stage, before commit | 0 | no record | no |
| stage, after commit | 0 | pending | no |
| promote, before commit (settled on chain, reply lost) | 1 | pending | no |
| promote, after commit | 1 | settled | yes |
| settle hangs, after staging | 0 | pending | no |
| abandon, before commit (definitive failure) | 0 | pending | no |
| abandon, after commit | 0 | no record | no |
| expiry, before tombstone | 1 | settled past TTL | no |
| expiry, before evict | 1 | settled past TTL | no |
| expiry, after evict | 1 | gone | no |

Invariants asserted in every row:

- at most one charge;
- at most one handler run across both processes;
- a free replay only when the settlement was durably promoted;
- a staged record is pending, never replayable;
- a charge always leaves a staged or settled record behind;
- an expired verdict never replays.

`test/recovery-crash.test.mjs` runs the matrix on every push. The kill points
live in `src/recovery-store.mjs` behind `VERIFY402_CRASH_AT`; they are inert
unless the variable names an exact point, and are never set in a deploy.

## Status against extension 0.8 (control 11)

Spec 0.8 added §5.1(7) and control 11: once a settlement attempt is dispatched, the
record and its response must survive `stageTimeoutSeconds` and be resolved by
reconciliation to `delivered`, `void`, or an alarmed `stuck`.

**With the durable store, the recovery half of that is what this code already does**
(and `test/recovery-durable.test.mjs` covers each branch across real process restarts):

- the staged row is journaled before the facilitator call (`recordSettlement`, write-ahead);
- the staging sweep is gated on reconciliation: `entryCanExpire` is true only when the
  record is known **not** to have settled, so the timer cannot delete a paid response;
- a stale staged retry is not re-charged: it triggers `reconcileStagedEntry`, which reads
  EIP-3009 `authorizationState` on the token contract and resolves to `settled`
  (consumed → promoted, replayable), `expired_safe` (past `validBefore`, unconsumed →
  expired, safe to pay again), `pending` (inside the window → stays pending), or
  `stuck` (neither provable → record retained, key blocked, operator alarmed);
- the same pass runs at startup over every staged row (`reconcileStagedOnStartup`).

Spec 0.9 split the two "do not pay again yet" answers, and the implementation now matches
it literally:

- the x402 `onBeforeSettle` hook records `settling` on the operation **before** the
  facilitator call (`markSettling`); in durable mode a write that does not land aborts the
  settlement, and the caller's retry is answered 409 rather than charged twice;
- while the outcome is still resolvable the retry gets `409 operation_in_flight` with a
  short `Retry-After` and `retry: same_payment`;
- once the outcome can be proven on neither side the record becomes `stuck`, an
  operator-visible alarm is logged, and retries get `503 payment_unresolved` with **no**
  `Retry-After`, a named `reason`, and `retry: same_payment`;
- `stuck` and `settling` are counted, and surfaced on `/info.recovery.observability`
  (`unresolved`, `settling`, `stuck`, `stuckTotal`, `unattributedSettles`,
  `reconcilerFailures`). `entryCanExpire` refuses to age out a `settling` or `stuck`
  record in any mode, including the memory-only demo.

A *transient* reconciliation failure is not `stuck`: it stays 409 while a retry can still
resolve, and is escalated only after three failed attempts at least five minutes apart
past the staging window.

**The live instance does not have the guarantee, by construction.** It runs
`recoveryStore: memory-only`: staged state is process-local, a restart loses it, and a
staged record ages out on the timer because there is no store to reconcile against.
Control 11 presumes durable state; the fix is the durable cutover, not more recovery code.

## What this does not prove

- The facilitator and the chain are simulated. The settlement result is a local
  decision, not a Base transaction. The live/testnet behaviour is covered by
  `scripts/post-deploy-check.mjs` and the x402 settlement tests, not here.
- The audit covers the durable store. The live instance currently runs
  `recoveryStore: memory-only`, where a restart loses every record — the
  fail-closed direction (a retry pays again) but without the free replay. The
  durable cutover is tracked in the backlog.
- It is not a substitute for a third-party audit. It is the same class of
  evidence Hitek-cel published for `latch402`, reproduced on this code.
