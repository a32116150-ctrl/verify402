# Publishing verify402-mcp to the MCP Registry

This guide explains how to publish the verify402 MCP server to the official
MCP Registry at https://registry.modelcontextprotocol.io/.

## Prerequisites

- Node.js 20+
- An npm account with publish access to the `verify402-mcp` package
- A GitHub account that owns the `a32116150-ctrl/verify402` repository
- The `mcp-publisher` CLI (installed below)

## Step 1: Publish to npm (if not already published)

The MCP Registry is a metadata registry; the actual package must live on npm.

```bash
cd mcp-bridge
npm publish --access public
```

Verify it appeared:
```bash
npm view verify402-mcp version
```

## Step 2: Verify the package contains `mcpName`

The MCP Registry verifies package ownership by checking that `package.json`
contains an `mcpName` field matching the `name` in `server.json`:

```json
{
  "mcpName": "io.github.a32116150-ctrl/verify402-mcp"
}
```

This is already set in `mcp-bridge/package.json`.

## Step 3: Install mcp-publisher

The official `mcp-publisher` CLI tool is distributed via Homebrew or GitHub releases:

```bash
# macOS via Homebrew:
brew install mcp-publisher

# Or direct download on macOS/Linux:
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

Verify installation:
```bash
mcp-publisher --help
```

## Step 4: Authenticate with GitHub

The registry uses GitHub for namespace verification. The `io.github.a32116150-ctrl`
namespace requires authentication from the GitHub account that owns the repository:

```bash
mcp-publisher login github
```

Follow the browser-based OAuth flow.

## Step 5: Validate the manifest locally

Before publishing, validate `server.json`:

```bash
mcp-publisher validate server.json
```

Note: The MCP Registry strictly limits the `description` field to 100 characters.

The checked-in `server.json` describes the **source** release (`1.0.6`), whose
runtime default is Base Sepolia testnet (`eip155:84532`). It therefore declares
that default explicitly and keeps `VERIFY402_NETWORKS` optional; Base mainnet
(`eip155:8453`) is an opt-in. This metadata is only truthful once a `1.0.6`
package artifact actually exists and is published: the registry entry must
never be used to claim that the immutable npm `1.0.4` package — whose runtime
default is Base mainnet — defaults to testnet. Publish the registry entry only
for the version that is really published.

## Step 6: Publish to the registry

```bash
mcp-publisher publish server.json
```

The metadata is validated before publication. If `mcp-publisher validate`
rejects it, stop: registry publication is blocked until the metadata is
corrected, and the published version must still match the artifact that
exists.

## Step 7: Verify the listing

Check that the server appears in the registry:

```bash
# Query all versions for your server
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions" | jq .

# Query the active release status directly
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.0.6" | jq ._meta
```

Or visit the official registry API documentation:
https://registry.modelcontextprotocol.io/docs

## Updating the listing

When you release a new version:

1. Bump `version` in `mcp-bridge/package.json`
2. Bump `version` in `server.json` (both top-level and inside `packages[]`)
3. Publish to npm: `cd mcp-bridge && npm publish`
4. Re-publish to the registry: `mcp-publisher publish server.json`

## Troubleshooting

### "Namespace not verified"
You must authenticate with the GitHub account that owns the repository.
The namespace `io.github.a32116150-ctrl` is tied to the `a32116150-ctrl` GitHub user.

### "Package not found on npm"
Publish the package to npm first. The registry validates that the npm package
exists and contains the matching `mcpName`.

### "Version mismatch"
The `version` in `server.json` and in `packages[].version` must match the
version published to npm.

## Registry publishing is manual

Registry publishing is an explicit release action, never part of automated
builds. The `npm test` and CI pipeline validate the manifest structure but
do not publish.

## Current status

Current release: `verify402-mcp@1.0.6` is published on npm and is `latest`.
That version is immutable, maps to git commit
`954702575b9df58a08e8dbdac45d680ecf3cc365`, and defaults the bridge to Base
Sepolia testnet (`eip155:84532`). The previous `1.0.5` package remains
published and immutable.

The official MCP Registry lists `1.0.6` as active and latest
(`publishedAt: 2026-10-23T22:12:34.131712Z`). The checked-in `server.json`
matches the published package. This repository does **not** publish packages or
registry entries automatically.

| Step | Status |
|---|---|
| `server.json` created | DONE — manifest is `1.0.6`, testnet default declared |
| `mcpName` in package.json | DONE |
| Published to npm | DONE — `verify402-mcp@1.0.6` is live and `latest` (immutable) |
| Published to MCP Registry | DONE — active `1.0.6`, `isLatest: true` |
