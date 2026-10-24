# Receipt verification and executor ordering

A verdict is advice. A receipt is what an executor can check. The safe order is:

1. Call `/preflight` with the exact request.
2. Refuse `BLOCK`.
3. Refuse `CAUTION` without an explicit operator acknowledgement.
4. Refuse a missing or expired receipt.
5. Call `/preflight/verify` with the receipt, **the exact request body**, and
   the normalized intent returned by the gate.
6. Require `valid`, `intentBound`, and `requestBound`.
7. Sign only the intent the receipt covers.

Do not call the signer between steps 1 and 6.

## What the receipt contains

```json
{
  "spec": "verify402/preflight-receipt@1",
  "id": "pf_...",
  "kind": "payment",
  "verdict": "PASS",
  "intentHash": "0x...",
  "requestHash": "0x...",
  "blockNumber": 52814257,
  "blockHash": "0x...",
  "checked": ["..."],
  "notChecked": ["..."],
  "expiresAt": "2026-10-24T12:00:00.000Z",
  "signature": "0x..."
}
```

The HMAC covers the canonical receipt payload. The two hashes bind:

- `intentHash` — the normalized intent (the thing the gate evaluated).
- `requestHash` — the exact request body sent to `/preflight` (the bytes the
  caller asked about).

The request binding is the stronger one for an executor: it means no field can
be changed after the gate ran, without reimplementing normalization.

## Verify it

`POST /preflight/verify` is free and does not read the chain.

```js
const frozenIntent = structuredClone(intent); // the exact intent you will sign
const body = { ...frozenIntent, policy }; // same object and same JSON bytes sent to /preflight

const check = await fetch("https://verify402.onrender.com/preflight/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    receipt: gate.receipt,
    request: body,
    intent: gate.intent, // normalized intent returned by /preflight
  }),
}).then((r) => r.json());

if (!check.valid) throw new Error(`receipt invalid: ${check.reason}`);
if (check.intentBound !== true) throw new Error("receipt is not bound to the intent");
if (check.requestBound !== true) throw new Error("receipt is not bound to the request");
if (Date.parse(check.expiresAt) <= Date.now()) throw new Error("receipt expired");
```

A successful response:

```json
{
  "valid": true,
  "reason": null,
  "verdict": "PASS",
  "kind": "payment",
  "intentHash": "0x...",
  "requestHash": "0x...",
  "intentBound": true,
  "requestBound": true,
  "payeeBinding": null,
  "blockNumber": 52814257,
  "blockHash": "0x...",
  "expiresAt": "2026-10-24T12:00:00.000Z"
}
```

`valid: true` alone is not enough. A receipt-only call remains compatible but
returns `intentBound: false` and `requestBound: false`; a request-only call
returns `requestBound: true` but `intentBound: false`. At a signing boundary,
send both `request` and `intent` and require both to be true.

## Binding rules

- Use the **same object** for `request` that you sent to `/preflight`. If you
  parse and re-serialize with different key order, extra fields, or changed
  number formats, the hash may not match.
- Do not “fix” the request after the gate. If the intent changes, call the gate
  again.
- Do not reuse an expired receipt. The default TTL is 90 seconds (15–300
  configurable). Re-call the gate.
- Verify against the same verify402 instance that issued the receipt. When
  `/info` reports `receiptSigning: "ephemeral"`, the HMAC secret is
  process-local; a restart or another instance cannot verify an old receipt.
  The short TTL limits the window, but it is still a real boundary.
- A verified receipt proves integrity and binding, not safety. Read
  `notChecked` and the verdict before signing.

## Failure reasons

| `reason` | Meaning | Action |
|---|---|---|
| `missing_receipt` | No receipt object | Do not sign |
| `unknown_spec` | Not a verify402 preflight receipt | Do not sign |
| `missing_signature` / `bad_signature` | HMAC missing or wrong | Do not sign |
| `missing_intent_hash` | Receipt predates intent binding | Do not sign |
| `missing_request_hash` | Receipt predates request binding | Do not sign |
| `bad_expiry` / `expired` | TTL invalid or elapsed | Call `/preflight` again |
| `intent_mismatch` | Receipt is for a different normalized intent | Do not sign |
| `request_mismatch` | Receipt is for different request bytes | Do not sign |
| `invalid_intent` / `invalid_request` | Binding input is not a JSON object | Fix the call; do not sign |

## Executor pattern

```js
async function signOnlyWithVerifiedReceipt({ intent, policy, signer, operatorAcknowledged = false }) {
  const base = "https://verify402.onrender.com";
  const frozenIntent = structuredClone(intent);
  const body = { ...frozenIntent, policy };

  const gate = await fetch(`${base}/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(`preflight HTTP ${r.status}`);
    return r.json();
  });

  if (gate.verdict === "BLOCK" || gate.sign_allowed !== true) {
    throw new Error(`preflight blocked: ${gate.summary}`);
  }
  if (gate.verdict === "CAUTION" && !operatorAcknowledged) {
    throw new Error("preflight requires an explicit operator acknowledgement");
  }
  if (!gate.receipt) throw new Error("preflight returned no receipt");

  const check = await fetch(`${base}/preflight/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      receipt: gate.receipt,
      request: body,
      intent: gate.intent,
    }),
  }).then((r) => r.json());

  if (!check.valid || check.intentBound !== true || check.requestBound !== true) {
    throw new Error(`receipt rejected: ${check.reason || "not bound"}`);
  }

  return signer.sign(frozenIntent);
}
```

The reference implementation in the verify402 repository
(`examples/preflight-guard.mjs`) is stricter: it freezes the intent, verifies
both hashes, and has no `verify:false` switch. Use it when the signer is a
wallet SDK, or copy its ordering.

## What an executor must not do

- Do not call `sign()` before the verification resolves.
- Do not let a caller override `verify` or `allowUnverified` to skip the check.
- Do not accept `valid: true` from a receipt-only call as “bound”.
- Do not sign a re-built object after verifying a different one.
- Do not treat a `PASS` receipt as a guarantee of safety or delivery.
