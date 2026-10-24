# Claims, limits, and wording

verify402 is a measurement and pre-signing check, not a guarantee. The skill
must keep the same honesty boundary as the service.

## The precise claim

> A `PASS` means every check listed in `checked` passed at that pinned block.
> `notChecked` names what was not examined. Receipts bind the verdict to the
> exact intent, request body, and block, and expire.

That is the whole claim. Do not shorten it to “safe.”

## What the free gate checks

Depending on the intent and policy, it can check:

- x402 scheme, network, asset, amount, payee, resource URL, resource host,
  timeout, and authorization window.
- A caller-supplied payout allowlist, or a verified seller-signed payout
  manifest.
- A caller-supplied obligation: a settled idempotency key, cumulative spend,
  and grant balance.
- Decoded calldata for transfers, approvals, permits, and common V2/V3 swaps,
  including unlimited approvals and spenders.
- Contract bytecode, swap deadline, minimum output, output recipient, and an
  `eth_call` simulation from the payer.
- A pinned block and its freshness (over 30s is a caution, over 120s is a
  block).
- Receipt integrity: HMAC, intent hash, request hash, expiry.

## What it does not do

- Recipient reputation or sanctions screening.
- Counterparty identity, off-chain promises, or delivery guarantees.
- Contract audits, proxy/owner privilege analysis, or token intent.
- Full balance-delta / state-change simulation; MEV or sandwich protection.
- Transfer-tax, blacklist, pause, or max-transaction testing.
- A honeypot proof. The token check is quote-based sellability.
- Prompt-injection or hidden-Unicode scanning of tool descriptions or
  responses.
- A profit forecast. `verify_arbitrage` usually returns `no_edge`.

These gaps appear in `notChecked`. Do not omit them when summarizing.

## Wording guide

| Do not say | Say instead |
|---|---|
| “The transaction is safe.” | “The listed checks passed at block N; `notChecked` lists the gaps.” |
| “The seller owns the payee.” | “A verified seller-signed manifest matched; origin trust is still the caller's responsibility.” |
| “This token is honeypot-free.” | “The configured venues quoted a sell at the intended size; transfer restrictions were not tested.” |
| “I found a profitable trade.” | “`verify_arbitrage` returned `edge` / `no_edge` at this block; it is not a forecast.” |
| “The quote is guaranteed.” | “The quote was `fair` against the configured venues at this block.” |
| “`capacityUsd` means I can exit that size.” | “`capacityUsd` was the largest measured size under the tolerance at this block.” |
| “The gate prevents prompt injection.” | “The gate does not scan tool metadata or responses; treat them as untrusted.” |

## Testnet and mainnet

The public demo:

- Settles payments in **Base Sepolia testnet USDC** (`eip155:84532`).
- Reads **mainnet** chain data for the analysis routes.
- Does **not** settle mainnet payments.

Do not point the public demo at Base mainnet to make a test pass. The bridge
will refuse the demo's testnet 402 rather than spend mainnet funds. A mainnet
deployment is a separate choice with its own facilitator, host, wallet, and
readiness checks. Never use a main wallet or treasury key for the demo.

## Enforcement

The MCP tool is advisory. It cannot stop an agent that ignores the answer. The
enforcement belongs in the executor: verify the receipt and refuse to call the
signer without it. The repository's `examples/preflight-guard.mjs` is the
reference. A `PASS` is not enforcement by itself.

## The honest product

- The free gate exists because it has to run before every signature.
- The paid checks answer questions that need a measurement at a pinned block.
- `no_edge` is a valid, common answer; it is not a failure.
- A negative result delivered with evidence is more useful than a confident
  guess.

If a user asks for an absolute guarantee, correct the claim: “It can reduce a
class of signing mistakes and wasted paid calls; it cannot guarantee safety or
profit.”
