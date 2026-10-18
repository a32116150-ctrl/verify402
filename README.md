# verify402

A machine-payable truth service for AI agents. Two questions an agent cannot
answer honestly by itself:

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

`mcp-bridge/` exposes the paid endpoints as native MCP tools
(`verify_arbitrage`, `check_token_safety`) for Claude Desktop, OpenCode, or any
MCP client, paying per call via x402 with a hard pre-sign spend cap
(`MAX_PAYMENT_USD`, default $0.25). See `mcp-bridge/README.md`.

## Settlement, response delivery, and recovery (honest contract)

- **Delivery:** the verdict is returned inside the settlement response — the paid answer
  arrives together with the payment confirmation (testnet receipt: tx
  `0x11121007bafec47f132763f42e2f58af6ebba7fba9c7ed1b5980d3f595a9324a`).
- **Recovery — implemented (`x-idempotency-key`):** send the header on the FIRST call of an
  operation. If the response is lost after settlement, retrying with the same key within
  10 minutes (max 3 replays) returns the SAME verdict without requiring payment again.
  Caveats, stated plainly: the key is the caller's secret (whoever presents it replays for
  free), the window is short by design so the 402 paywall stays intact, and the replayed
  response includes `recovery: { replayed: true, responseHash, replays }`.
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
