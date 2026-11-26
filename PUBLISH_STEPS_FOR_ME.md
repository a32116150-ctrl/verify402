# Release verify402-mcp 1.1.3 — for me

Status: **prepared, not published, not deployed, registry entry not updated.**
`1.1.2` exists so the published npm package matches a fix the bridge needs: the
installed payer carries the challenge's `extensions.bazaar` declaration into the
payment payload it sends to the facilitator, so a settlement can be cataloged.
Until this release, paid calls from the installable bridge could not enter the
Bazaar even though the service's own buyer script could. What `1.1.2` contains:

- The bridge payer sends `extensions.bazaar` (and `resource`) in the payment
  payload, echoing exactly what the 402 challenge declares.
- The default public origin moved from `verify402.onrender.com` to
  `https://vex402.online`; the old host still serves the same service.
- No protocol, schema, price, or tool change. The tool set, prices and Guard
  behaviour are unchanged. `verify402-mcp@1.1.2` is the first installable
  version that can be submitted to the Bazaar.

The service release follows the same version identity; its own runtime did not
change at this version beyond the pieces already on `master` (the `/findings`
page permalinks, the idempotency scope fix, the `/safety` 500-character fix).

Steps 1–7 are one continuous push: validation, committing this metadata, the
non-deploying branch for traceability, the artifact check, the npm publish, and
the metadata flip recorded in `src/version.mjs` and `CHANGELOG.md`. Steps 8–10 —
the MCP Registry entry, the GitHub release, and the `master` push that deploys —
are **separate approvals**. Nothing may be claimed as deployed until `/info` on
the live host reports `1.1.2`.

`1.1.1`, `1.1.0`, `1.0.9`, `1.0.8`, `1.0.7`, `1.0.6` remain immutable on npm and
in the MCP Registry. Do not overwrite or unpublish any of them.

## 0. Known blocker to check first

`npm whoami` currently answers `E401` from this machine. Publishing may need a
fresh `npm login` plus an OTP from the account's authenticator app.

Check this **before** changing any metadata:

```bash
npm whoami
npm access get status verify402-mcp
```

If `npm whoami` fails, stop and complete the login. Nothing else in this
runbook depends on it.

## 1. Account for the immutable npm packages

```bash
npm view verify402-mcp version dist.tarball gitHead
npm view verify402-mcp@1.1.1 version
npm view verify402-mcp@1.1.2 version
```

Expected before publication: `1.1.1` as current `latest`. The 1.1.2 artifact
must not shadow an existing 1.1.2 — if it exists, stop.

## 2. Validate and inspect the release

All of these are offline and make no network request:

```bash
git status --short
node scripts/test-counts.mjs
TEST_OFFLINE=1 npm run test:offline
node scripts/check-discovery.mjs
node -e "console.log(require('./server.json').version, require('./mcp-bridge/package.json').version)"
```

Expected: the release identity is `1.1.2` in the source metadata, every offline
test passes, and discovery validation passes. Stop on any failure.

Review the public release surfaces: none of them may claim `1.1.2` is deployed
or active before steps 6–10 verify it:

- `src/site/mcp.html`
- the service manifest at `/.well-known/verify402.json`
- `server.json`
- `README.md`, `examples/ONBOARDING.md`, `mcp-bridge/llms-install.md`
- `CHANGELOG.md` and `mcp-bridge/README.md`

## 3. Review and commit the repository changes

Use explicit paths, never `git add -A`.

```bash
git status --short
git diff
```

Commit the reviewed files, including the `1.1.2` release metadata. Do not
include `.env` files, secrets, or generated tarballs.

**Do not merge this into `master` yet.** In this runbook, merging `master` is a
deployment action, not a bookkeeping step.

## 4. Make the approved commit publicly traceable without deploying — dashboard gate

npm records the local `HEAD` as `gitHead`, so the approved commit must exist on
the public GitHub remote before npm publication. It must not be pushed to a
ref that deploys.

Open the Render dashboard for the live `verify402` service and record:

1. **Settings → Build & Deploy → Branch** — `a32116150-ctrl/verify402` and the
   exact connected branch (`master`, expected).
2. **Auto-Deploy** — on or off.
3. **Preview Environments** — enabled or disabled.
4. **Blueprint sync / auto-sync** — whether a push can trigger a sync.
5. **Current deployed commit** — to prove no unintended deploy happened.

If auto-deploy is on and the connected branch is `master`, push the approved
commit to a dedicated non-deploying branch and verify the GitHub commit page
resolves:

```bash
git push origin HEAD:refs/heads/release-1.1.2
```

If no branch can be confirmed non-deploying, stop: do not push and do not
publish npm. Never push `master` in this step; it is reserved for step 10.

## 5. Create and verify the npm 1.1.2 artifact

Do **not** publish in this step. Build the artifact locally and inspect it.

```bash
cd mcp-bridge
npm ci
npm test
npm pack --dry-run
npm pack
tar -tzf verify402-mcp-1.1.2.tgz
```

Then verify, from the tarball contents:

- `package/package.json` says `1.1.2`;
- `index.mjs`, `x402-client.mjs`, `client-id.mjs`, `payment-policy.mjs`,
  `paid-call.mjs`, `budget.mjs`, `log.mjs`, `README.md`, `.env.example`,
  `LICENSE`, and `NOTICE` are present;
- `package/package.json` has **no** `@x402/axios` or `@x402/evm` dependency;
- the bridge default is Base Sepolia (`eip155:84532`) and mainnet requires an
  explicit `VERIFY402_NETWORKS=eip155:8453`;
- importing `package/index.mjs` does not load a `.env` file;
- the bridge source carries the `extensions.bazaar` echo (grep `bazaar` in
  `x402-client.mjs`).

Install the packed tarball into a fresh directory and prove the audit claim:

```bash
mkdir -p /tmp/verify402-audit && cd /tmp/verify402-audit
npm init -y >/dev/null
npm i /path/to/verify402-mcp-1.1.2.tgz
npm audit
npm ls @x402
```

Expected: `npm audit` reports **0 vulnerabilities**, and `npm ls @x402` shows
nothing. Delete the local tarball and audit directory after inspection.

## 6. Publish npm 1.1.2

Step 4 made the exact commit publicly traceable, and step 5 verified the
artifact. Confirm the commit first:

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
npm view verify402-mcp@1.1.2 version
```

Expected: `1.1.2`, a resolvable tarball, and a `gitHead` equal to the SHA above
that resolves on GitHub. Do not publish from an unpushed commit.

If `npm publish` asks for a one-time password, get it from the account's
authenticator app. Do not work around 2FA.

## 7. Transition the release metadata to published 1.1.2

After step 6 prints `1.1.2` for both the latest and the pinned version, record
the artifact facts in the repository:

- `src/version.mjs` — `PUBLISHED_VERSION = "1.1.2"`, `RELEASE_VERSION =
  "1.1.2"`, `RELEASE_STATUS = "published"`.
- `src/manifest.mjs` — published release status, version, tarball URL,
  quick-install command, and the published-package default.
- `src/site/mcp.html` — registry callout and install snippets.
- `README.md`, `examples/ONBOARDING.md`, `mcp-bridge/llms-install.md` — install
  pins point at `1.1.2`; keep earlier versions described only as history.
- `server.json` — published-`1.1.2` wording in both version fields.
- `CHANGELOG.md` — the `1.1.2` entry records npm `gitHead`, shasum, registry
  timestamp, and the post-deploy result once known.
- `test/release-consistency.test.mjs` — the assertions re-point at `1.1.2`.

Re-run the offline gates, inspect the diff, and commit with explicit paths:

```bash
TEST_OFFLINE=1 npm run test:offline
node scripts/check-discovery.mjs
node scripts/test-counts.mjs
git status --short
git diff
```

Do not merge this commit into `master` yet; step 10 covers deployment.

## 8. Publish the MCP Registry entry

This step runs only when the npm 1.1.2 artifact exists and is verified.

Step 6 has succeeded and the checked-in `server.json` describes a **published**
`1.1.2`: `VERIFY402_NETWORKS` defaults to Base Sepolia testnet
(`eip155:84532`), it is optional, and Base mainnet (`eip155:8453`) is an
explicit opt-in. This step runs only when the npm `1.1.2` artifact exists and
is verified.

```bash
mcp-publisher login github   # only if not already authenticated
mcp-publisher validate server.json
mcp-publisher publish server.json
```

If `mcp-publisher validate` rejects the metadata, stop and correct it. Do not
fabricate fields to satisfy the validator.

## 9. Verify the actual 1.1.2 registry version

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.1.2"
```

Expect a `server` object with `version: "1.1.2"`, the Base Sepolia default,
`status: active`, and `isLatest: true`. Record the returned `publishedAt`.

## 10. Deploy after a separate approval

Deployment is a separate decision. Re-check the dashboard settings recorded in
step 4. If any changed, stop and repeat step 4.

- **Auto-deploy off:** merge to `master`, then trigger the deploy from the
  dashboard and confirm the deployed SHA.
- **Auto-deploy on:** the merge itself deploys; watch the dashboard and record
  the deployed SHA.

Deploy only the approved, traceable SHA. Then run the free-only post-deploy
check:

```bash
SMOKE_BASE_URL=https://vex402.online \
  EXPECTED_VERSION=1.1.2 EXPECTED_MODE=testnet \
  npm run post-deploy
```

Expected: all checks pass, `/health` says `testnet`, `/info` shows
`mcp.version: "1.1.2"`, `/openapi.json` shows `info.version: "1.1.2"`, and the
landing page does not advertise a mainnet demo. The dashboard's deployed SHA
must equal the metadata commit, or the recorded merge commit that contains it.

Do not make a paid call as part of this checklist.

## 11. GitHub release

After steps 6, 9, and 10 are verified:

```bash
git tag -a mcp-v1.1.2 -m "verify402-mcp 1.1.2"
git push origin mcp-v1.1.2
```

Then create the release from that tag, with notes that say what 1.1.2 is and is
not: npm `gitHead`, the registry `publishedAt`, the post-deploy result.

## Previous releases

`1.1.1` — published 2026-11-16, a marker release so the installable version
matched the deployed service; `mcp-v1.1.1` GitHub release and the Render deploy
completed 2026-11-17.

`1.1.0` — published 2026-11-13: two free tools (`inspect_402`,
`directory_402`), seller-signed terms binding, the payment-token registry,
durable `/usage` counters, and opt-in anonymous pings.

## If something is wrong

- **npm already has 1.1.2:** do not overwrite or unpublish it. Double-check
  `npm view`; if a 1.1.2 was published outside this process, inspect it.
- **The published runtime differs from local:** stop and treat the difference
  as a new code change requiring a new package version and a new release.
- **The registry or the live service is still on an earlier version:** expected
  until steps 9 and 10 complete. Never claim otherwise before verifying.
- **A push from step 4 started a deploy:** the branch was not actually
  non-deploying. Stop, verify the live version with `/info`, and record the
  early deployment instead of announcing it.
- **A public page claims 1.1.2 is published:** only acceptable after step 6, and
  the claims must match which artifact is actually verified.

---

# Release verify402-mcp 1.1.3 — for me

Docs-only release; the tree, this runbook and the registry now say 1.1.3.
No runtime, price, schema, tool or network change. The release announces the
live mainnet instance (https://api.vex402.online, Base + Solana mainnet, USDC,
Coinbase CDP facilitator). Safety defaults do not change: the bridge still
pays Base Sepolia testnet by default.

## Validate and inspect the release

```bash
TEST_OFFLINE=1 npm run test:offline
grep -Rni "1.1.2" . --exclude-dir=node_modules --exclude-dir=.git
```

The 1.1.2 references left in-tree are historical and must still read as
history (CHANGELOG 1.1.2 entry, 1.1.2 blog posts and cards, 1.1.2 MCP Registry
verification output). Do not rewrite them.

## Create and verify the npm 1.1.3 artifact

```bash
cd mcp-bridge
npm ci --no-audit --no-fund
npm pack
tar -tzf verify402-mcp-1.1.3.tgz
```

Expected: `package/package.json` is `1.1.3`.

## Publish npm 1.1.3

This step runs once the artifact above is verified:

```bash
npm publish --access public
npm view verify402-mcp@1.1.3 version
```

## Transition the release metadata to published 1.1.3

This step runs only when the npm 1.1.3 artifact exists — do not claim
`published` otherwise. The tree already carries the 1.1.3 identity
(`src/version.mjs`, `server.json`, `CHANGELOG.md`, root and bridge
`package.json` + lockfiles). npm publication is the remaining gate, not
metadata.

## Verify the actual 1.1.3 registry version

```bash
mcp-publisher validate server.json
mcp-publisher publish server.json
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.1.3"
```

Expect `version: "1.1.3"`, the Base Sepolia default, `status: active`, and
`isLatest: true`. If validation rejects the description, correct it — do not
fabricate fields.

## Deploy, after a separate approval

After npm publish is verified: push the release commit, confirm Render redeploys,
then on the mainnet host:

```bash
git pull origin master
systemctl restart verify402
curl -s https://api.vex402.online/health
```

Expect `mode: mainnet`, `recoveryStore: ok`, and `version: 1.1.3`.

---

# Release verify402-mcp 1.1.4 — for me

Stdio framing fix over 1.1.3: `logInfo()` diagnostics moved to stderr; stdout
now carries only JSON-RPC frames. No tool, price, schema, network or policy
change. The release exists because some containerised MCP harnesses read the
server as a client and rejected the pre-1.1.4 stdout banner.

## Validate and inspect the release

```bash
TEST_OFFLINE=1 npm run test:offline
git diff mcp-bridge/index.mjs mcp-bridge/log.mjs
```

Boot check: the first line written to stdout must parse as JSON-RPC.

## Create and verify the npm 1.1.4 artifact

```bash
cd mcp-bridge
npm ci --no-audit --no-fund
npm pack
tar -tzf verify402-mcp-1.1.4.tgz
```

Expected: `package/package.json` is `1.1.4`.

## Publish npm 1.1.4

This step runs once the artifact above is verified:

```bash
npm publish --access public
npm view verify402-mcp@1.1.4 version
```

## Transition the release metadata to published 1.1.4

This step runs only when the npm 1.1.4 artifact exists — do not claim
`published` otherwise. The tree carries the 1.1.4 identity; npm publication is
the remaining gate, not metadata.

## Verify the actual 1.1.4 registry version

```bash
mcp-publisher validate server.json
mcp-publisher publish server.json
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.1.4"
```

Expect `version: "1.1.4"`, the Base Sepolia default, `status: active`, and
`isLatest: true`. If validation rejects a field, correct it — never fabricate.

## Deploy, after a separate approval

After npm publish is verified: push the release commit, confirm Render redeploys,
then on the mainnet host:

```bash
git pull origin master
systemctl restart verify402
curl -s https://api.vex402.online/health
```

Expect `mode: mainnet`, `recoveryStore: ok`, `version: 1.1.4`.

---

# Release verify402-mcp 1.1.7 — for me

Metadata-only correction. 1.1.6 already moved the paid-call default to Base
mainnet (`eip155:8453`, real USDC) at https://vex402.online, but its MCP
Registry entry still advertised `VERIFY402_NETWORKS` as defaulting to
`eip155:84532`. Registry versions are immutable, so 1.1.7 republishes the same
code with corrected metadata: default `eip155:8453`, Base Sepolia demo as an
explicit opt-in. No tool, price, schema or runtime change.

## Validate and inspect the release

```bash
TEST_OFFLINE=1 npm run test:offline
npx -y verify402-mcp@1.1.7 --help
```

## Create and verify the npm 1.1.7 artifact

```bash
cd mcp-bridge
npm ci --no-audit --no-fund
npm pack
tar -tzf verify402-mcp-1.1.7.tgz
```

Expected: `package/package.json` is `1.1.7`.

## Publish npm 1.1.7

This step runs once the artifact above is verified. It needs the account's 2FA
code, entered by the account owner:

```bash
npm publish --access public
npm view verify402-mcp@1.1.7 version
```

## Transition the release metadata to published 1.1.7

This step runs only when the npm 1.1.7 artifact exists. The tree carries the
1.1.7 identity; npm publication is the remaining gate, not metadata.

## Verify the actual 1.1.7 registry version

```bash
mcp-publisher validate server.json
mcp-publisher publish server.json
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.1.7"
```

Expect `version: "1.1.7"`, the Base mainnet default, `status: active`, and
`isLatest: true`. If validation rejects a field, correct it — never fabricate.

## Deploy after separate approval

After npm publish is verified: push the release commit, then on the VPS:

```bash
cd /opt/verify402
git fetch origin
git reset --hard origin/master
sudo systemctl restart verify402
curl -s https://vex402.online/health
```

Expect `mode: mainnet`, `recoveryStore: ok`, `version: 1.1.7`.

# Release verify402-mcp 2.0.0 — for me

Status: **prepared, not published, not deployed, registry entry not updated.**
`2.0.0` adds the paid assurance endpoint and the v2 positioning.

## Validate and inspect the release
Run `npm run test:offline` and inspect the release metadata before changing anything.

## Create and verify the npm 2.0.0 artifact
Build and verify the npm tarball for `verify402-mcp@2.0.0`.

## Publish npm 2.0.0
Publish to npm with the authenticator code. This step runs only when the npm 2.0.0 artifact exists and is verified.

## Transition the release metadata to published 2.0.0
Update `src/version.mjs`, `PUBLISHED_VERSION`, and the MCP Registry entry only after npm succeeds.

## Verify the actual 2.0.0 registry version
Check the MCP Registry and npm for `2.0.0`.

Deployed only after the registry and npm versions were verified. Superseded by 2.0.1.

## Release verify402-mcp 2.0.1 — for me

Status: **published on npm 2026-11-19 and deployed; registry entry updated by the operator.**
2.0.1 is a consistency patch over 2.0.0 — text and metadata only, no behavior change.

## Validate and inspect the release
Run `npm run test:offline` and inspect the release metadata before changing anything.

## Create and verify the npm 2.0.1 artifact
Build and verify the npm tarball for `verify402-mcp@2.0.1`.

## Publish npm 2.0.1
Publish to npm with the authenticator code. This step runs only when the npm 2.0.1 artifact exists and is verified.

## Transition the release metadata to published 2.0.1
Update `src/version.mjs`, `PUBLISHED_VERSION`, and the MCP Registry entry only after npm succeeds.

## Verify the actual 2.0.1 registry version
Check the MCP Registry and npm for `2.0.1`.

Deployed after the registry and npm versions were verified. Superseded by 2.5.0.

## Release verify402-mcp 2.5.0 — for me

Status: **prepared, not published.**
The mainnet-only release. The testnet demo is retired; paid calls are
mainnet-only.

## Validate and inspect the release
Run `npm run test:offline` and inspect the release metadata before changing anything.

## Create and verify the npm 2.5.0 artifact
Build and verify the npm tarball for `verify402-mcp@2.5.0`.

## Publish npm 2.5.0
Publish to npm with the authenticator code. This step runs only when the npm 2.5.0 artifact exists and is verified.

## Transition the release metadata to published 2.5.0
Update `src/version.mjs`, `PUBLISHED_VERSION`, and the MCP Registry entry only after npm succeeds.

## Verify the actual 2.5.0 registry version
Check the MCP Registry and npm for `2.5.0`.

Deployed after the registry and npm versions were verified. Superseded by 2.6.0.

## Release verify402-mcp 3.1.0 — for me

Advice on transaction preflights: explanation, wallet preview, fixes, paid hints.

## Validate and inspect the release
Run `npm run test:offline` and inspect the release metadata before changing anything.

## Create and verify the npm 3.1.0 artifact
Build and verify the npm tarball for `verify402-mcp@3.1.0`.

## Publish npm 3.1.0
Publish to npm with the authenticator code. This step runs only when the npm 3.1.0 artifact exists and is verified.

## Transition the release metadata to published 3.1.0
Update `src/version.mjs`, `PUBLISHED_VERSION`, and the MCP Registry entry only after npm succeeds.

## Verify the actual 3.1.0 registry version
Check the MCP Registry and npm for `3.1.0`.

## Deploy only after
Deploy only after the registry and npm versions are verified.

## Release verify402-mcp 3.0.1 — for me

Solana payment recovery and `quote` on preflight_gate.

## Validate and inspect the release
Run `npm run test:offline` and inspect the release metadata before changing anything.

## Create and verify the npm 3.0.1 artifact
Build and verify the npm tarball for `verify402-mcp@3.0.1`.

## Publish npm 3.0.1
Publish to npm with the authenticator code. This step runs only when the npm 3.0.1 artifact exists and is verified.

## Transition the release metadata to published 3.0.1
Update `src/version.mjs`, `PUBLISHED_VERSION`, and the MCP Registry entry only after npm succeeds.

## Verify the actual 3.0.1 registry version
Check the MCP Registry and npm for `3.0.1`.

## Deploy only after
Deploy only after the registry and npm versions are verified.

## Release verify402-mcp 2.6.1 — for me

Price defaults and public copy match the live $0.02 / $0.10 service.

## Validate and inspect the release
Run `npm run test:offline` and inspect the release metadata before changing anything.

## Create and verify the npm 2.6.1 artifact
Build and verify the npm tarball for `verify402-mcp@2.6.1`.

## Publish npm 2.6.1
Publish to npm with the authenticator code. This step runs only when the npm 2.6.1 artifact exists and is verified.

## Transition the release metadata to published 2.6.1
Update `src/version.mjs`, `PUBLISHED_VERSION`, and the MCP Registry entry only after npm succeeds.

## Verify the actual 2.6.1 registry version
Check the MCP Registry and npm for `2.6.1`.

## Deploy only after
Deploy only after the registry and npm versions are verified.

## Release verify402-mcp 2.6.0 — for me

Every install lists all nine tools; paid tools refuse without EVM_PRIVATE_KEY.

## Validate and inspect the release
Run `npm run test:offline` and inspect the release metadata before changing anything.

## Create and verify the npm 2.6.0 artifact
Build and verify the npm tarball for `verify402-mcp@2.6.0`.

## Publish npm 2.6.0
Publish to npm with the authenticator code. This step runs only when the npm 2.6.0 artifact exists and is verified.

## Transition the release metadata to published 2.6.0
Update `src/version.mjs`, `PUBLISHED_VERSION`, and the MCP Registry entry only after npm succeeds.

## Verify the actual 2.6.0 registry version
Check the MCP Registry and npm for `2.6.0`.

## Deploy only after
Deploy only after the registry and npm versions are verified.
