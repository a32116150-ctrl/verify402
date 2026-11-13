# mcprush server release: verify402-mcp 1.1.0

Status: **done — the mcprush listing serves 1.1.0.** Released 2026-11-13: the
release row reads `1.1.0 · 13 Nov 2026`, the current release on file is
`1.1.0`, the tool surface is **8 tools** (was 6), `inspect_402` and
`directory_402` are both listed, and the badge reads
`v1.1.0 · 8 tools · updated today`.

The release note published on the listing is the shorter variant below. The
steps and the long variant are kept for the next release.

mcprush version updates are a publisher-side Studio action. The publisher API is
read-only (`/api/pub/whoami`, `/api/pub/listings`, `/api/pub/calls`), so a key
alone cannot cut a release. The `mcprush` CLI is install-only (`add`,
`add-list`, `stack add`, `skill add`, `budget`, `login`) and has no release
command.

## What mcprush shows now

| Field | Value |
|---|---|
| Listing | `a32116150-ctrl/verify402-mcp` |
| Page | https://mcprush.com/a32116150-ctrl/verify402-mcp |
| Current release on file | `1.1.0` (13 Nov 2026) |
| Tool surface | 8 tools (`inspect_402`, `directory_402` added) |
| Release history | 7 rows (1.0.2, 1.0.3, 1.0.4, 1.0.5, 1.0.8, 1.0.9, 1.1.0) |
| Transport | Local · stdio (buyers reach it directly, nothing proxied) |
| Grade | A · 96/100 |
| Badge | https://mcprush.com/badge/verify402-mcp/card.svg |

Before the release it read `1.0.9` (scanned 26 Oct 2026) with a 6-tool surface.
Opening the release form auto-filled `1.1.0` — a hand-cut release holds the
version label until the next one is cut, which is why it had not moved on its
own.

## Cut a release (~3 minutes, browser)

1. Sign in and open **Studio → Releases**.
2. **Add new release** → **MCP server**.
3. Listing: **verify402-mcp**.
4. Version: **1.1.0**.
5. **What changed:** paste the block in the next section.
6. Click **Publish**.
7. Then open **Studio → Servers → Manage → Tool surface** and release the two
   new tools. `inspect_402` and `directory_402` reach the network, so mcprush
   will hold them until a human accepts them (**Dashboard → Changes → Accept**).

Later releases are not re-reviewed, so 1.1.0 should go through on the release
alone.

The listing is installed from the npm package and reached directly, so the
release carries the tool surface mcprush reads from `latest`, which is now
`1.1.0` (`gitHead f5d5d9afb0fbd4206d3f294ad13b0cab9ed4f3b1`).

## What changed — paste this

> Two new free tools and a payment token registry.
>
> - `inspect_402` (free, no wallet): read an x402 402 challenge before paying
>   it. Takes an endpoint URL, a challenge you already hold, or the
>   base64 `PAYMENT-REQUIRED` header. Returns price, token, network, payee, the
>   bound resource, a PASS / CAUTION / BLOCK verdict, typed reasons, and a
>   short-lived receipt. Only public hosts are fetched; localhost and private
>   ranges are refused. Network-reachable, no credentials, no spend.
> - `directory_402` (free, no wallet): the watched list of public x402
>   endpoints with a protocol verdict and a sign verdict per entry, and the
>   changes recorded since the last look. Read-only.
> - Payment token registry: USDC, USDT, DAI, USDG and WETH on Base, Arbitrum,
>   Ethereum and Base Sepolia, checked against CoinGecko's lists. Non-USDC
>   stables are named rather than flagged, and USD caps are applied with the
>   parity assumption stated.
> - Seller-signed terms manifests (`verify402/seller-terms@1`):
>   `policy.sellerTermsManifest` binds a 402's network, asset, amount and
>   timeout to one seller publication. Any drift between the two is a BLOCK
>   (`terms_mismatch`, naming the field); a resource with no published terms is
>   a CAUTION; a match records a signed `termsBinding` in the receipt.
> - Durable `/usage` counters survive restart when a durable path is
>   configured, and say so when they do not.
> - Opt-in anonymous tool pings (`VERIFY402_TELEMETRY=1`): tool name plus
>   ok/failed only. Never arguments, intents, results, wallets or IPs. Off by
>   default, and a failed ping never changes a tool's answer.
> - Bridge dependencies refreshed; clean install reports 0 audit
>   vulnerabilities.
>
> Published on npm as `verify402-mcp@1.1.0`
> (gitHead f5d5d9afb0fbd4206d3f294ad13b0cab9ed4f3b1). Live service reports
> `1.1.0`. No change to prices, payment networks or the free gate's contract.

## Shorter version (if the field is capped)

> Adds two free tools, `inspect_402` (read a 402 before paying it) and
> `directory_402` (watched public x402 directory), a verified payment token
> registry, and seller-signed terms manifests that BLOCK on drift between a
> 402 and the seller's publication. Durable usage counters and opt-in anonymous
> tool pings that carry no arguments. Published on npm as
> `verify402-mcp@1.1.0` (gitHead f5d5d9a).

## Verify after the release

```bash
curl -s https://mcprush.com/badge/verify402-mcp/card.svg | grep -o 'v[0-9.]* ·' | head -1
```

Expect `v1.1.0`. The listing's "current release on file" and the 8-tool surface
should both follow. If the badge still says 1.0.9 after a few minutes, the
release published but the package scan has not re-run; reopen Studio once to
trigger the read.

## Then the skill

`docs/mcprush-skill-submission.md` is the separate agent-skill listing. It
declares `requires.mcp: [verify402-mcp]` with no version pin, so it picks up
1.1.0 on its own. Submit it after the server listing moves, so the "servers it
uses" link on the skill page resolves to the release you meant.
