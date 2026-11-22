# Local licenses for the paid engines

The hosted service charges for paid checks with x402 at the HTTP boundary.
The same engines can also be imported directly from a clone of this repository,
which never reaches that paywall. This document describes the local license
requirement added for that path.

## What changed

The five paid engines now check for a signed license when called outside the
hosted service:

| Engine | Module |
| --- | --- |
| `verify` (`measureRoundTrip`) | `src/measure.mjs` |
| `safety` (`preTradeCheck`) | `src/safety.mjs` |
| `route` (`bestRouteBook`) | `src/quotecheck.mjs` |
| `quotecheck` (`fairQuoteCheck`) | `src/quotecheck.mjs` |
| `depth` (`depthProfile`) | `src/depth.mjs` |

Without a valid license they throw `LicenseRequiredError` before doing any
chain work. The hosted server calls `enableHostedMode()` at startup, so hosted
paid calls (including `/assure`, which composes several engines) are unaffected.
Free `/preflight`, payment, recovery, receipt and sign-in behavior are unchanged.

## Getting a license

The operator signs a short-lived token with an Ed25519 key that is not in this
repository:

```bash
node scripts/mint-license.mjs --id agent-name --days 365 --out /path/to/license.txt
```

Options: `--id` (short identifier), `--days` (1–3650, default 365), `--out`
(write the token to a mode-600 file instead of stdout), `--key` (override the
signing-key path). The token format is
`v1.<base64url payload>.<base64url signature>`; the payload carries `id`,
`iat`, `exp`, and a fixed `kind` so tokens cannot be reused for another purpose.

Set the token in the environment of the process that runs the engines:

```bash
export VERIFY402_LICENSE_KEY="$(cat /path/to/license.txt)"
```

The signing key lives at `~/.config/verify402/license-private.pem` (mode 600).
The verifier public key is embedded in `src/license.mjs`; it is public data and
contains no secret. Never commit or print the signing key.

## Test harness

The offline suite uses `VERIFY402_LICENSE_BYPASS=1` so the engine tests can run
without a license. The bypass is refused when `X402_MODE=mainnet`. It is a test
convenience, not a supported way to run paid checks in production.

## Honest limitation

This is a barrier against casual or accidental local use, not a technical lock:
the code is Apache-2.0 and public, so anyone can edit or remove the checks, and
copies or npm mirrors already in circulation cannot be recalled. A signed
license makes "just import the engine" stop working and gives the project a
clear commercial path, but the real enforcement is moving the paid computation
private/server-side and leaving only free tools in the public package.
