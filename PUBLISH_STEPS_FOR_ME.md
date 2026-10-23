# Release verify402-mcp 1.0.6 — for me

Status: npm `verify402-mcp@1.0.6` is **published** (gitHead
`fc1654964969f340a32c0420d5b5a3852f055310`). The repository metadata transition
is local commit `17ee189a20d1c601f5a4b4077882d74d609c1cc5`.

- npm `verify402-mcp@1.0.5` remains published and immutable; `1.0.4` is also immutable.
- MCP Registry publication of `1.0.6` is **pending and unverified**; the
  registry does **not** yet carry a `1.0.6` entry.
- Render deployment of `1.0.6` is **pending and unverified**; the live service
  has not been validated against this release.

The npm artifact and metadata transition are complete. Steps 8–10 below remain
gated and must not run automatically. Each remaining step is a gate: do not
start the next one until the previous one has been verified. The deploy push is
step 10.

## 1. Account for the immutable npm 1.0.5 package

From the repository root:

```bash
npm view verify402-mcp version dist.tarball gitHead
npm view verify402-mcp@1.0.5 version
```

Expected: `1.0.6` as the current latest, plus a resolvable `1.0.5` with its
registry tarball URL and published `gitHead`. npm `1.0.5` is immutable and
identifies commit `fc1654964969f340a32c0420d5b5a3852f055310` as its source. Do
**not** republish, overwrite, or unpublish it.

The working tree intentionally contains post-1.0.5 changes: the 1.0.6 release
records the preflight resource/network fix and the matching docs. The 1.0.5
package already defaults the bridge to Base Sepolia testnet (`eip155:84532`).
Do not treat these changes as permission to republish 1.0.5.

The 1.0.5 runtime already carries the testnet default. Do not attach the new
source to the existing `1.0.5` version.

## 2. Validate and inspect the release

All of these are offline and make no network request:

```bash
git status --short
node scripts/test-counts.mjs
TEST_OFFLINE=1 npm run test:offline
node scripts/check-discovery.mjs
node -e "console.log(require('./server.json').version, require('./mcp-bridge/package.json').version)"
```

Expected: the release identity is `1.0.6` in the source metadata, every offline
test passes, and discovery validation passes. Stop on any failure.

Review the public release surfaces before continuing. They must describe
`1.0.6` as published on npm and must not claim that the MCP Registry or Render
already serves it:

- `src/site/mcp.html` (the public `/mcp` page)
- the service manifest served at `/.well-known/verify402.json`
- `server.json` (the registry entry for the published 1.0.6 release)
- `README.md`, `examples/ONBOARDING.md`, `mcp-bridge/llms-install.md`

## 3. Review and commit the repository changes

Use explicit paths, never `git add -A`:

```bash
git status --short
git diff
```

Commit the reviewed files, including the `1.0.6` release metadata, testnet
demo docs, and the release-consistency and bridge-tool tests. Do not include
`.env` files, secrets, generated tarballs, or `VERIFY402_HANDOFF.md` unless you
intend to publish that review.

**Do not push this commit yet.** In this runbook, pushing `master` is a
deployment action, not a bookkeeping step. `render.yaml` does not set
`autoDeploy`, so the repository alone does not establish whether the Render
dashboard is configured to deploy on push. Keep the commit local until the
traceability gate in step 4 is satisfied.

npm publication (step 6) requires the approved commit to be publicly
traceable, but it does not require a push to `master`; the registry publish
(step 8) requires no push at all.

## 4. Make the approved commit publicly traceable without deploying — dashboard gate

npm records the local `HEAD` as `gitHead`, so the approved commit must exist on
the public GitHub remote before npm publication. It must not be pushed to a ref
that deploys. If the exact SHA is already public on a ref the dashboard confirms
is not deployed, verify that and skip the push.

**Repository evidence cannot decide this.** `render.yaml` has no `branch` and no
`autoDeploy` key, and the only GitHub workflow is `.github/workflows/test.yml`
(tests on a push to `master` and on pull requests; no deploy). The deploy
branch, auto-deploy, and preview settings live in the Render dashboard. Do not
treat `render.yaml` as proof that a push is inert.

Open the Render dashboard for the live `verify402` service and record all of
the following:

1. **Settings → Build & Deploy → Branch** — the connected repository and the
   exact branch. Confirm the repository is `a32116150-ctrl/verify402`, and
   record the branch even if it looks like `master`.
2. **Auto-Deploy** — on or off (the UI may label it "Auto-Deploy", "On Commit",
   or "Deploy on push").
3. **Preview Environments / pull-request previews** — enabled or disabled.
4. **Blueprint sync / auto-sync** — whether a push or a `render.yaml` change can
   trigger a sync.
5. **Current deployed commit** — the SHA the service runs now, so you can prove
   afterwards that no unintended deploy happened.

Then take exactly one path:

- **Auto-deploy is off, no preview environment will deploy, and no
  push-triggered blueprint sync is enabled:** push the approved commit to
  `master`, then re-check the dashboard and confirm the deployed SHA did **not**
  change.

  ```bash
  git push origin master
  ```

- **Auto-deploy is on, the connected branch is exactly `master`, and preview
  environments / PR deploys are disabled:** push the approved commit to a
  dedicated branch that is neither `master` nor the connected deploy branch
  (record the branch name you create), then verify that the GitHub commit page
  for the SHA resolves. Leave `master` untouched and confirm in the dashboard
  that no deploy started.

  ```bash
  git push origin HEAD:refs/heads/<the-branch-you-recorded>
  ```
- **Anything else** — the connected branch is not `master`, the auto-deploy or
  preview settings cannot be read, or no branch can be confirmed non-deploying:
  **stop.** Do not push any branch and do not publish npm; without a publicly
  traceable commit, npm publication must not proceed. Resolve the dashboard
  setting first.

Never push `master` in this step while auto-deploy is on; `master` is reserved
for the deploy gate in step 10. This runbook does not verify the dashboard
settings itself; it requires you to record them.

## 5. Create and verify the npm 1.0.6 artifact

Do **not** publish in this step. Build the artifact locally and inspect it.

```bash
cd mcp-bridge
npm ci
npm test
npm pack --dry-run
npm pack
tar -tzf verify402-mcp-1.0.6.tgz
```

Then verify, from the tarball contents:

- the version in `package/package.json` is `1.0.6`;
- `package/index.mjs`, `payment-policy.mjs`, `paid-call.mjs`, `budget.mjs`,
  `log.mjs`, `README.md`, `.env.example`, `LICENSE`, and `NOTICE` are present;
- the bridge default is Base Sepolia (`eip155:84532`) and mainnet requires an
  explicit `VERIFY402_NETWORKS=eip155:8453`;
- importing `package/index.mjs` does not load a `.env` file;
- the MCP tool binding maps each paid tool to exactly one paid route.

Delete the local tarball after inspection.

## 6. Publish npm 1.0.6 — completed

Step 4 must have made the exact commit being published publicly traceable, and
step 5 must have verified the artifact. Confirm the commit first:

```bash
git rev-parse HEAD
git status --short
```

The printed SHA must be the one you pushed in step 4, and the working tree must
be clean. Then:

```bash
cd mcp-bridge
npm publish
npm view verify402-mcp version dist.tarball gitHead
npm view verify402-mcp@1.0.6 version
```

Expected: `1.0.6`, a resolvable tarball, and a `gitHead` equal to the SHA above
that resolves on GitHub. Do not publish from an unpushed commit. npm versions
are immutable: never republish, overwrite, or unpublish `1.0.6` after this step.

## 7. Transition the release metadata to published 1.0.6 — completed

Step 6 printed `1.0.6` for both the latest version and the pinned version. The
repository was updated from `candidate-unpublished` to "published `1.0.6`" in
local commit `17ee189a20d1c601f5a4b4077882d74d609c1cc5`. The checklist below is
the record of that transition:

- `src/version.mjs` — set `PUBLISHED_VERSION = "1.0.6"` and change
  `RELEASE_STATUS` from the candidate value to the published/released value.
- `src/manifest.mjs` — published release status, published version, tarball
  URL, quick-install command, and the published-package default; keep planned
  fields only where they still describe something real.
- `src/payment-mode.mjs` — the generated `/llms.txt` install line and any
  "unpublished candidate" note.
- `src/site/mcp.html` — hero, lead, registry callout, and install snippets.
- `README.md`, `examples/ONBOARDING.md`, `mcp-bridge/llms-install.md` — move the
  install pins from `1.0.5` to `1.0.6`.
- `server.json` — replace the "unpublished candidate" wording with
  published-`1.0.6` wording. Registry metadata must never call a published
  version unpublished.
- `test/release-consistency.test.mjs` — re-point the published-version
  assertions and the "never present 1.0.6 as already published" checks at the
  new state. The prior tests pinned `1.0.5` and failed until this update; that
  failure was the guard, not a reason to weaken the test.

Re-run the offline gates, inspect the diff, and commit with explicit paths:

```bash
TEST_OFFLINE=1 npm run test:offline
node scripts/check-discovery.mjs
node scripts/test-counts.mjs
git status --short
git diff
```

Do not push this commit yet; step 10 covers deployment. The metadata commit must
also be publicly traceable before it is deployed; publish it to the same
non-deploying branch from step 4 if one was used, or keep it local until the
deploy gate.

Known limitation: the already-published npm tarball is immutable, so the
README and install text embedded in `1.0.6` reflect the pre-publication state.
The repository copies updated here are what the registry metadata, the public
site, and the deployment use. If the npm page still shows candidate wording,
that is a limitation of the immutable artifact — do not republish `1.0.6` to
work around it.

## 8. Publish the MCP Registry entry — separate approval, only when the npm 1.0.6 artifact exists

Step 6 is complete; step 7's metadata commit exists locally. This registry
publication is its own approval gate; npm publication and the metadata update
do not approve it. The checked-in
`server.json` must already describe a **published** `1.0.6`: `VERIFY402_NETWORKS`
defaults to Base Sepolia testnet (`eip155:84532`), it is optional, and Base
mainnet (`eip155:8453`) is an explicit opt-in. Do not publish the entry if it
still contains candidate or "unpublished" wording.

```bash
mcp-publisher login github   # only if this machine is not already authenticated
mcp-publisher validate server.json
mcp-publisher publish server.json
```

If `mcp-publisher validate` rejects the metadata, **stop** and correct the
metadata. Do not fabricate fields to satisfy the validator, and do not publish
the entry against the immutable `1.0.5` version.

## 9. Verify the actual 1.0.6 registry version

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.0.6"
```

Expected: a `server` object with `version: "1.0.6"`, the Base Sepolia default in
its environment-variable metadata, active status, and no "unpublished
candidate" wording. A `1.0.4` or `1.0.3` response is not proof that this step
succeeded.

## 10. Deploy only after a separate approval

Deployment is a separate decision. Step 4 may have pushed the approved commit to
a branch that was confirmed non-deploying, or to `master` with auto-deploy off;
no earlier step deploys or changes the live service.

Re-check the Render dashboard settings recorded in step 4 (connected branch,
auto-deploy, preview environments). If any of them changed, stop and repeat
step 4. If you cannot still verify them, do not push `master`.

- **The approved commit is on a non-deploying branch:** merge it into the
  connected deploy branch (`master`, when the dashboard confirms that) with a
  fast-forward merge, so the deployed SHA is the approved commit. If a merge
  commit is unavoidable, record its SHA and deploy that. This is the first
  intentional push to `master`.
- **Auto-deploy off:** push or merge to `master`, then trigger the deploy from
  the dashboard and confirm the deployed SHA.
- **Auto-deploy on:** the push or merge itself deploys; watch the dashboard and
  record the deployed SHA.

Deploy only the approved, traceable SHA. If the metadata commit exists, it is
the one to deploy, because it carries the published-1.0.6 surfaces.

```bash
git log --oneline -2
```

Then run the free-only post-deploy check:

```bash
SMOKE_BASE_URL=https://verify402.onrender.com \
  EXPECTED_VERSION=1.0.6 EXPECTED_MODE=testnet \
  npm run post-deploy
```

Expected: all checks pass, `/health` says `testnet`, `/info` shows
`mcp.version: "1.0.6"`, `/openapi.json` shows `info.version: "1.0.6"`, the
landing page does not advertise a mainnet demo, and `/llms.txt` describes the
testnet payment rail and the published-package install. The dashboard's
deployed commit must equal the metadata commit, or the recorded merge commit
that contains it.

Do not assert that the live service still reports its previous version after a
push unless you have verified that with `/info` or `/health`. With auto-deploy
on, the push changes the live service immediately, and a green post-deploy run
is the only evidence that it succeeded.

Do not make a paid call as part of this checklist. The free gate and the
post-deploy checks are sufficient to verify the release surfaces.

## If something is wrong

- **npm already has 1.0.6:** do not overwrite or unpublish it. Fix forward with
  a new patch version after approval.
- **The published runtime differs from local:** stop and treat the difference as
  a new code change requiring a new package version and a new release.
- **The registry or live service is still on an earlier version:** that is
  expected until the human steps above are completed. Never claim those
  external artifacts are updated before verifying them.
- **GitHub does not resolve the approved SHA:** stop before npm publication.
  Confirm the push landed on the intended non-deploying branch and that no
  history rewrite removed it. A local-only commit is not publicly traceable.
- **The push is rejected as non-fast-forward:** stop. Do not force-push a
  shared branch; reconcile the history deliberately and re-run the checks.
- **The Render dashboard shows a branch other than the one you assumed:** stop.
  Do not push any branch and do not deploy until the connected branch and
  auto-deploy behavior are understood.
- **A push from step 4 started a deploy:** the branch was not actually
  non-deploying. Stop, verify the live version with `/info`, keep npm and the
  registry gates closed if they are still pending, and record the early
  deployment instead of announcing the release.
- **npm 1.0.6 exists but metadata still says unpublished:** stop. Complete the
  metadata transition in step 7 and publish the registry entry only from that
  state; do not deploy a tree that calls the published version unpublished.
- **A public page claims 1.0.6 is published:** that is true for npm now that
  the metadata commit is in place. It must not also claim that the MCP Registry
  entry or the Render deployment is complete until those gates are verified.
