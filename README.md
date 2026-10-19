# verify402

A machine-payable truth service for AI agents. Before an agent signs anything,
`POST /preflight` is the free gate: it takes an x402 payment request or a chain
transaction and returns `PASS` / `CAUTION` / `BLOCK` with typed reasons, the
checks that actually ran, the checks that did not, and a short-lived receipt
bound to the exact intent and pinned block. It is free because it has to run
before every signature; the deep measurements stay paid.

Once the intent is clear, two questions an agent cannot answer honestly by itself:

1. **"Is this arbitrage opportunity real?"** — `POST /verify` measures a
   cross-venue round trip (buy `target` with `base` on the best venue, sell it
   back on the best venue) at one pinned block, nets off flash-loan premium and
   gas, and returns a verdict with full evidence. $0.05 per call.
2. **"Is this token safe to buy?"** — `POST /safety` is a pre-trade gate the
   agent runs *before* risking capital on any token: live contract facts,
   market liquidity and scam signals, a USD-sized sell probe against every
   venue (the honeypot test, answered by actually quoting the exit — direct
   and WETH-routed), a full round-trip cost at the intended size, and
   phantom-price detection. Returns `TRUST` / `CAUTION` / `AVOID` with the
   evidence. $0.10 per call.

Payment is x402 in USDC, on Base or Solana — no account, no API key.

**Human pages:** [home](https://verify402.onrender.com/) ·
[preflight gate](https://verify402.onrender.com/preflight) ·
[the five checks](https://verify402.onrender.com/checks) ·
[live findings](https://verify402.onrender.com/live) ·
[proof &amp; receipts](https://verify402.onrender.com/proof) ·
[docs](https://verify402.onrender.com/docs) ·
[donate](https://verify402.onrender.com/donate)

## Why an agent would pay for this

Models hallucinate profit. Most arb "opportunities" an LLM surfaces are stale, ignore
fees, or come from a quote that was never checked against the venue that would
execute the trade. This service exists to be the check an agent cannot do itself.

## The measurement discipline

Quotes come from the canonical on-chain sources — **never our own reimplementation
of venue math**:

- V3: Uniswap's deployed `QuoterV2` (its answers are the router's answers by construction)
- V2: each router's own `getAmountsOut`

Both legs are measured against **one block number**, so the round trip reflects a
single instant rather than two prices that never coexisted.

Three bugs were caught by the test suite before this ever served a paid response,
and they are the reason the tests exist:

1. **Invented profit (the big one).** `decodeFunctionResult` on `getAmountsOut` — a
   single declared output, which viem unwraps — was indexed with `decoded[0]`,
   silently grabbing the array's first element: the *input* amount. On the sell leg
   that turned 41 WETH into 41 **trillion** USDC of "profit". Now the decoder finds
   the `uint256[]` structurally and refuses a result equal to the input.
2. **Basis points off by 100x.** −292 USDC on a 100,000 USDC round trip rendered as
   −0.29 bps instead of −29. A rounding trick multiplying by `10_000n` instead of
   `1_000_000n` when keeping two decimals of precision.
3. **Venue that doesn't exist still gets reported.** Started as an unasserted
   assumption; `all configured venues exist on-chain` is now a test.

```bash
node test/measure.test.mjs   # 5 checks, needs a mainnet RPC
```

One check is the headline property: *a 100k USDC round trip on Ethereum must NOT
come out profitable.* If it ever does, the engine is wrong until proven otherwise.

## Run it

```bash
npm install
npm test                              # engine checks (network required)
node src/server.mjs                   # testnet payment mode
BYPASS_PAYMENT=1 node src/server.mjs  # local dev only - loud warning, no billing
X402_MODE=mainnet FACILITATOR_URL=... node src/server.mjs
```

## Endpoints

| Route | Price | What it does |
|---|---|---|
| `POST /preflight` | free | pre-signing gate: validate a payment request or transaction, return PASS / CAUTION / BLOCK + a short-lived receipt |
| `POST /preflight/verify` | free | verify a preflight receipt (HMAC, intent hash, expiry) |
| `POST /verify` | $0.05 (x402) | the measurement, with verdict + evidence |
| `POST /safety` | $0.10 (x402) | pre-trade gate: TRUST / CAUTION / AVOID + evidence |
| `POST /route` | $0.03 (x402) | what would the chain ACTUALLY pay for this swap? best route + every quoted venue |
| `POST /quotecheck` | $0.05 (x402) | audit a quote someone else gave you: fair / overpaying / too_good_to_be_true |
| `POST /depth` | $0.05 (x402) | position sizing: how big can I trade before the round trip eats me? |
| `GET /findings` | free | live no_edge verdicts on Ethereum majors |
| `GET /info` | free | machine-readable service description |
| `GET /health` | free | liveness |

`POST /depth` is the pre-trade sizing question nothing on-chain answers.
Pool-reserve "liquidity: $2.7M" tells an agent nothing about the block it
will actually trade in. The depth engine buys the target with the best route
at each rung of a USD ladder, immediately sells the exact position back, and
reports per-rung impact %, round-trip cost %, and `capacityUsd` — the largest
size that stays under the caller's cost tolerance. Live example (SHIB,
2.5% tolerance): "$2.7M liquidity" resolves to a real capacity of **$1,000**
($100 → 1.20% round trip, $10k → 6.57%). The ladder is the honest answer.

## The preflight gate

`POST /preflight` is the free control an agent runs immediately before signing.
It accepts one of two intents:

- **payment** — an x402 402 challenge: scheme, CAIP-2 network, asset, raw
  amount, `payTo`, resource, timeout, authorization window.
- **transaction** — `chainId`, `to`, `data`, `value`, optional `from`.

Response: `PASS` / `CAUTION` / `BLOCK`, `reasons[]`, `checked[]`,
`notChecked[]`, and a receipt:

```json
{
  "verdict": "CAUTION",
  "sign_allowed": true,
  "requires_ack": true,
  "reasons": [{ "code": "unlimited_approval", "severity": "caution", "message": "..." }],
  "checked": ["scheme", "network", "asset", "amount", "payee", "resource", "payer_balance"],
  "notChecked": ["recipient reputation", "sanctions screening", "off-chain promises"],
  "receipt": {
    "spec": "verify402/preflight-receipt@1",
    "intentHash": "…",
    "blockNumber": 48277717,
    "blockHash": "0x…",
    "expiresAt": "2026-10-19T…Z",
    "signature": "…"
  }
}
```

- The receipt is HMAC-SHA256 signed, bound to the canonical normalized intent,
  a pinned block where the chain is readable, and an expiry (default 90s, max
  300s). `POST /preflight/verify` recomputes it.
- **Fail-closed:** if the chain cannot be read, the endpoint returns `503` and
  no receipt. An executor must refuse to sign without a verifiable receipt.
- **Not checked, on purpose:** recipient reputation, sanctions, contract
  audits, full balance-delta simulation, MEV. They are named in every response
  instead of being implied.
- Free is rate-limited (60/min per IP, 8 concurrent) so it cannot become a
  public RPC proxy.

The MCP bridge exposes it as `preflight_gate`. If `sign_allowed` is false, do
not sign; if `requires_ack` is true, surface the reasons to the operator.

`POST /verify` request:

```json
{ "chainId": 1, "target": "WETH", "base": "USDC", "size": 100000, "minNet": 0 }
```

Response (abridged):

```json
{
  "verdict": "no_edge",
  "blockNumber": 26214368,
  "buy":  { "venue": "uni-v3-0.05%", "amountOutHuman": 41.366 },
  "sell": { "venue": "uni-v3-0.05%", "amountOutHuman": 99707.9 },
  "gross": { "human": -292.08, "bps": -29.23 },
  "net":   { "human": -342.14, "bps": -34.23 },
  "costs": { "flashLoanPremiumBps": 5, "gasUsd": 0.0561 },
  "venues": { "quoted": 12, "buySide": [...], "sellSide": [...], "unavailable": [...] },
  "caveats": ["..."]
}
```

`verdict` is one of `edge` (net cleared `minNet`), `no_edge_costs_ate_it` (gross
positive, costs larger), or `no_edge` (unprofitable before costs).

`POST /safety` request (accepts any ERC-20 address, not just registry symbols):

```json
{ "chainId": 1, "tokenAddress": "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", "intendedUsd": 500 }
```

Response (abridged):

```json
{
  "verdict": "TRUST",
  "checked": ["contract", "market", "sellability", "liquidity"],
  "notes": ["sellable via uni-v3-0.3% via hop, uniswap-v2 via hop, ...",
            "round trip in and out of $500 costs 1.42%"],
  "evidence": { "contract": {...}, "market": {...},
                "sellability": { "canSell": true, "probedInUsd": 25 },
                "liquidity": { "roundTripCostPct": 1.42 } },
  "elapsedMs": 1434
}
```

`verdict` is one of:
- `AVOID` — positively dangerous: cannot be exited at a realistic size, or the
  contract is not a token at all
- `CAUTION` — tradable, but with a stated cost or problem (thin pool,
  manufactured price, expensive round trip)
- `TRUST` — every check passed; still not a promise of profit, only a record
  that nothing measured was wrong

Probes are USD-sized on purpose: an earlier version probed "half a token" and
flagged SHIB — a $1B token — as a honeypot, because half a SHIB is dust no pool
can quote. The test suite and live calls caught that before it launched; every
future verdict change must be explainable, not silent.

A request without payment gets `402Payment Required` with instructions in the
`PAYMENT-REQUIRED` header; the client pays and retries with proof — that is the
entire x402 flow, and it is what makes the caller a program rather than a person.

## Deploying

See `DEPLOY.md` — free-tier container deployment, ERC-8004 identity mint
(`npm run register`, owner's key, on-chain data URI), mainnet facilitator
wiring, and the distribution order.

## MCP: how AI agents consume this

`mcp-bridge/` exposes the free pre-signing gate (`preflight_gate`) and the
paid endpoints as native MCP tools (`verify_arbitrage`, `check_token_safety`,
`get_best_route`, `verify_quote_fairness`, `get_trade_depth`) for Claude
Desktop, OpenCode, or any MCP client, paying per call via x402 with a hard
pre-sign spend cap (`MAX_PAYMENT_USD`, default $0.25). See `mcp-bridge/README.md`.

## Settlement, response delivery, and recovery (honest contract)

- **Delivery:** the verdict is returned inside the settlement response — the paid answer
  arrives together with the payment confirmation (testnet receipt: tx
  `0x11121007bafec47f132763f42e2f58af6ebba7fba9c7ed1b5980d3f595a9324a`).
- **Recovery — implemented (`x-idempotency-key`):** send the header on the FIRST call of an
  operation, minting ONE key per operation (not per retry — though with double-keying even
  fresh ids per retry are protected, see below). If the response is lost after settlement,
  retrying returns the SAME verdict without requiring payment again, under two locks:
  10 minutes (max 3 replays). Caveats stated plainly: the key is the caller's secret
  (whoever presents it replays for free), the window is short by design so the 402 paywall
  stays intact, and replayed responses carry `recovery: { replayed: true, responseHash, replays }`.
  - **Settlement-gated (fail-closed):** a verdict record only becomes replayable
    **after the facilitator confirms the settlement** (official x402 `onAfterSettle`
    hook). Promotion is keyed on a server-generated `operationId` carried in the
    response (`recovery.operationId`, excluded from the projection) and requires a
    confirmed settle result with a non-empty transaction reference; the projection hash
    of the served bytes is an additional check. **Equal output does not identify an
    operation** — two requests that both resolve to `{"verdict":"no_match"}` are still
    distinct, and settling one never promotes the other. A failed, aborted or pending
    settlement promotes nothing. The replay cap (3) is per operation, shared between the
    caller key and the content-hash companion key — two aliases are ONE budget, not two.
  - **Key/scope conflicts (rejected before payment or replay):** a key is bound to one
    operation — its canonical request content plus, when the rail exposes it
    (`payload.authorization.from`), the payer's scope. Presenting the same key with
    **changed request content** or from a **different payer** returns `409 recovery_conflict`
    (`conflict: "request_mismatch" | "scope_mismatch"`) *before* the paywall — never the
    other operation's verdict, never a charge.
  - **Double-keying:** the verdict is recorded under the caller's key *and* an implicit key
    derived from the canonical request content. A caller that mints a fresh id on each retry
    still replays free under the content hash. Two distinct asks that canonicalise identically
    are the same question — sharing one verdict inside the window is determinism, not a bug.
    The companion is a **same-caller** recovery alias, not a public cache: a companion hit is
    only returned to a caller whose declared scope matches the scope recorded at staging.
    Equal content alone is never permission to see another account's result.
  - **After the window (typed, not silent):** expired verdicts leave a tombstone carrying the
    previous `responseHash` for 6 hours. A retry within the tombstone window re-measures with
    the paywall re-armed (there is no free measure after the window — anything else would be a
    loophole), but the response carries `recovery: { remeasured: true, previousResponseHash,
    expiredAt }`, so the calling agent can branch on "this operation was charged before and
    could not be replayed" instead of guessing.
  - **Conformance controls:** `test/recovery.test.mjs` includes the review-requested controls
    — two staged operations with byte-identical output do not cross-promote; promotion is
    refused on failed/pending settle, a missing/empty transaction, or a missing `operationId`;
    same key + changed content or scope is a conflict; a companion requires a matching scope.
- **Evidence bundle — implemented (`verify402/evidence-bundle@1`):** every paid response
  carries `evidence_bundle: { requestHash, responseHash, pinnedBlock, mode, createdAt,
  payment.in }`. Both hashes are sha256 over canonical JSON (keys sorted recursively, no
  whitespace). `requestHash` covers `{ route, body }`; `responseHash` covers the response
  body excluding `evidence_bundle`, `recovery`, `cache`, `elapsedMs`. Reference
  implementation of the canonical form: `src/recovery.mjs` (`canonicalStable`), tests in
  `test/recovery.test.mjs`.
- **Payment caps (bridge/client):** `MAX_PAYMENT_USD` caps one payment at signature time;
  `MAX_DAILY_USD` (optional, `mcp-bridge/budget.mjs`) caps the whole UTC day across
  restarts via a local ledger. Attempted charges are counted before the payment is built —
  a spending guard should over-count, never under-count.

## First paid call, in ten lines

1. `GET  https://verify402.onrender.com/info` — prices, endpoints, recovery contract.
2. `GET  https://verify402.onrender.com/findings` — free verdicts on majors; see the honest `no_edge` baseline.
3. `POST /verify` with your question (`{"chainId":1,"target":"WETH","size":100000}`) and no payment → HTTP 402.
4. Read the payment instructions from the `payment-required` response header.
5. Build an x402 payment for ≤ the stated price (Node example: `mcp-bridge/first-payment.mjs`; MCP users: `mcp-bridge/`).
6. Re-send the same request with the `payment` header. The verdict arrives with the settlement response.
7. On a retry/restart, add `x-idempotency-key: <random-32-hex>` to step 3 so lost responses replay free instead of paying twice.
8. Verify the receipt: `evidence_bundle.responseHash` must equal sha256(canonical JSON of the body minus `evidence_bundle`, `recovery`, `cache`, `elapsedMs`).
9. Cap your own wallet: `MAX_PAYMENT_USD` (per call) and `MAX_DAILY_USD` (per day) in the bridge `.env`.
10. Repeat the call in the same block and compare `evidence_bundle.responseHash` — determinism of the measurement. An `edge` verdict should be raced, not trusted.

## Honesty

- No profit is promised. The measured answer for mainstream pairs is almost always
  `no_edge` — that is the market's fee boundary, not a failure of the tool.
- The service reports what it measured, not what it guarantees.
- Not financial advice.
