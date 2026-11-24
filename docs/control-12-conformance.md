# Control-12 conformance — measured against verify402 1.1.1 (2026-11-16)

Source: Hitek-cel's crash-vector set (Detent `conformance/x402-recovery-control12.json`, commit `a50dfc0`, 29 vectors, in the format proposed on x402-foundation/x402#3848). Vendored at `test/fixtures/x402-recovery-control12.json`; methodology in `test/fixtures/control12-scenario.mjs`; runner `test/control-12-vectors.test.mjs`.

The service was exercised with **its own** durable journal (SQLite), its own crash handling, its own restart, its own reconciliation and its own 409/503/200 mapping. Fields compared per vector: `handlerRuns`, `settleCalls`, `charges`, `retryStatus`, `retryReplaysStoredResponse`, `retryAfter`, `state`, `keyBlocked`.

`charges` is compared on **every** readable row, including `unreachable`. In this harness `unreachable` is a fault injected into the *server* rail read, not into the rail itself — the rail's nonce ledger records whether an authorisation was consumed either way (that is what Detent's own harness counts too). Asserting nothing here would fake the only check separating a paid-and-never-delivered operation from one that was never charged.

Invariant held everywhere measured: at most one charge per authorization.

Vector 17 (`settle_result before / unreachable`) intentionally remains a divergence. At that fixture point the journal records only the dispatch marker: the facilitator's result has not been written (`test/fixtures/control12-scenario.mjs`: `settleSent: true, settled: false`). It is therefore indistinguishable from the dispatch-without-result cases in vectors 15/21/25, so the unreadable-rail replay rule applies. A facilitator-reported failure is now journaled as `settleOutcome: "failed"` by the settle-failure hook and is never replayed; that safety case is covered by a dedicated regression test, not by pretending this fixture point knows an outcome it does not contain.

| # | journalWrite | boundary | rail | verdict | differing fields |
|---|---|---|---|---|---|
| 0 | claim | before | not_landed | conform | — |
| 1 | claim | before | unreachable | conform | — |
| 2 | claim | after | not_landed | diverge | handlerRuns: ours=1 vector=0<br>settleCalls: ours=1 vector=0<br>charges: ours=1 vector=0<br>retryStatus: ours=200 vector=402<br>state: ours="delivered" vector="void"<br>keyBlocked: ours=true vector=false |
| 3 | claim | after | unreachable | diverge | handlerRuns: ours=1 vector=0<br>settleCalls: ours=1 vector=0<br>charges: ours=1 vector=0<br>retryStatus: ours=200 vector=402<br>state: ours="delivered" vector="void"<br>keyBlocked: ours=true vector=false |
| 4 | staged | before | not_landed | diverge | handlerRuns: ours=1 vector=0<br>settleCalls: ours=1 vector=0<br>charges: ours=1 vector=0<br>retryStatus: ours=200 vector=402<br>state: ours="delivered" vector="void"<br>keyBlocked: ours=true vector=false |
| 5 | staged | before | unreachable | diverge | handlerRuns: ours=1 vector=0<br>settleCalls: ours=1 vector=0<br>charges: ours=1 vector=0<br>retryStatus: ours=200 vector=402<br>state: ours="delivered" vector="void"<br>keyBlocked: ours=true vector=false |
| 6 | staged | after | not_landed | diverge | handlerRuns: ours=1 vector=0<br>retryStatus: ours=409 vector=402<br>retryAfter: ours="present" vector="absent" |
| 7 | staged | after | unreachable | diverge | handlerRuns: ours=1 vector=0<br>retryStatus: ours=409 vector=402<br>retryAfter: ours="present" vector="absent"<br>state: ours="stuck" vector="void"<br>keyBlocked: ours=true vector=false |
| 8 | response_saved | before | not_landed | diverge | settleCalls: ours=1 vector=0<br>charges: ours=1 vector=0<br>retryStatus: ours=200 vector=402<br>state: ours="delivered" vector="void"<br>keyBlocked: ours=true vector=false |
| 9 | response_saved | before | unreachable | diverge | settleCalls: ours=1 vector=0<br>charges: ours=1 vector=0<br>retryStatus: ours=200 vector=402<br>state: ours="delivered" vector="void"<br>keyBlocked: ours=true vector=false |
| 10 | response_saved | after | not_landed | diverge | retryStatus: ours=409 vector=402<br>retryAfter: ours="present" vector="absent" |
| 11 | response_saved | after | unreachable | diverge | retryStatus: ours=409 vector=402<br>retryAfter: ours="present" vector="absent"<br>state: ours="stuck" vector="void"<br>keyBlocked: ours=true vector=false |
| 12 | settling | before | not_landed | diverge | retryStatus: ours=409 vector=402<br>retryAfter: ours="present" vector="absent" |
| 13 | settling | before | unreachable | diverge | retryStatus: ours=409 vector=402<br>retryAfter: ours="present" vector="absent"<br>state: ours="stuck" vector="void"<br>keyBlocked: ours=true vector=false |
| 14 | settling | after | not_landed | diverge | charges: ours=0 vector=1<br>retryStatus: ours=409 vector=200<br>retryReplaysStoredResponse: ours=false vector=true<br>retryAfter: ours="present" vector="absent"<br>state: ours="void" vector="delivered"<br>keyBlocked: ours=false vector=true |
| 15 | settling | after | unreachable | conform | — |
| 16 | settle_result | before | landed | conform | — |
| 17 | settle_result | before | unreachable | diverge | retryStatus: ours=200 vector=409<br>retryReplaysStoredResponse: ours=true vector=false<br>retryAfter: ours="absent" vector="present"<br>state: ours="delivered" vector="stuck" |
| 18 | settle_result | after | landed | conform | — |
| 19 | settle_result | after | unreachable | conform | — |
| 20 | delivered | before | landed | conform | — |
| 21 | delivered | before | unreachable | conform | — |
| 22 | delivered | after | landed | conform | — |
| 23 | delivered | after | unreachable | conform | — |
| 24 | receipt | before | landed | conform | — |
| 25 | receipt | before | unreachable | conform | — |
| 26 | receipt | after | landed | conform | — |
| 27 | receipt | after | unreachable | conform | — |
| 28 | settle_result | before | not_landed | diverge | settleCalls: ours=1 vector=2<br>charges: ours=0 vector=1<br>retryStatus: ours=409 vector=200<br>retryReplaysStoredResponse: ours=false vector=true<br>retryAfter: ours="present" vector="absent"<br>state: ours="void" vector="delivered"<br>keyBlocked: ours=false vector=true |

Conform 14/29, diverge 15, harness errors 0.

Divergent vectors are findings, not verdicts. Each describes a real property of this implementation (not necessarily a defect) and is listed above with exact field values.
