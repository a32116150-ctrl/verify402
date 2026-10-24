# The five paid checks

These are the paid verify402 tools exposed by the MCP bridge. They use x402:
the bridge pays per call from its configured wallet. They are not a
subscription, and they do not sign or send a trade.

**Public demo:** payments are Base Sepolia testnet USDC (`eip155:84532`). The
analysis reads mainnet chain data. Mainnet settlement is a separate deployment
choice, not the demo default.

**Free-only install:** without `EVM_PRIVATE_KEY`, only `preflight_gate` is
registered. Do not promise paid results when the wallet is not configured.

## Use order

1. `preflight_gate` — always, before any signature or payment.
2. `check_token_safety` — before buying an unknown token.
3. `verify_quote_fairness` — before accepting a quote you did not produce.
4. `get_best_route` — before swapping, to see what the configured venues pay.
5. `get_trade_depth` — before choosing a position size.
6. `verify_arbitrage` — only when someone claims an arbitrage opportunity.

This order is a guide, not a ritual. One call per decision is usually enough.
Quotes are pinned to one block; a result is not “current” later.

## `check_token_safety` — $0.10

**Question:** Can this token be sold at a realistic size on the configured
venues, and what does the round trip cost?

**Input**

```json
{
  "chainId": 8453,
  "tokenAddress": "0xTokenOrKnownSymbol",
  "intendedUsd": 500,
  "offeredPriceUsd": 0.00042
}
```

`offeredPriceUsd` is optional. Use it when someone offered you a price.

**Output**

- `verdict`: `TRUST`, `CAUTION`, or `AVOID`.
- Contract facts from the live chain.
- Market liquidity and scam signals.
- A USD-sized sell **quoted** through the configured venues' own routers,
  direct and WETH-routed.
- Round-trip cost at the intended size.
- Phantom-price detection.
- `notChecked`: transfer tax, blacklist, pause, max-tx restrictions,
  unconfigured venues, and other gaps.

**Use it when:** you are about to buy an unknown token, or a user asks whether
a token is sellable.

**Do not claim:** “honeypot-free,” “safe,” “transfer-tested,” or “audited.” The
check quotes a sell; it does not execute a transfer or audit the contract.

## `verify_quote_fairness` — $0.05

**Question:** Is a quote someone else gave me fair, or is it overpaying or
invented?

**Input**

```json
{
  "chainId": 8453,
  "tokenIn": "USDC",
  "tokenOut": "WETH",
  "amountIn": "5000000000",
  "quotedOut": "1740000000000000000",
  "venueClaimed": "some-aggregator"
}
```

`amountIn` and `quotedOut` are raw units as strings. `venueClaimed` is optional.

**Output**

- `verdict`: `fair`, `overpaying`, `too_good_to_be_true`, or `unknown`.
- The configured-venue book at one pinned block as evidence.
- `notChecked` for venues and conditions not covered.

**Use it when:** a bot, broker, aggregator, or another agent gives you a swap
number you did not produce yourself.

**Do not claim:** that `fair` guarantees execution or that a quote is safe.
`too_good_to_be_true` means the chain does not support the number; it is a
warning, not free money.

## `get_best_route` — $0.03

**Question:** What would the chain actually pay for this swap across the
configured venues?

**Input**

```json
{
  "chainId": 8453,
  "tokenIn": "USDC",
  "tokenOut": "WETH",
  "amountIn": "2000000000"
}
```

`amountIn` is raw units of `tokenIn`, as a string.

**Output**

- The full book from every configured venue, direct and WETH-routed, at one
  pinned block.
- Best route first, with quoted output.

**Use it when:** you need a route or a realistic payout before a swap.

**Do not claim:** that it includes every DEX or aggregator. Unconfigured venues
are not included.

## `get_trade_depth` — $0.05

**Question:** How big can I trade before the round trip eats me?

**Input**

```json
{
  "chainId": 8453,
  "tokenAddress": "0xTokenOrKnownSymbol",
  "baseSymbol": "USDC",
  "sizesUsd": [100, 1000, 10000, 100000],
  "maxRoundTripPct": 1.0
}
```

`sizesUsd` is capped at 6 rungs. Defaults are `[100, 1000, 10000, 100000]` and
`1.0` percent.

**Output**

- A ladder of per-size entry and exit quotes.
- Per-size impact percent and round-trip cost percent.
- `capacityUsd`: the largest size under `maxRoundTripPct`.
- `underTolerance` per rung.

**Use it when:** you are choosing a position size, not just a route.

**Do not claim:** that `capacityUsd` guarantees an exit. It is the largest
measured size under the tolerance at that block.

## `verify_arbitrage` — $0.05

**Question:** Is a claimed cross-venue arbitrage opportunity real right now?

**Input**

```json
{
  "chainId": 1,
  "target": "WETH",
  "base": "USDC",
  "size": 100000
}
```

`chainId` is required. `target` is the token to buy and sell back. `base`
defaults to USDC. `size` is in whole base units.

**Output**

- `verdict`: `edge`, `no_edge`, or `no_edge_costs_ate_it`.
- Buy and sell venue quotes at one pinned block.
- Gross, costs (gas and flash-loan premium), and net.
- `method` and `caveats`.

**Use it when:** someone claims an arbitrage. `no_edge` is the most common
honest answer; it is not a failure. Do not call it repeatedly hoping for a
different result.

**Do not claim:** that you found a profitable trade, or that a positive net at
one block is executable after latency, competition, or MEV.

## Spend controls

The MCP bridge enforces these before a payment signature:

- `MAX_PAYMENT_USD` — hard cap on one payment (default `0.25`).
- `MAX_DAILY_USD` — optional UTC-day cap, persisted in a small ledger.
- `VERIFY402_NETWORKS` — network allowlist (public demo: `eip155:84532`).
- `VERIFY402_PAY_TO` — the payee the 402 must name.
- `VERIFY402_RESOURCE_PREFIX` — the resource prefix the 402 must match.

A 402 that names another network, payee, resource, or a higher amount is
refused before a signature exists. The bridge signs the payment only; it never
signs or sends a trade.

Never use a main wallet or a treasury key. For the public demo, use a dedicated
wallet holding only testnet USDC. Do not switch to mainnet to make a test pass;
the bridge will fail closed against the demo's testnet 402.

## Failure behavior

- A `503` means transport or decode failure: no verdict, no settlement. Inspect
  before retrying; do not blindly pay twice.
- A paid route can return `ok: false` with a market fact such as `no_pool` or a
  revert. That is a result, not a transport failure; read the reason.
- If the bridge says the wallet is not configured, the paid tool is not
  available. Do not fabricate a result.
- If the daily cap is reached, stop. Do not rotate wallets to evade the cap.
