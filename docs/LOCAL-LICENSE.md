# Paid engines and the local license gate

The hosted service charges for paid checks with x402 at the HTTP boundary.
Copies of this public repository never reach that paywall, so the five paid
engines are no longer implemented here: they live in the private
`verify402-engine` service and are called over a token-gated internal endpoint.
This document describes the thin public clients and the signed-license gate
that still guards direct imports.

## What changed

Each public engine module is now a thin proxy. It first requires a signed local
license, then forwards the call to the private service when configured, and
fails closed when that service is absent:

| Engine | Public proxy |
| --- | --- |
| `verify` (`measureRoundTrip`) | `src/measure.mjs` |
| `safety` (`preTradeCheck`) | `src/safety.mjs` |
| `route` (`bestRouteBook`) | `src/quotecheck.mjs` |
| `quotecheck` (`fairQuoteCheck`) | `src/quotecheck.mjs` |
| `depth` (`depthProfile`) | `src/depth.mjs` |

Without a valid license they throw `LicenseRequiredError` before any chain or
network work. The hosted server calls `enableHostedMode()` at startup, so hosted
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

Set the token in the environment of the process that imports the proxy, and
point it at the private service:

```bash
export VERIFY402_LICENSE_KEY="$(cat /path/to/license.txt)"
export VERIFY402_ENGINE_URL="https://engine.example.internal"
export VERIFY402_ENGINE_TOKEN="..."
```

The signing key lives at `~/.config/verify402/license-private.pem` (mode 600).
The verifier public key is embedded in `src/license.mjs`; it is public data and
contains no secret. Never commit or print the signing key.

## Test harness

The offline suite uses `VERIFY402_LICENSE_BYPASS=1` so the route, payment and
free-tool tests can run without a license. The bypass is refused when
`X402_MODE=mainnet`. Engine-internal and RPC tests now live in the private
repository next to the implementation.

## Enforcement

The signed license remains useful defense in depth, but the real enforcement
is architectural: the public package contains no venue/quoter logic, token
facts, ladder arithmetic or verdict code. A clone cannot produce a paid result
without the private service, and the hosted HTTP boundary still requires x402
payment before any result is returned.
