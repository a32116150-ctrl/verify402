# verify402

A machine-payable truth service: **AI agents pay per call, via x402, to find out
whether an arbitrage opportunity is real.**

`POST /verify` measures a cross-venue round trip (buy `target` with `base` on the
best venue, sell it back on the best venue) at one pinned block, nets off flash-loan
premium and gas, and returns a verdict with full evidence. Payment is a flat $0.05
per call in USDC, on Base or Solana — no account, no API key.

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
| `GET /info` | free | machine-readable service description |
| `GET /health` | free | liveness |

Request:

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

A request without payment gets `402Payment Required` with instructions in the
`PAYMENT-REQUIRED` header; the client pays and retries with proof — that is the
entire x402 flow, and it is what makes the caller a program rather than a person.

## Honesty

- No profit is promised. The measured answer for mainstream pairs is almost always
  `no_edge` — that is the market's fee boundary, not a failure of the tool.
- The service reports what it measured, not what it guarantees.
- Not financial advice.
