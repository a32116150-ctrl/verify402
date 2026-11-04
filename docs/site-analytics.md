# Site analytics: what we count and what we refuse to count

`GET /usage/site` answers the one funnel question the project could not answer:
**is anyone reaching the pages the marketing points at?**

Before this, the only usage signal was `GET /usage` (free-gate calls) and paid
settlements. Neither says whether a visitor opened `/preflight#try` or arrived
from a forum post.

## What it counts

Aggregate counts of successfully served HTML pages:

| field | meaning |
|---|---|
| `total` | HTML page views in the current window |
| `byPath` | views per path (query strings and fragments stripped) |
| `byReferrer` | views per referring host, `direct` when there is none |
| `byDay` | views per UTC day (last 60 days) |
| `skipped` | views not counted, with the reason |
| `scope` | `durable-single-instance` or `process-local` |

Only `GET` responses with `200` and `content-type: text/html` count. Paid routes,
JSON discovery, assets, 404s, and 402 challenges are not page views by
construction, so they cannot inflate the number.

## What it deliberately does not do

- **No cookies, no fingerprint, no IP address.** Nothing per-visitor is stored
  or derivable from the file.
- **No query strings.** A query can carry an intent, a token, or an email; paths
  are normalized before counting. Unrecognized paths are bucketed as `/other`.
- **No unique-visitor claim.** These are views, not people. The note in the
  response says so.
- **No identity claim.** The only identity-backed usage signal remains a paid
  settlement and its payer address.

## Bots

Crawlers, uptime monitors, and HTTP clients are skipped by `User-Agent` and the
skip is counted in `skipped.crawler_or_client`, so the number is not silently
adjusted. A browser with no `User-Agent` lands in `skipped.no_user_agent`.

The match is intentionally conservative: a false skip undercounts, while
counting bots would tell a story the traffic does not support.

## Persistence

- With `RECOVERY_DB_PATH` set, counts are written to
  `<recovery dir>/site-analytics.json` (debounced, atomic rename), so they
  survive a restart or deploy.
- With `SITE_ANALYTICS_PATH` set, that path is used instead.
- With neither, counts are process-local and the snapshot says so. A free Render
  instance that spins down loses them.

`scope` in the response is the honest answer for the running process; never
report a durable number from a memory-only instance.

## Reading the funnel

```bash
curl -sS https://verify402.onrender.com/usage/site | jq
```

Look at, in order:

1. `byReferrer` — is any outside source actually sending people?
2. `byPath` — does `/preflight` get views after the landing page? A big gap
   between `/` and `/preflight` is a copy/CTA problem, not a traffic problem.
3. `byDay` — is there a pulse after a post, or a flat line?

Page views are a diagnostic, not a success metric. The success metric is a paid
settlement from someone who is not the operator.
