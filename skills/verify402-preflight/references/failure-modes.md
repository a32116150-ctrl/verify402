# Failure modes and safe recovery

The gate is fail-closed. If it cannot produce a verdict and a receipt, the
correct action is **do not sign**.

## HTTP and validation errors

| Status / code | Meaning | Safe action |
|---|---|---|
| `400 missing_chain` | Transaction intent has no `chainId` | Add the real chain id; do not guess |
| `400 invalid_chain` | `chainId` is not an integer JSON number | Fix the type |
| `400 unsupported_chain` | Not in the measurement registry | Use Ethereum `1`, Arbitrum `42161`, or Base `8453`; stop otherwise |
| `400 invalid_kind` | `kind` is not `payment` or `transaction` | Fix the intent |
| `400 invalid_policy` | A policy field has the wrong type or shape | Fix the field; do not drop the policy silently |
| `429` | Rate limit (about 60/min per IP, 8 concurrent) | Back off and retry |
| `503 preflight_unavailable` | Chain could not be read or an internal error occurred | No receipt was issued. Do not sign. Retry later |
| `503 chain_unavailable` | No readable client for that chain | Use a supported chain or stop |
| Network timeout | No response | Do not sign. Warm the free instance once, then retry |

A `503` response is not a verdict. Never translate it into a local `PASS`.

### Verdict reasons, not HTTP errors

These arrive inside `reasons[]` with a `severity`. Act on the verdict and
reasons; do not expect an HTTP status.

| Reason code | Meaning | Severity |
|---|---|---|
| `missing_to` / `invalid_to` | Transaction target is absent or malformed | block |
| `invalid_payer` | `from` is not a valid EVM address | block |
| `malformed_calldata` | Calldata is not even-length hex, too large, or cannot be decoded | block |
| `invalid_value` | `value` is not a non-negative integer string | block |
| `target_not_contract` | Calldata is sent to an address with no bytecode | block |
| `unlimited_approval` | Unlimited approve with `forbidUnlimitedApproval` | block |
| `to_not_allowed` | Target is outside `policy.allowedTo` | block |
| `value_over_policy` | Native value is above the policy cap | block |
| `simulation_revert` | The call reverted at this block | block |
| `insufficient_funds` | The payer cannot cover value + gas | block |
| `unsupported_network` | Payment network is not supported by this instance | block |
| `stale_block` | Block is older than 30s (caution) or 120s (block) | caution/block |
| `noop_transaction` | No calldata and no value | caution |
| `simulation_skipped_no_from` | No `from`, so simulation was skipped | caution |
| `contract_code_unavailable` / `token_metadata_unavailable` | A read failed; the named gap remains | caution |
| `simulation_unavailable` | The simulation could not run | caution |

A malformed payment object is usually handled as a verdict reason or an
`invalid_policy` error, not a separate `missing_payment` HTTP code. Copy the
402 challenge exactly rather than guessing which one.

## Verification errors

| `reason` | Meaning | Safe action |
|---|---|---|
| `missing_receipt` | No receipt object | Do not sign |
| `unknown_spec` | Not a verify402 receipt | Do not sign |
| `missing_signature` / `bad_signature` | HMAC missing or wrong | Do not sign |
| `missing_intent_hash` | Receipt is too old for intent binding | Do not sign; re-run the gate |
| `missing_request_hash` | Receipt is too old for request binding | Do not sign; re-run the gate |
| `bad_expiry` / `expired` | TTL invalid or elapsed | Call `/preflight` again |
| `intent_mismatch` | Receipt is for a different normalized intent | Do not sign |
| `request_mismatch` | Receipt is for different request bytes | Do not sign |
| `invalid_intent` / `invalid_request` | Binding input is not a JSON object | Fix the call |

Receipt-only verification (`{receipt}`) can return `valid: true` with
`intentBound: false` and `requestBound: false`. At a signing boundary, that is
not enough. Require both bindings.

## Seller payout manifest errors

These are returned inside the response as reasons or in `payeeBinding`, not as
a separate HTTP error.

| Code | Meaning | Safe action |
|---|---|---|
| `payee_manifest_unavailable` | Host resolution or fetch failed; non-2xx | Payee ownership was not checked; treat as caution/block as returned |
| `payee_manifest_invalid` | Bad URL, JSON, spec, chain, signer, expiry, size, or private host | Do not treat the manifest as proof |
| `payee_manifest_signature_invalid` | Signature does not match signer | Do not trust it |
| `payee_manifest_signer_mismatch` | Signer differs from `expectedSigner` | Do not trust it |
| `payee_manifest_chain_mismatch` | Manifest is for another chain | Do not trust it |
| `payee_manifest_expired` | Manifest TTL elapsed | Do not trust it |
| `payee_not_payout_wallet` | `payTo` is not in the signed manifest | Do not pay |

A caller-supplied `sellerPayoutWallets` match is only
`payee_payout_allowlist`. If you see that, do not report `payee_payout_binding`
or “the seller owns the payee.”

## MCP bridge errors

- The tool returns `isError: true` with `preflight failed (...)`.
- No receipt was issued. Stop; do not retry with a guessed verdict.
- `preflight_gate` is free and does not need a wallet. If the bridge is in
  free-only mode, the five paid tools are not registered; do not invent their
  results.
- A paid tool error is different from a gate error. A paid `503` means no
  verdict and no settlement. Inspect before retrying; do not pay twice
  blindly.
- If the bridge reports a payment-policy refusal, that is the guard working.
  Do not bypass it by changing the payee, network, or resource.

## The unsafe fallbacks

Never do these when the gate fails:

- Treat a timeout as `PASS`.
- Reuse an old receipt for a new intent.
- Drop a policy field because it caused a `400`.
- Change `payTo`, `amount`, `network`, `asset`, `to`, `data`, or `value` to make
  the gate pass.
- Switch the public demo to mainnet to make a testnet 402 “work”.
- Pay a second time because a 503 left the first call ambiguous.
- Let the model self-acknowledge a `CAUTION` without a human decision.

The gate exists to make these failures visible. A slow no is better than a
fast wrong signature.
