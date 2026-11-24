# Support verify402

Honest funding state first, because that is how this project reports everything:
**there is currently no funding of any kind.** The first external payment for the
service has not happened; the only settlement ever recorded is the operator's own
testnet transaction (receipts pinned in the README). This file says so rather
than implying a budget that does not exist.

## What sponsorships would cover

verify402 runs on a free-tier deployment today, so sponsorships would go to, in order:

1. **Keeping the free tier up** — `/findings` (free public verdicts) is paid for with
   effort, not money, but paid tiers would let it stay reachable more reliably.
2. **Chain RPC allowances** — every measurement makes real on-chain calls; paid RPC
   tiers raise reliability at volume.
3. **Protocol work** — time spent answering auditors and maintaining the recovery
   contract proposed as an x402 extension (issue
   [x402-foundation/x402#3847](https://github.com/x402-foundation/x402/issues/3847)),
   plus external security review.

No promise of returns of any kind is attached. Sponsors fund honest measurement
infrastructure; the product stays exactly as open and as skeptical as today.

## Donate in crypto (voluntary, no perks)

You can fund continued development directly, in crypto, to the same public
wallets the service settles to in its x402 payment metadata. No accounts, no
forms, no perks — a donation buys nothing, changes no verdict, and carries no
promise of returns (same rule as above, in dollars or cents).

| Network | Address | What it receives |
|---|---|---|
| **EVM — Base** (and friends) | `0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb` | USDC, ETH |
| **Solana** | `BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ` | USDC, SOL |

Every donation received is acknowledged publicly in this repo the same way
settlement receipts are — tx hash optional at the donor's choice, thanks
mandatory.

## Other ways to support

- **Use the service**: free verdicts at `GET /findings`, paid checks via x402 —
  an external paying call would be the single most valuable support signal,
  because it is the thing this project currently has zero of.
- **Audit it**: pull the repo, recompute the hashes, falsify a verdict and open an
  issue. Public failure-mode documentation is the part this rail is missing.
- **Say it publicly**: if a check saved you from a bad trade, saying so with the
  receipt hash is worth more than the money.
