# Reference executor

`preflight-guard.mjs` is a small repo-local, deny-by-default wrapper around the
free gate. It holds no key and sends nothing: it calls `POST /preflight`,
refuses `BLOCK`, refuses `CAUTION` until you acknowledge it, verifies the
receipt with `POST /preflight/verify`, checks the request hash locally, and
only then calls **your** signer. Receipt verification is mandatory; there is no
`verify:false` bypass.

```js
import { guardAndSign } from "./preflight-guard.mjs";

await guardAndSign({
  intent: {
    kind: "transaction",
    chainId: 8453,
    from: wallet.address,
    to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    data: approveCalldata,
    value: "0",
  },
  policy: {
    forbidUnlimitedApproval: true,
    allowedSpenders: ["0x..."],
  },
  // Called only after PASS, or CAUTION + acknowledgeCaution:true.
  sign: async (intent, { receipt }) => {
    return wallet.sendTransaction(intent);
  },
});
```

- `BLOCK`, a missing receipt, an expired receipt, a failed `/preflight/verify`,
  a receipt that is not bound to this caller's request/intent, or a 503 from
  the gate all throw **before** `sign` is called.
- `CAUTION` requires `acknowledgeCaution: true`. That is a decision, not a pass;
  log the reasons.
- The intent is cloned and deep-frozen before the gate, and that same object is
  passed to `sign`. Mutating it after the gate cannot silently sign something
  the receipt did not cover.
- `baseUrl` defaults to the public mainnet instance. If you do not want to trust
  it, run your own verify402 and pin `baseUrl` to it.

## x402 automatic hook

For an `x402Client`, `createX402PreflightHook()` is the one-line guard. It
converts the selected 402 requirement into a payment intent, calls the free
gate, refuses BLOCK and unacknowledged CAUTION, verifies the receipt, and writes
the verified receipt to `context.verify402` before the SDK signs:

```js
import { createX402PreflightHook } from "./preflight-guard.mjs";

client.onBeforePaymentCreation(createX402PreflightHook({
  policy: { allowedResourceHosts: ["api.example"] },
  from: account.address,
  onVerified: ({ receipt, verdict, response }) => {
    // attach or log the same receipt the gate issued
  },
}));
```

The hook aborts without attaching anything if the gate returns BLOCK, if the
receipt fails verification, if either the intent or request binding is missing,
or if the gate is unavailable. `context.verify402` is also visible to
`onAfterPaymentCreation`, so a caller can attach the receipt to its own output
without re-running the gate. `guardX402Payment()` is the same check without the
client hook.

The guard enforces the gate's answer. It does not make the transaction safe,
audit the contract, or replace your signer. Read `notChecked`.
