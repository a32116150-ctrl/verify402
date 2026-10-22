# Mainnet Switch Checklist

Plain-language checklist for switching verify402 from testnet to mainnet. Do not
switch until every item is checked.

## a) Prerequisites before mainnet

1. Use an always-on paid host. A free host that sleeps is not safe for mainnet.
2. Confirm the service has been stable on testnet first.
3. Set up a way to watch logs and uptime.
4. Make sure you can roll back to the previous deploy in the hosting dashboard.
5. Confirm you have a mainnet facilitator ready before changing `X402_MODE`.
6. Do not switch on a free instance.

## b) Wallets

1. Use public receiving addresses only. `PAY_TO_EVM` and `PAY_TO_SVM` are public.
2. Use a dedicated receiving account for verify402. Do not use a personal or trading wallet.
3. For EVM, verify the Phantom EVM account can hold USDC on Base. Add the Base network in Phantom and confirm the account address.
4. For Solana, verify the Phantom Solana account can hold USDC on Solana mainnet.
5. Test first with a tiny real payment on testnet.
6. Never put a seed phrase or private key in the repo, Render, chat, an issue, a commit, or a log.

## c) Facilitator

1. Mainnet needs a real facilitator. The code uses `FACILITATOR_URL` directly, or uses Coinbase CDP automatically when `CDP_API_KEY_ID` is set.
2. Create Coinbase Developer Platform keys in the Coinbase dashboard if you use CDP.
3. Put `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` only in Render's environment, never in the repo.
4. If you use another facilitator, set `FACILITATOR_URL` to that mainnet endpoint.
5. The server refuses to start in mainnet mode without a facilitator.

## d) Exact environment variables for mainnet

Required:
- `X402_MODE` = `mainnet`
- `MAINNET_ALWAYS_ON_CONFIRMED` = `yes` or `REQUIRE_ALWAYS_ON` = `1`
- `AGENT_URL` = `https://your-mainnet-origin`
- `PREFLIGHT_SECRET` = at least 32 random characters from a password manager
- `FACILITATOR_URL` = your mainnet facilitator URL, unless using CDP
- `PAY_TO_EVM` = your mainnet EVM receiving address
- `PAY_TO_SVM` = your mainnet Solana receiving address

Only for CDP:
- `CDP_API_KEY_ID` = your CDP key ID
- `CDP_API_KEY_SECRET` = your CDP key secret

Startup guards:
- Missing `AGENT_URL`: startup refuses with `REFUSING TO START: X402_MODE=mainnet requires AGENT_URL`.
- Missing `PREFLIGHT_SECRET`: startup refuses with `REFUSING TO START: X402_MODE=mainnet requires PREFLIGHT_SECRET`.
- Missing `MAINNET_ALWAYS_ON_CONFIRMED` or `REQUIRE_ALWAYS_ON`: startup refuses with `REFUSING TO START: X402_MODE=mainnet requires MAINNET_ALWAYS_ON_CONFIRMED=yes (or REQUIRE_ALWAYS_ON=1)`.
- `ALLOW_MAINNET_ON_FREE_TIER` set: startup refuses with `REFUSING TO START: ALLOW_MAINNET_ON_FREE_TIER must not be set`.
- Missing `FACILITATOR_URL` without CDP: startup refuses with `REFUSING TO START: mainnet mode needs FACILITATOR_URL ... or a CDP API key`.

## e) Pre-switch checks, first-hour watch, rollback

Pre-switch checks:
1. `/health` returns `ok: true`.
2. `/ready` returns `ok: true` and a recent block.
3. Do **not** use `npm run post-deploy` as a mainnet pass: it accepts `EXPECTED_MODE=testnet` only and asserts the Base Sepolia demo rail. Mainnet deployment checks are not implemented yet; use the free `/health`, `/ready`, and `/preflight` checks plus manual 402 review.
4. No `BYPASS_PAYMENT=1` is set.
5. `AGENT_URL` is the canonical origin, not the request Host.

First-hour watch:
1. Watch logs for `verify402 listening`.
2. Confirm no `REFUSING TO START`.
3. Confirm no full URLs, keys, or secrets appear in logs.
4. Confirm `/health` and `/ready` stay healthy.
5. Confirm paid responses and 402 challenges carry no `access-control-allow-origin`.

Rollback:
1. Remove the instance from paid traffic or scale to zero.
2. Roll back to the previous deploy in Render.
3. Confirm `/health`, `/ready`, and `/preflight` work.
4. Run the smoke test again.
5. Rotate any key that may have leaked.

## f) Do not switch yet

Current blockers:
- The service is currently configured for testnet.
- Free instances spin down and are not safe for mainnet.
- Mainnet requires an always-on paid host.
- No real mainnet payment has been approved yet.
- Mainnet facilitator and payee wallets must be configured and tested before switching.
