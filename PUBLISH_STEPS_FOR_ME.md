# Release verify402-mcp 1.1.0 — for me

Status: **prepared, not published.** The `1.1.0` release adds two free MCP
tools to the bridge (`inspect_402` and `directory_402`) and is the first
change to the published package since `1.0.9`. The release metadata is
bumped on the `release/1.1.0` branch; `master` still says `1.0.9`, which is
what the live service actually serves today. Nothing below has run yet, so
nothing may be claimed as published.

What `1.1.0` contains:

- `inspect_402` — read an x402 402 challenge before paying it (endpoint URL
  or a challenge you already have): price, token, network, payee, the bound
  resource, a PASS / CAUTION / BLOCK verdict, typed reasons, and a receipt.
- `directory_402` — the watched list of public x402 endpoints with protocol
  and sign verdicts and recorded changes.
- Both are free, registered without a wallet, and are not bound to a paid
  route.
- The service behind them already serves `POST /inspect` and
  `GET /directory.json` on `master`.

The previous release, `1.0.9`, remains immutable on npm and in the MCP
Registry. Do not overwrite or unpublish it.

## 0. Known blocker to check first

`npm whoami` and `npm profile get` currently answer `E401` from this machine,
and npm now restricts publishing with tokens that bypass 2FA. Publishing may
need a fresh `npm login` plus an OTP from the account's authenticator app.
Check this **before** changing any metadata:

```bash
npm whoami
npm access get status verify402-mcp
```

If `npm whoami` fails, stop and complete the login (or have the owner supply a
granular publish token) before step 6. Nothing else in this runbook depends on
it, and no step before step 6 should be attempted first.

## 1. Account for the immutable npm 1.0.9, 1.0.8, and 1.0.7 packages

```bash
npm view verify402-mcp version dist.tarball gitHead
npm view verify402-mcp@1.0.9 version
npm view verify402-mcp@1.0.8 version
npm view verify402-mcp@1.0.7 version
```

Expected before publication: `1.0.9` as current `latest`, plus resolvable
`1.0.9`, `1.0.8`, and `1.0.7` artifacts. npm versions are immutable: do
**not** republish, overwrite, or unpublish any of them.

## 2. Validate and inspect the release

All of these are offline and make no network request:

```bash
git status --short
node scripts/test-counts.mjs
TEST_OFFLINE=1 npm run test:offline
node scripts/check-discovery.mjs
node -e "console.log(require('./server.json').version, require('./mcp-bridge/package.json').version)"
```

Expected: the release identity is `1.1.0` in the source metadata, every
offline test passes, and discovery validation passes. Stop on any failure.

Review the public release surfaces before continuing. They must describe
`1.1.0` as the published npm package; registry and Render claims are added
only after steps 8–10 verify them:

- `src/site/mcp.html` (the public `/mcp` page)
- the service manifest served at `/.well-known/verify402.json`
- `server.json` (the registry entry for the published 1.1.0 release)
- `README.md`, `examples/ONBOARDING.md`, `mcp-bridge/llms-install.md`
- `CHANGELOG.md` and `mcp-bridge/README.md`

## 3. Review and commit the repository changes

Use explicit paths, never `git add -A`:

```bash
git status --short
git diff
```

Commit the reviewed files, including the `1.1.0` release metadata and the two
new free MCP tools. Do not include `.env` files, secrets, generated tarballs,
or `VERIFY402_HANDOFF.md` unless you intend to publish that review.

**Do not merge this into `master` yet.** In this runbook, merging `master` is
a deployment action, not a bookkeeping step.

## 4. Make the approved commit publicly traceable without deploying — dashboard gate

npm records the local `HEAD` as `gitHead`, so the approved commit must exist
on the public GitHub remote before npm publication. It must not be pushed to a
ref that deploys.

Open the Render dashboard for the live `verify402` service and record:

1. **Settings → Build & Deploy → Branch** — connected repository and exact
   branch. Confirm `a32116150-ctrl/verify402` and record the branch.
2. **Auto-Deploy** — on or off.
3. **Preview Environments / pull-request previews** — enabled or disabled.
4. **Blueprint sync / auto-sync** — whether a push can trigger a sync.
5. **Current deployed commit** — the SHA it runs now, to prove afterwards that
   no unintended deploy happened.

If auto-deploy is on and the connected branch is `master`, push the approved
commit to a dedicated non-deploying branch and verify the GitHub commit page
resolves:

```bash
git push origin HEAD:refs/heads/release-1.1.0
```

If no branch can be confirmed non-deploying, stop: do not push and do not
publish npm. Never push `master` in this step; it is reserved for step 10.

## 5. Create and verify the npm 1.1.0 artifact

Do **not** publish in this step. Build the artifact locally and inspect it.

```bash
cd mcp-bridge
npm ci
npm test
npm pack --dry-run
npm pack
tar -tzf verify402-mcp-1.1.0.tgz
```

Then verify, from the tarball contents:

- `package/package.json` says `1.1.0`;
- `index.mjs`, `x402-client.mjs`, `client-id.mjs`, `payment-policy.mjs`,
  `paid-call.mjs`, `budget.mjs`, `log.mjs`, `README.md`, `.env.example`,
  `LICENSE`, and `NOTICE` are present;
- `package/package.json` has **no** `@x402/axios` or `@x402/evm` dependency;
- the bridge default is Base Sepolia (`eip155:84532`) and mainnet requires an
  explicit `VERIFY402_NETWORKS=eip155:8453`;
- importing `package/index.mjs` does not load a `.env` file;
- the MCP tool binding maps each paid tool to exactly one paid route;
- `inspect_402` and `directory_402` are registered before the paid block and
  are not in the paid-route map.

Install the packed tarball into a fresh directory and prove the audit claim:

```bash
mkdir -p /tmp/verify402-audit && cd /tmp/verify402-audit
npm init -y >/dev/null
npm i /path/to/verify402-mcp-1.1.0.tgz
npm audit
npm ls @x402
```

Expected: `npm audit` reports **0 vulnerabilities**, and `npm ls @x402` shows
nothing. Delete the local tarball and audit directory after inspection.

## 6. Publish npm 1.1.0

Step 4 must have made the exact commit being published publicly traceable, and
step 5 must have verified the artifact. Confirm the commit first:

```bash
git rev-parse HEAD
git status --short
```

The printed SHA must be the one pushed in step 4, and the working tree must be
clean. Then:

```bash
cd mcp-bridge
npm publish
npm view verify402-mcp version dist.tarball gitHead
npm view verify402-mcp@1.1.0 version
```

Expected: `1.1.0`, a resolvable tarball, and a `gitHead` equal to the SHA above
that resolves on GitHub. Do not publish from an unpushed commit.

If `npm publish` asks for a one-time password, get it from the account's
authenticator app. Do not work around 2FA.

## 7. Transition the release metadata to published 1.1.0

After step 6 prints `1.1.0` for both the latest version and the pinned
version, record the artifact facts in the repository:

- `src/version.mjs` — `PUBLISHED_VERSION = "1.1.0"`, `RELEASE_VERSION =
  "1.1.0"`, `RELEASE_STATUS = "published"`.
- `src/manifest.mjs` — published release status, version, tarball URL,
  quick-install command, and the published-package default.
- `src/payment-mode.mjs` — the generated `/llms.txt` install line (it reads the
  published version; do not hardcode a second copy).
- `src/site/mcp.html` — hero, lead, registry callout, and install snippets.
- `README.md`, `examples/ONBOARDING.md`, `mcp-bridge/llms-install.md` — install
  pins point at `1.1.0`; keep `1.0.9`/`1.0.8`/`1.0.7` described only as
  immutable history.
- `server.json` — published-`1.1.0` wording in both version fields.
- `CHANGELOG.md` — the `1.1.0` entry records npm `gitHead`, shasum, registry
  timestamp, GitHub release time, and the post-deploy result once known.
- `test/release-consistency.test.mjs` — re-point the published-version
  assertions and messages at `1.1.0`.

Re-run the offline gates, inspect the diff, and commit with explicit paths:

```bash
TEST_OFFLINE=1 npm run test:offline
node scripts/check-discovery.mjs
node scripts/test-counts.mjs
git status --short
git diff
```

Do not merge this commit into `master` yet; step 10 covers deployment.

Known limitation: the already-published npm tarball is immutable, so the
README and install text embedded in `1.1.0` reflect the state at publication.
The repository copies updated here are what the registry metadata, the public
site, and the deployment use.

## 8. Publish the MCP Registry entry

Step 6 has succeeded and the checked-in `server.json` describes a **published**
`1.1.0`: `VERIFY402_NETWORKS` defaults to Base Sepolia testnet
(`eip155:84532`), it is optional, and Base mainnet (`eip155:8453`) is an
explicit opt-in. This step runs only when the npm 1.1.0 artifact exists and is
verified.

```bash
mcp-publisher login github   # only if this machine is not already authenticated
mcp-publisher validate server.json
mcp-publisher publish server.json
```

If `mcp-publisher validate` rejects the metadata, **stop** and correct the
metadata. Do not fabricate fields to satisfy the validator, and do not publish
the entry against an earlier version.

## 9. Verify the actual 1.1.0 registry version

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.1.0"
```

Expect a `server` object with `version: "1.1.0"`, the Base Sepolia default in
its environment-variable metadata, `status: active`, and `isLatest: true`.
Record the returned `publishedAt`.

## 10. Deploy only after a separate approval

Deployment is a separate decision. Re-check the Render dashboard settings
recorded in step 4. If any of them changed, stop and repeat step 4. If they
cannot still be verified, do not merge into `master`.

- **The approved commit is on a non-deploying branch:** merge it into the
  connected deploy branch (`master`, when the dashboard confirms that) with a
  fast-forward merge, so the deployed SHA is the approved commit.
- **Auto-deploy off:** merge to `master`, then trigger the deploy from the
  dashboard and confirm the deployed SHA.
- **Auto-deploy on:** the merge itself deploys; watch the dashboard and record
  the deployed SHA.

Deploy only the approved, traceable SHA. It must contain the published-1.1.0
metadata.

Then run the free-only post-deploy check:

```bash
SMOKE_BASE_URL=https://verify402.onrender.com \
  EXPECTED_VERSION=1.1.0 EXPECTED_MODE=testnet \
  npm run post-deploy
```

Expected: all checks pass, `/health` says `testnet`, `/info` shows
`mcp.version: "1.1.0"`, `/openapi.json` shows `info.version: "1.1.0"`, the
landing page does not advertise a mainnet demo, and `/llms.txt` describes the
testnet payment rail and the published-package install. The dashboard's
deployed commit must equal the metadata commit, or the recorded merge commit
that contains it.

Do not make a paid call as part of this checklist. The free gate and the
post-deploy checks are sufficient to verify the release surfaces.

## 11. GitHub release

After steps 6, 9, and 10 are verified, publish the GitHub release so the
artifact is linkable:

```bash
git tag -a mcp-v1.1.0 -m "verify402-mcp 1.1.0"
git push origin mcp-v1.1.0
```

Then create the release from that tag, with notes that lead with the two new
free tools and state the npm `gitHead`, the registry `publishedAt`, and the
post-deploy result.

## Previous release

`1.0.9` — published 2026-10-26. npm `gitHead`
`60c7b6fcffb1c1d47561577b752d9c68b8ecba16`; MCP Registry active/latest at
`2026-10-26T11:56:38.535824Z`; GitHub release `mcp-v1.0.9` published
`2026-10-26T11:58:20Z`; Render reported `1.0.9` and the free-only post-deploy
check passed 29/29.

## If something is wrong

- **npm already has 1.1.0:** do not overwrite or unpublish it. Fix forward with
  a new patch version after approval.
- **The published runtime differs from local:** stop and treat the difference as
  a new code change requiring a new package version and a new release.
- **The registry or live service is still on an earlier version:** that is
  expected until the human steps above are completed. Never claim those
  external artifacts are updated before verifying them.
- **GitHub does not resolve the approved SHA:** stop before npm publication.
- **The push is rejected as non-fast-forward:** stop. Do not force-push a shared
  branch; reconcile the history deliberately and re-run the checks.
- **The Render dashboard shows a branch other than the one you assumed:** stop.
- **A push from step 4 started a deploy:** the branch was not actually
  non-deploying. Stop, verify the live version with `/info`, and record the
  early deployment instead of announcing the release.
- **A public page claims 1.1.0 is published:** true for npm after step 6. It must
  not also claim the MCP Registry entry or the Render deployment is complete
  until steps 9 and 10 are verified.
