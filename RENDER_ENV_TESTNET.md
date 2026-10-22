# Render Environment: Testnet Service

Current live service: `https://verify402.onrender.com/`

## Variable table

| Variable | Exact value / placeholder | Secret? | Where the value comes from | If missing at startup | Verdict for current row |
|---|---|---|---|---|---|
| `CDP_API_KEY_ID` | delete for testnet | Yes | Coinbase CDP dashboard, only if using the CDP facilitator | Not used with `https://x402.org/facilitator`; harmless but unnecessary | Delete |
| `CDP_API_KEY_SECRET` | delete for testnet | Yes | Coinbase CDP dashboard, only if using the CDP facilitator | Not used with `https://x402.org/facilitator`; harmless but unnecessary | Delete |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | No | x402 testnet facilitator | Defaults to `https://x402.org/facilitator` in testnet mode | Keep, exact value |
| `NODE_VERSION` | `22` | No | Render Node runtime | Render chooses its default Node version | Keep if `22` |
| `PAY_TO_EVM` | testnet receiving wallet address | No | Your testnet EVM wallet | Defaults to the repo's testnet payee address | Keep if it is your wallet; otherwise change |
| `PAY_TO_SVM` | testnet receiving wallet address | No | Your testnet Solana wallet | Defaults to the repo's testnet payee address | Keep if it is your wallet; otherwise change |
| `PREFLIGHT_SECRET` | at least 32 random characters | Yes | Password manager or `openssl rand -hex 32` | Receipts use an ephemeral per-process secret; receipts are not stable across restarts | Keep |
| `X402_MODE` | `testnet` | No | Deployment mode | Defaults to `testnet` | Keep, exact value |
| `AGENT_URL` | `https://verify402.onrender.com` | No | Canonical public origin | Agent card falls back to trusted Host handling; mainnet requires it | Change: remove trailing slash |
| `TRUSTED_HOSTS` | `verify402.onrender.com,localhost,127.0.0.1` | No | Host allowlist when `AGENT_URL` is unset | Defaults include `verify402.onrender.com`, `localhost`, `127.0.0.1`, `::1` | Change: remove scheme and trailing slash |
| `READY_CHAIN_ID` | `84532` for Base Sepolia readiness, or `1`, `42161`, `8453` | No | Chain used by `/ready` | Defaults to `1` | Set `84532` only for readiness; paid routes still require 1/42161/8453 |
| `READY_RPC_URL` | private readiness endpoint (never paste the value here) | Yes if it embeds an API key | RPC provider dashboard | Falls back to the chain-specific variable, then the public default | Optional; use a dedicated endpoint for a stable `/ready` |
| `BASE_SEPOLIA_RPC_URL` | private Base Sepolia endpoint (never paste the value here) | Yes if it embeds an API key | RPC provider dashboard | Uses `https://sepolia.base.org` | Only used by readiness on `READY_CHAIN_ID=84532` |
| `ETH_RPC_URL` | unset or your private endpoint | Yes if set | RPC provider dashboard | Uses `https://eth.llamarpc.com`, then `https://eth.drpc.org`, `https://eth.merkle.io`, `https://ethereum-rpc.publicnode.com` | Delete the broken combined row; add only if you have a private key |
| `ARB_RPC_URL` | unset or your private endpoint | Yes if set | RPC provider dashboard | Uses `https://arb1.arbitrum.io/rpc` | Add only if you have a private key |
| `BASE_RPC_URL` | unset or your private endpoint | Yes if set | RPC provider dashboard | Uses `https://mainnet.base.org` | Add only if you have a private key |

## Broken RPC row

The row whose key is the literal text `ETH_RPC_URL, ARB_RPC_URL, BASE_RPC_URL` with an empty value does nothing. Delete that row. Do not leave it in place.

## AGENT_URL and TRUSTED_HOSTS parsing

Code:
- `src/public-url.mjs`, `parseAgentUrl()` lines 14-33: a trailing slash is accepted and stripped, so `https://verify402.onrender.com/` becomes `https://verify402.onrender.com`. Credentials, query strings, and fragments are rejected.
- `src/public-url.mjs`, `parseTrustedHosts()` lines 46-63 and `normalizeHost()` lines 35-45: `https://verify402.onrender.com/` is accepted as a hostname, but the correct value is a bare hostname list.

Exact correct values:
- `AGENT_URL` = `https://verify402.onrender.com`
- `TRUSTED_HOSTS` = `verify402.onrender.com,localhost,127.0.0.1`

## CDP variables on testnet

`CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are only used when `FACILITATOR_URL` points at the Coinbase CDP facilitator. With `FACILITATOR_URL=https://x402.org/facilitator`, they are ignored. Keep them only if you plan to switch to CDP later; otherwise delete them from Render.

## NODE_VERSION

Use `22`. `render.yaml` sets `NODE_VERSION=22`, and the tests ran on Node v22.23.3. There is no `engines` field in `package.json`.

## READY_CHAIN_ID, READY_RPC_URL, and /health vs /ready

`READY_CHAIN_ID` selects the chain that `/ready` verifies. Supported readiness
chains are `1`, `42161`, `8453`, and `84532` (Base Sepolia). `84532` is
**readiness-only**: it is not added to the paid measurement registry (`CHAINS`),
and paid routes still require `chainId` 1, 42161, or 8453. `X402_MODE=testnet`
controls the x402 payment rail; it does not widen the paid measurement chains.

The endpoint selection is:

1. `READY_RPC_URL`, if set. This is the simplest way to pin a private readiness
   provider.
2. Otherwise the chain-specific variable: `ETH_RPC_URL`, `ARB_RPC_URL`,
   `BASE_RPC_URL`, or `BASE_SEPOLIA_RPC_URL` for `84532`.
3. Otherwise the public default, including `https://sepolia.base.org` for Base
   Sepolia.

`READY_RPC_URL` and `BASE_SEPOLIA_RPC_URL` are not used by paid measurement
clients. Keep the paid variables separate. Never paste an RPC URL that embeds
an API key into this document, a ticket, or a chat; put it in the Render secret
environment and refer to it by variable name only.

`/ready` now calls `eth_chainId` and requires it to match `READY_CHAIN_ID`
before reading the latest block. A mispointed endpoint (for example, mainnet
behind `READY_CHAIN_ID=84532`) returns `503` with `rpc_unavailable`; it is not
reported ready. The timeout covers both calls together (3 seconds), the
transport has no retries, and provider errors/URLs are never echoed.

Leave `render.yaml`'s `healthCheckPath: /health`. `/health` is a liveness check:
the process is up. `/ready` is a deep dependency check: the configured RPC is on
the expected chain and can serve a block. Pointing the platform's restart probe
at `/ready` would turn a provider outage into a restart loop. Use `/ready` for
traffic gating where the platform separates readiness from liveness; Render's
current `healthCheckPath` remains `/health` unless the deployment platform adds
a separate readiness probe.

## RPC fallbacks

Paid measurement reads these variables:
- `ETH_RPC_URL`
- `ARB_RPC_URL`
- `BASE_RPC_URL`

Readiness additionally reads:
- `READY_RPC_URL` (highest priority for `/ready`)
- `BASE_SEPOLIA_RPC_URL` (when `READY_CHAIN_ID=84532`)

If unset:
- Ethereum uses `https://eth.llamarpc.com`, then `https://eth.drpc.org`, `https://eth.merkle.io`, and `https://ethereum-rpc.publicnode.com`.
- Arbitrum uses `https://arb1.arbitrum.io/rpc`.
- Base uses `https://mainnet.base.org`.

The free `/preflight` gate can work on those public endpoints for chains 1, 42161, and 8453. The downside is throttling and rate limits; a busy or cold instance may see slower or failed `/ready` and preflight calls. Minimal set for now: leave all three RPC variables unset.

## Testnet and mainnet chain state

`X402_MODE=testnet` changes the paid network labels to Base Sepolia and Solana devnet, but the free `/preflight` gate still supports mainnet EVM chains 1, 42161, and 8453. `src/preflight.mjs` calls `clientFor(chainId)` for the requested chain, and `src/config.mjs` defines those mainnet chains. Therefore testnet mode does not limit preflight to testnet chains. Likewise, `READY_CHAIN_ID=84532` only changes `/ready`; it does not add 84532 to the paid-route `CHAINS` registry.

## render.yaml auto-deploy

`render.yaml` does not set `autoDeploy`. I cannot tell from the repo alone whether pushing `master` will redeploy the existing Render service; that is controlled in the Render dashboard.
