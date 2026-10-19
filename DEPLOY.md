# Going live with verify402

Order matters: measurement first (testnet), identity second, mainnet last.
Nothing below unlocks revenue without the last section being done by a human -
the go-to-market cannot be automated and pretending otherwise costs weeks.

## 0. Pre-flight (local, 5 minutes)

```bash
npm install
npm test                # 5/5: bytecode check, quoter agreement, no-invented-profit,
                        #      monotonicity, determinism
BYPASS_PAYMENT=1 node src/server.mjs &
curl -s localhost:4021/health
curl -s -X POST localhost:4021/safety \
  -H 'content-type: application/json' \
  -d '{"tokenAddress":"0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE","intendedUsd":500}'
```

## 1. Free deployment (testnet)

Render's Hobby tier is $0 (512 MB). Fastest path: the repo already contains
`render.yaml`, so on render.com → New Blueprint → point at the GitHub repo
→ it reads the blueprint and deploys. Two clicks, `FACILITATOR_URL` already
defaulted. Alternatives: Fly.io, Railway, any container host - the
Dockerfile is standard.

1. Push this repo to GitHub.
2. On Render: New → Web Service → the repo → it detects the Dockerfile.
3. Environment (testnet first):
   ```
   X402_MODE=testnet
   # PUBLIC facilitator, testnet-only, fine for launch:
   FACILITATOR_URL=https://x402.org/facilitator
   # Optional but recommended: stable HMAC key for /preflight receipts.
   # Generate with `openssl rand -hex 32`; never commit it.
   PREFLIGHT_SECRET=<32-byte hex>
   ```
   `PAY_TO_EVM` / `PAY_TO_SVM` default to the owner's wallets in code.
   If `PREFLIGHT_SECRET` is unset, receipts use a per-process secret: they
   verify only inside that process. That is acceptable for a single 90-second
   gate, but set the secret before running more than one instance.
4. Verify public behavior:
   - `curl https://<app>.onrender.com/health`
   - `curl https://<app>.onrender.com/safety` (no payment) → expect HTTP/1.1 402
     with a base64 `PAYMENT-REQUIRED` header.

Cold start note: Render free instances sleep. First call after idle pays a
~30 s spin-up. x402's default `maxTimeoutSeconds` tolerates this, but the very
first transaction of a cold window can fail - if this bites, move to a $7
always-on instance.

## 2. ERC-8004 identity (one command, human-only)

The agent's key stays with its owner. In `.env` (gitignored):

```
CHAIN=base-sepolia
AGENT_URL=https://<app>.onrender.com
PRIVATE_KEY=0x...        # separate gas wallet; testnet ETH from Coinbase's faucet
```

```bash
npm run register        # refuses without PRIVATE_KEY, AGENT_URL and CONFIRM=yes
```

This mints the agent NFT with the full registration file on-chain (data URI -
no IPFS to lose). Verify on `sepolia.basescan.org` and paste the address/chain
into the landing page. The honest limitation: ERC-8004 provides discovery and
a reputation surface, not buyers.

## 3. Mainnet (only after testnet settlements work end to end)

- `X402_MODE=mainnet`
- A mainnet facilitator, e.g. Coinbase CDP:
  `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
  (create a CDP API key; do NOT reuse `x402.org/facilitator` - it is testnet-only)
- The server refuses to start in mainnet mode without `FACILITATOR_URL`. That
  refusal is a feature; never bypass it.
- Settle one real $0.05 payment yourself as the first buyer before letting
  strangers pay: proof the rail works and receipts land.

## 4. Distribution (the actual bottleneck)

x402 has 20k+ sellers and average revenue per seller is ~nothing; discovery,
not deployment, is where services die. Submissions, in order of yield:

1. **Bazaar listing** - already wired: both paid routes carry
   `declareDiscoveryExtension` schemas, so facilitators catalog them when a
   paying buyer echoes the extension. Manual submission: follow
   docs.x402.org/extensions/bazaar.
2. **ERC-8004 identity** - done above; the registration file names the MCP
   bridge so agent frameworks can wire it without reading this repo.
3. **MCP bridge piece** (`mcp-bridge/`) - the thing agents can actually
   consume today. Point one MCP client at the deployed URL and use both tools
   once, for real.
4. **Show HN / r/ethdev / X** - see arbi-store's `LAUNCH.md`; the honest hook
   is that the service's most common answer is "no, this has no edge" and it
   is SELLING that answer, on-chain, per call.

## What NOT to do

- Do not add a "premium score API", affiliate tokens, or guaranteed-profit
  copy. The whole product is the negative result, verified.
- Do not remove the `no invented profit on a 100k USDC round trip` test.
  That check failing means drift in venue math, and the engine must halt,
  not warn.
- Do not run mainnet without a real facilitator; testnet money printing
  nothing teaches nothing.
