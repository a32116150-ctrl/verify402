# GO-LIVE — one document, start to finish

Everything needed to take verify402 from "a folder on this Mac" to "agents
paying money", in plain order. Nothing here promises profit - it gets the
service LIVE so that the real-world test (does anyone pay?) can happen.

---

## The service you are deploying (plain-language summary)

verify402 is an HTTP API that AI agents pay per call, in USDC, to ask four
questions before committing money:

| Endpoint | Price | Question it answers |
|---|---|---|
| `POST /verify` | $0.05 | "Is this claimed arbitrage real, right now?" |
| `POST /safety` | $0.10 | "Is this token safe to buy?" (honeypot / phantom price / exit cost) |
| `POST /route` | $0.03 | "What would the chain ACTUALLY pay for this swap?" |
| `POST /quotecheck` | $0.05 | "Someone offered me this number - is it honest?" (fair / overpaying / too_good_to_be_true) |

Free surfaces: `/findings` (live no_edge verdicts on ETH majors), `/info`,
`/health`, `/.well-known/agent-registration.json`.

All measurement comes from the venues' own on-chain code (Uniswap QuoterV2,
each router's getAmountsOut) at one pinned block. 11 automated tests guard it.

---

## STEP 0 — What you need before starting (~10 min)

- [ ] GitHub account (free)
- [ ] Render account (free) — render.com, sign up with GitHub
- [ ] A **buyer-test wallet**: any EVM wallet with USDC on **Base Sepolia**
      (testnet). This proves payments work. Coinbase Developer Platform has a
      free testnet faucet.
- [ ] A **gas wallet**: separate wallet that will own the ERC-8004 agent
      identity. Needs ~0.001 ETH on Base Sepolia for one transaction.
      THIS PRIVATE KEY NEVER LEAVES `.env`. Never paste it in chat, never commit it.

---

## STEP 1 — Push the repo to GitHub (~5 min)

From `/Users/mac/Desktop/verify402`:

```bash
gh repo create verify402 --public --source=. --push
# (if gh is not installed: create repo manually on github.com, then git remote add origin ... and git push -u origin master)
```

After this: Settings → check the repo is Public (that IS the trust surface),
Actions not required.

---

## STEP 2 — Deploy to Render Blueprint (~5 min + build)

1. Go to render.com → **New + → Blueprint**.
2. Select the `verify402` repository.
3. Render reads `render.yaml` (already in the repo: Node runtime, free plan,
   testnet payment rails, `FACILITATOR_URL` pre-set).
4. Click **Apply/Deploy**. Wait for "live".

You now have a URL like `https://verify402-xxxx.onrender.com`.

**Verify the deployment** (replace YOUR_URL everywhere below):

```bash
curl https://YOUR_URL/health
curl https://YOUR_URL/findings | head -c 400     # free verdicts, should say no_edge
curl -i -X POST https://YOUR_URL/safety \
  -H 'content-type: application/json' \
  -d '{"tokenAddress":"WETH"}' | head -5          # expect HTTP/1.1 402 Payment Required
```

If the third command returns 402: the paywall is provably live and NOT in
bypass mode. Do not proceed until all three succeed.

---

## STEP 3 — Prove one real payment works (~10 min)

This is the step that converts theory into a settled payment:

1. Fund the buyer-test wallet with testnet USDC + gas
   (Coinbase CDP faucet → Base Sepolia).
2. From the repo, run the one-call buyer script:

```bash
npm i --no-save dotenv viem
node --input-type=module -e "
import { config } from 'dotenv'; config();
import('@x402/fetch').then(async ({ wrapFetchWithPayment }) => {
  const { createWalletClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { baseSepolia } = await import('viem/chains');
  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
  const paid = await wrapFetchWithPayment(fetch, wallet);
  const res = await paid('https://YOUR_URL/route', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: 1, tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '1000000000' }),
  });
  console.log('status', res.status, JSON.stringify(await res.json()).slice(0, 300));
});
"
```

(`BUYER_PRIVATE_KEY` goes in `.env` as always; it is testnet-only, throwaway
OK.) Expected: `status 200`. Check the buyer wallet holds ~$0.03 less USDC
and `PAY_TO_EVM` wallet holds $0.03 more on basescan.

---

## STEP 4 — Mint the agent identity (ERC-8004, one command, ~5 min)

In `.env` (the gas wallet from STEP 0):

```
CHAIN=base-sepolia
AGENT_URL=https://YOUR_URL
PRIVATE_KEY=0x...
CONFIRM=yes
```

```bash
npm run register
```

Output gives a tx hash → wait 1 confirmation on sepolia.basescan.org → 
note the **agentId** (the NFT token id) and the identity registry address
`0x8004A818BFB912233c491871b3d84c89A494BD9e`.

Then on Render → your service → Environment, add:

```
AGENT_ID = <the token id>
IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e
CHAIN_ID = 84532
```

Render redeploys automatically. `/.well-known/agent-registration.json` now
binds the domain to the on-chain agent (domain-verification satisfied).

---

## STEP 5 — Tell agents it exists (~20 min)

Copy the posts in `FORUM_POSTS.md` (a quotecheck-flavored lead:
"your bot was offered 3x the real price — this service catches that").

Order of yield: **x402 Slack → Show HN → r/ethdev → X**.
Reply to every comment in the first hour: that is where credibility forms.
The MCP bridge (`mcp-bridge/`) is what Claude/agent users run themselves —
its README has the exact config JSON to paste into any MCP client.

---

## WHERE THE REVENUE GOES

### The flow

```
agent pays USDC ──▶ facilitator verifies + settles on-chain ──▶ YOUR wallet
```

The buyer's USDC is **transferred directly to the payTo address** - the
service never escrows, holds, or touches the money. There is no server-side
wallet, no signing key in the service, nothing to hack that holds funds.

- Buyer pays on **Base** (Sepolia testnet now, mainnet later)
  → lands in the EVM wallet:
  `0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb`
- Buyer pays on **Solana** (devnet now, mainnet later)
  → lands in the Solana wallet:
  `BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ`

You can change these any time via `PAY_TO_EVM` / `PAY_TO_SVM` env vars on
Render + redeploy. **Receiving requires no gas and no key.**

### How to watch it arrive

- Base: basescan.org → search the above address → newest token movements
  (USDC) = settlements, one per paid call.
- Solana: solscan.io → same idea for devnet/mainnet SOL-side payments.
- Each settlement also returns a tx hash in the response payload
  (`settlement` / `payment-response` fields) - a receipt is provable per call.

### Fees and frictions (honest list)

- Testnet phase: the x402.org facilitator is free and testnet-only.
- Mainnet phase: Coinbase CDP facilitator may charge a fee per settlement
  (check their pricing page at cdp.coinbase.com when you set `X402_MODE=mainnet`).
- Render free tier: $0/month. Cold starts add ~30 s to the first call after
  idle - if that causes failed paid calls, the $7/month always-on plan fixes it.
- No gas for you to receive; buyer pays gas via the facilitator rail.

### How money becomes "your money"

USDC that lands on Base = already your USDC. Options whenever the balance
matters: send to an exchange (deposit) and off-ramp, swap to fiat via
Coinbase, or just hold USDC on-chain. Nothing else to do - no treasury,
no claiming, no unlock schedules.

---

## STEP 6 — Mainnet (LAST, only after STEP 3 works)

- Render env: `X402_MODE=mainnet`, `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
  (needs a CDP API key), plus **real USDC in buyer wallets** - no more faucets.
- The service refuses to start in mainnet mode without a real facilitator.
  Do not bypass that guard; it is the difference between play money and real.
- Make the FIRST mainnet payment yourself as the first buyer before any
  stranger does.

## What NOT to do

- Never paste the PRIVATE_KEY anywhere except `.env` (gitignored).
- Never remove the paywall to "test in production" - use BYPASS_PAYMENT locally only.
- Never edit the "no invented profit" test away. It failing = engine lying.
- Do not add profit-advertising copy anywhere. The honest "usually no_edge" IS the brand.

## Minimum weekly rhythm after launch

- Check wallet arrivals + any referral sources (5 min).
- One reply in the Slack thread / comment feeds (10 min).
- If a real agent developer engages: hand them the MCP bridge README first.
