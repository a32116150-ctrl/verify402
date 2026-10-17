# Outreach copy - copy-paste, in this order.

Every post follows the same rule: the hook is that the service's most common
answer is "no, this has no edge" - and it sells that answer. No profit
promises anywhere. The credibility IS the negative result.

## 1. x402 Slack (`https://slack.x402.org`, join → post in showcase channel)

**Show & tell:**
> Built a first version of an x402 service agents can actually use more than
> once: **verify402** — a per-call oracle for two questions agents routinely
> guess at:
>
> - `verify_arbitrage` ($0.05): is this claimed cross-venue arb real *right
>   now*? Pinned-block quotes from Uniswap's QuoterV2 + each router's own
>   math, flash-loan premium and gas netted. The honest answer is usually
>   `no_edge` — that's the product.
> - `check_token_safety` ($0.10): pre-trade gate before buying any token —
>   TRUST/CAUTION/AVOID with evidence: live contract calls, a USD-sized sell
>   probe against every venue (honeypot test done by actually quoting the
>   exit), round-trip cost at the intended size, phantom-price detection.
>
> Free endpoints to evaluate it without paying: `/findings` (live verdicts on
> ETH majors, always `no_edge`, fully reproducible against the venues'
> own routers), `/.well-known/agent-registration.json`, `/info`.
> MCP bridge included so it drops into Claude/OO/any MCP client.
> Headers carry the bazaar schema. Would love harsh feedback.

## 2. Hacker News — "Show HN" (news.ycombinator.com/submit)

**Title:**
> Show HN: An AI agent pays $0.05 per call to find out if an arbitrage is real

**Text:**
> Hi HN. We built verify402 — an HTTP API where an AI agent pays per call
> (x402 protocol, USDC on Base/Solana, no API key, no signup) to ask two
> questions that agents currently guess at:
>
> 1. Is this arbitrage opportunity real right now?
> 2. Is this token safe to buy?
>
> The measurement discipline is the product. Arb verdicts come from pinned-
> block quotes: Uniswap's canonical QuoterV2 for V3, each router's own
> getAmountsOut for V2, flash-loan premium and gas netted. Safety verdicts
> are a pre-trade gate: contract facts from the live chain, market liquidity
> and sell-share, a USD-sized sell probe against every venue (honeypot means
> "cannot be exited", so we ask the chain by quoting the exit — not a flag or
> a score), a round-trip cost at the agent's intended size, and phantom-price
> detection vs chain consensus.
>
> The honest finding: on mainstream pairs the answer is almost always
> `no_edge`. That is deliberate. Preceding versions of our tooling were the
> thing being measured — they found 6.2M USDC of "profit" on a pool holding
> $285K, and 17,774 USDC on a 100 USDC loan, both bugs documented in the kit.
> A quote is only trustworthy if it agrees with the venue that would execute
> it. We publish the evidence with every response.
>
> Free: `/findings` (live majors, always no_edge), `/info`,
> `/.well-known/agent-registration.json`. Paid: $0.05/verify, $0.10/safety.
> MCP tools included.

## 3. r/ethdev

**Title:**
> I measured the "arbitrage opportunities" a trading agent would act on. Verdict: [verifiable no_edge]. Built a per-call service that does the checking so agents stop guessing.

**Body:** HN text + one concrete payload example from `/verify` and one from
`/safety`, and an explicit "happy to hear why an edge survives my measurement"
— the correction-seeking tone is what survives r/ethdev's cynicism.

## 4. X thread (3 posts)

1. > Agents act on arbitrage claims they can't verify. We made a service
   > where an agent pays $0.05 per call to find out if the claim is real —
   > measured, not asserted. The answer is almost always no_edge.
   > Selling "no" on-chain is the whole idea. (x402, USDC, no keys)

2. > The more useful tool agents need before every swap:
   > check_token_safety. TRUST/CAUTION/AVOID + evidence: real contract
   > facts, $25-sized sell probe across 10+ venues (honeypot = can't exit —
   > quoted, not scored), round-trip cost, phantom-price check. $0.10.

3. > Everything reproducible: /findings is free and always no_edge on ETH
   > majors — every number checkable against Uniswap's QuoterV2 and each
   > router's own math. MCP tools + x402 headers included. URL next post.

## Rules for whichever you post

- Never add guaranteed/implied profit language. The negative result is the brand.
- Post where the audience is builders (HN, r/ethdev, x402 slack), not traders.
- Answer every reply — 90% of Show HN traction is the comment feed, first hour.
