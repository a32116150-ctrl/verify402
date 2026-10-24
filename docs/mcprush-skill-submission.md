# mcprush skill submission: verify402 preflight

Status: **prepared, not submitted**. The source lives at
`skills/verify402-preflight/` in this repository.

## Listing fields

| Field | Value |
|---|---|
| Kind | Agent skill |
| Name | `verify402-preflight` |
| Title | verify402 preflight |
| Publisher | `a32116150-ctrl` |
| Category | Security & Testing |
| Price | Free |
| Source | Git repository: `https://github.com/a32116150-ctrl/verify402` |
| Skill path | `skills/verify402-preflight` |
| Servers it uses | `verify402-mcp` (declared in `requires.mcp`) |
| Licence | Apache-2.0 |

### Tagline

The signing boundary, with receipts.

### Short description

Use before signing any EVM transaction, token approval, or x402/USDC payment;
also use when checking a swap quote, token sellability, arbitrage claim, or
position size. Calls verify402's free preflight gate, reads
PASS/CAUTION/BLOCK and `checked`/`notChecked`, verifies the short-lived receipt,
and refuses to sign without it. Routes the five paid verify402 checks and
states their limits.

### Long description

This skill is the judgment layer for verify402. It tells an agent when to stop
at the signing boundary, how to build the exact payment or transaction intent,
which policy fields actually enforce something, how to read the verdict and the
`notChecked` gaps, and how to verify the receipt before an executor signs.

It also covers the five paid checks and when they are worth a call:
`check_token_safety` before buying an unknown token, `verify_quote_fairness`
before accepting someone else's quote, `get_best_route` before a swap,
`get_trade_depth` before choosing a size, and `verify_arbitrage` only when
someone claims an edge. `no_edge` is treated as a valid answer.

The limits are explicit: a PASS is not a guarantee, the token check is not a
honeypot proof, `capacityUsd` is not a promise of exit, and no result is a
profit forecast. The public demo pays in Base Sepolia testnet USDC; the
analysis reads mainnet chain data, and mainnet settlement is not the demo
default.

### What it will not do

- Guarantee that a transaction is safe or that a counterparty will deliver.
- Audit a contract, screen sanctions or reputation, or test transfer
  restrictions such as tax, blacklist, pause, or max-tx.
- Promise profit or turn `no_edge` into an opportunity.
- Sign or send a trade. The executor and its signer do that.
- Replace the receipt check. The skill requires it; the MCP tool alone is
  advisory.

### What it asks for

- Network access to `https://verify402.onrender.com` for the free HTTP
  fallback.
- Optional: the `verify402-mcp` server for native `preflight_gate` and paid
  tools.
- No file writes, no credentials, no private keys. The paid bridge reads its
  wallet from its own environment; the skill never asks for a key.

## Review notes

- The skill does not claim the gate is a guarantee. It says the opposite in
  several places, including the output template.
- It does not claim the seller owns the payee. It distinguishes
  `sellerPayoutWallets` (allowlist only) from a verified
  `sellerPayoutManifest` (`payee_payout_binding`).
- It does not claim the token check is a honeypot proof.
- It does not claim `no_edge` is a failure.
- It does not ask the user to move mainnet funds. The public demo is testnet
  payments only.
- The skill is free. There is no upsell gate inside it; the paid checks are
  described because the MCP server exposes them, not because the skill requires
  a purchase.

## Submission steps

1. Sign in to mcprush Studio as the publisher.
2. **New listing → Agent skill**.
3. **Add your skill** and point it at the repository path
   `skills/verify402-preflight`.
4. **Edit and check** — confirm the title, description, category, licence, and
   the `requires.mcp: [verify402-mcp]` relationship.
5. **Listing and pricing** — set **Free**.
6. **Prove ownership** of the source repository.
7. **Submit for review**. Target review time is about 48 hours.

## After approval

The public page should be:

`https://mcprush.com/a32116150-ctrl/verify402-preflight`

Install check:

```bash
npx mcprush@latest skill add a32116150-ctrl/verify402-preflight
```

Then ask an agent:

> Before signing this x402 payment, use verify402 preflight. If the verdict is
> CAUTION, stop and show me the reasons. If it is PASS, verify the receipt and
> tell me what `notChecked` still leaves open.

## What not to put in the listing

- “100x better” or any unmeasured multiplier.
- “Guaranteed safe”, “honeypot-free”, or “audited”.
- “Find profitable trades” or “profit” claims.
- Mainnet payment instructions for the public demo.
