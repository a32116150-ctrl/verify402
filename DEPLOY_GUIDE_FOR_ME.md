# Deploy Guide For Me (Plain Language)

## Render Environment page: exact edits for the current service

1. Open Render and click the `verify402` web service.
2. Click "Environment" or "Environment Variables".
3. Find the row whose key is the literal text `ETH_RPC_URL, ARB_RPC_URL, BASE_RPC_URL`.
4. Delete that broken row. It does nothing.
5. Edit `AGENT_URL` to `https://verify402.onrender.com` with no trailing slash.
6. Edit `TRUSTED_HOSTS` to `verify402.onrender.com,localhost,127.0.0.1`.
7. Edit `FACILITATOR_URL` to `https://x402.org/facilitator`.
8. Edit `X402_MODE` to `testnet`.
9. Leave `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` only if you plan to use CDP later; otherwise delete them.
10. Leave `PREFLIGHT_SECRET` as it is, or replace it with a new password-manager generated secret of at least 32 random characters. Do not paste it into chat.
11. Leave `PAY_TO_EVM` and `PAY_TO_SVM` only if they are your testnet wallets.
12. Leave `READY_CHAIN_ID` as `1`.
13. Do not add `ETH_RPC_URL`, `ARB_RPC_URL`, or `BASE_RPC_URL` unless you have private endpoints.
14. Click "Save Changes". If Render shows a small arrow or menu next to Save, choose the option that saves without deploying. If there is no such option, saving will redeploy the service; watch the deploy logs.
15. After saving, open `/health` and confirm `ok: true`.

---

## If I already have the service running on Render (free instance, testnet)

Do these before any push.

1. Open the Render dashboard.
2. Click the existing `verify402` web service.
3. Click "Environment" or "Environment Variables".
4. Find `X402_MODE`.
   - If it says `testnet`, the live service is on testnet.
   - If it says `mainnet`, the live service is on mainnet.
5. Add every missing variable before any push. Use placeholders or generated values only in Render, never in the repo:
   - `X402_MODE` = `testnet`
   - `FACILITATOR_URL` = `https://x402.org/facilitator`
   - `AGENT_URL` = `https://<your-render-url>`
   - `TRUSTED_HOSTS` = `<your-render-url>,localhost,127.0.0.1`
   - `PREFLIGHT_SECRET` = a password-manager generated random secret, at least 32 characters
   - `PAY_TO_EVM` = testnet receiving wallet
   - `PAY_TO_SVM` = testnet receiving wallet
   - `READY_CHAIN_ID` = `1`
   - `ETH_RPC_URL`, `ARB_RPC_URL`, `BASE_RPC_URL` = your new private RPC endpoints, set only in Render
6. Confirm the instance type shows Free.
7. Confirm no mainnet-only variables are set: `X402_MODE` must not be `mainnet`, and `MAINNET_ALWAYS_ON_CONFIRMED`, `REQUIRE_ALWAYS_ON`, and `ALLOW_MAINNET_ON_FREE_TIER` must not be set.
8. Ask OpenCode to run the push. Do not push yourself.
9. Open "Deploys" or "Events" and watch the deploy logs.
   - Healthy boot line: `verify402 listening on http://localhost:...`
   - A cold start can take about a minute; the first request may be slow.
   - Bad sign: `REFUSING TO START`.
10. If the deploy fails to start, click the previous deploy and choose "Rollback" or redeploy the previous commit.
11. After it is live, paste the live URL back to OpenCode.

> Warning: If the live service is currently on MAINNET, switch it back to testnet before deploying, because the free instance cannot run mainnet safely.

---

## If I already have the service running on Render

Do these steps before pushing anything.

1. Open the Render dashboard.
2. Click the existing `verify402` web service.
3. Click "Environment" or "Environment Variables".
4. Look for `X402_MODE`.
   - If it says `testnet`, the live service is on testnet.
   - If it says `mainnet`, the live service is on mainnet.
   - If it is missing, treat the service as testnet because the code defaults to testnet.
5. Compare the listed variables with the required list in section B.
6. Add every missing variable now, before any push:
   - Testnet required: `X402_MODE=testnet`, `FACILITATOR_URL=https://x402.org/facilitator`, `PAY_TO_EVM`, `PAY_TO_SVM`, and `PREFLIGHT_SECRET`.
   - Mainnet required: `X402_MODE=mainnet`, `AGENT_URL`, `PREFLIGHT_SECRET`, `FACILITATOR_URL`, `PAY_TO_EVM`, and `PAY_TO_SVM`.
   - If using Coinbase CDP, also add `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`.
7. Save the environment changes.
8. Keep this service on the Render Free plan. Do not upgrade to a paid plan for this testnet-only demo.
   - Free instances spin down after about 15 minutes idle.
   - A cold start can take about 1 minute.
   - Free instances can restart at any time.
Never set MAINNET_ALWAYS_ON_CONFIRMED or REQUIRE_ALWAYS_ON on the Render free instance; the app cannot detect the instance type, so that is the only protection.
   - The filesystem is ephemeral; recovery records and /usage counters are in memory and are lost on restart.
   - Rule: X402_MODE=testnet only on free instances. Mainnet requires an always-on paid instance.
9. Only after the variables are saved, push the new commit.
10. Open "Deploys" or "Events" and watch the new deploy.
11. A healthy boot line looks like:
    `verify402 listening on http://localhost:...`
    It must not say `REFUSING TO START`.
12. Open `https://<your-live-url>/health` and confirm `ok: true`.
13. If the deploy fails to start, click the previous deploy and choose "Rollback" or redeploy the previous commit. Then repeat steps 10-12.

### Warning if the live service is currently on mainnet

The version currently running on mainnet is the older vulnerable version. Set
`AGENT_URL`, `PREFLIGHT_SECRET`, and `FACILITATOR_URL` first, before pushing.
Do not push first and fix variables later: the new code refuses to start without
those variables, which can leave the service down or keep the old vulnerable
version running.

---

This guide assumes you only use web dashboards. Do not put any secret in the repo,
in chat, or in a screenshot. Use placeholders and keep real values in Render only.

## A. Create a new RPC key and add it only in Render

1. Open your RPC provider dashboard in a browser.
2. Find the project or app that currently holds the old RPC key.
3. Click "Create API key", "Create key", or the equivalent button.
4. Give it a clear name such as `verify402-render-new`.
5. Copy the new key or full endpoint URL into your password manager. Do not paste it into chat, GitHub, or a commit.
6. Open the Render dashboard.
7. Open the verify402 web service.
8. Click "Environment" or "Environment Variables".
9. Add or update only these variables with the new private endpoint:
   - `ETH_RPC_URL` = `https://...your-new-key...`
   - `ARB_RPC_URL` = `https://...your-new-key...` (if you use Arbitrum)
   - `BASE_RPC_URL` = `https://...your-new-key...` (if you use Base)
10. Save the environment changes.
11. Do not revoke the old key yet.
12. Deploy or restart the service so the new key is used.
13. Open `https://<your-live-url>/ready` and confirm it shows `ok: true` and a recent block number.
14. After the new key is confirmed working, return to the RPC provider dashboard.
15. Revoke or delete the old key.
16. Never put the new key in the repo, in logs, or in chat.

## B. Create the Render web service from GitHub

1. Open Render and click "New".
2. Click "Web Service".
3. Connect your GitHub account if Render asks.
4. Select the verify402 repository.
5. Choose the branch you want to deploy, usually `master`.
6. Choose the Render Free instance. This demo is testnet only. Do not choose a paid plan unless you are moving to mainnet later.
7. Set the build command to `npm install`.
8. Set the start command to `npm start`.
9. Set the health check path to `/health`.
10. Open the Environment section.
11. Add the variables below. Variables marked SECRET must be generated or copied into Render only, never into the repo.

Required variables:

- `X402_MODE` = `testnet` for the first deploy. Use `mainnet` only later.
- `FACILITATOR_URL` = `https://x402.org/facilitator` for testnet.
- `AGENT_URL` = `https://your-render-url.example` (SECRET-ish public origin; set your canonical URL)
- `TRUSTED_HOSTS` = `your-render-url.example,localhost,127.0.0.1`
- `PREFLIGHT_SECRET` = a long random secret. Generate it in your password manager as at least 32 random characters; 64 hex characters is ideal. Do not use a short word or reuse another secret.
- `PAY_TO_EVM` = your testnet receiving wallet address.
- `PAY_TO_SVM` = your testnet receiving wallet address.
- `PORT` = leave unset unless Render requires a value; Render usually provides it.
- `READY_CHAIN_ID` = `1`
- `SHUTDOWN_TIMEOUT_MS` = `10000`

Optional variables:

- `ETH_RPC_URL`, `ARB_RPC_URL`, `BASE_RPC_URL` = your private RPC endpoints.
- `PRICE`, `SAFETY_PRICE`, `ROUTE_PRICE`, `QUOTECHECK_PRICE`, `DEPTH_PRICE` = leave unset to use defaults.

Never set these in Render:

- `BYPASS_PAYMENT=1`
- `TEST_OFFLINE=1`
- `TEST_RPC_ONLY=1`
- `TEST_OFFLINE_RPC_URL=...`
- `SMOKE_PAID=1`
- `SMOKE_BASE_URL=...`
- `EVM_PRIVATE_KEY=...`

12. Click "Create Web Service".
13. Wait until Render shows the service as live.
14. Open `https://<your-live-url>/health` and confirm it says `ok: true`.

## C. Start on testnet first, then switch to mainnet later

### Testnet values

Use these exact values for the first live deploy:

- `X402_MODE` = `testnet`
- `FACILITATOR_URL` = `https://x402.org/facilitator`
- `AGENT_URL` = `https://<your-testnet-render-url>`
- `TRUSTED_HOSTS` = `<your-testnet-render-url>,localhost,127.0.0.1`
- `PREFLIGHT_SECRET` = your long random secret
- `PAY_TO_EVM` = testnet receiving wallet
- `PAY_TO_SVM` = testnet receiving wallet
- `READY_CHAIN_ID` = `1`

Do not set `BYPASS_PAYMENT=1`.

### Switch to mainnet later only after these checks pass

1. Confirm testnet `/health` reports `mode: "testnet"`.
2. Confirm testnet `/ready` returns `ok: true` and a recent block.
3. Run the free smoke test successfully.
4. Optionally run one paid testnet call with `SMOKE_PAID=1` only against a testnet URL.
5. Confirm `/info`, `/openapi.json`, `/.well-known/verify402.json`, `/.well-known/x402`, and `/llms.txt` look correct.
6. In Render, change only these variables for mainnet:
   - `X402_MODE` = `mainnet`
   - `FACILITATOR_URL` = your mainnet facilitator URL
   - `AGENT_URL` = `https://<your-mainnet-render-url>`
   - `TRUSTED_HOSTS` = `<your-mainnet-render-url>,localhost,127.0.0.1`
   - `PREFLIGHT_SECRET` = your long random secret
   - `PAY_TO_EVM` = mainnet receiving wallet
   - `PAY_TO_SVM` = mainnet receiving wallet
   - `CDP_API_KEY_ID` = your CDP key ID, if using Coinbase CDP
   - `CDP_API_KEY_SECRET` = your CDP key secret, if using Coinbase CDP
7. Save and redeploy.
8. Confirm `/health` reports `mode: "mainnet"`.
9. Confirm `/ready` returns `ok: true`.
10. Run the free smoke test against the mainnet URL.

## D. Roll back in Render if something breaks

1. Open the Render dashboard.
2. Open the verify402 web service.
3. Click "Deploys" or "Events".
4. Find the previous working deploy.
5. Click "Rollback" or redeploy that previous commit.
6. Wait until Render shows the service as live.
7. Open `/health` and `/ready`.
8. Run the smoke test again.
9. If the problem involved a leaked key, rotate that key even after rollback.
10. Record the failed deploy and restored deploy in your notes.

## E. What to paste back

Paste the live URL to OpenCode. Then run this exact command from the project folder, replacing `<url>` with your live URL:

```bash
SMOKE_BASE_URL=<url> npm run post-deploy
```

Paste the full output back to OpenCode.


## Free-tier survival checklist

1. Open the Render dashboard.
2. Click the verify402 web service.
3. Click "Settings".
4. Find "Instance Type" or "Plan".
5. Confirm it says "Free". If it says anything else, this section does not apply.
6. Open the service "Logs" or "Events" tab.
7. After about 15 minutes with no traffic, the free instance spins down.
8. The first request after spin-down can take about a minute.
9. During a cold start, logs may show the service starting again and then `verify402 listening on http://localhost:...`.
10. If the service has not woken yet, `/health` may be slow or fail; wait about a minute and retry.
11. Open "Usage" or "Billing" in Render.
12. Check the monthly hours used against the free allowance.
13. If usage is close to the monthly limit, reduce unnecessary wake-ups or upgrade later.
14. Remember that recovery records and /usage counters are in memory and are lost on any restart.


## Wallet safety

- Use public receiving addresses only. Never put a seed phrase or private key in the repo, Render, chat, an issue, a commit, or a log.
- Use a separate receiving account for verify402. Do not use a personal or trading wallet.
- For paid test calls later, create a separate throwaway testnet payer wallet. Fund it with only small testnet amounts.
- The MCP bridge uses `EVM_PRIVATE_KEY` only in the client, never in the server. Keep buyer keys out of the server environment.
