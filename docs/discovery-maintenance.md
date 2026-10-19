# Discovery Maintenance & Change Procedures

This runbook guides maintainers through updating Verify402's machine-readable discovery surfaces when adding tools, changing prices, modifying endpoints, updating networks, or altering MCP transports.

---

## 1. When Modifying a Price

Canonical pricing is defined in:
1. `src/server.mjs` (`PRICE`, `SAFETY_PRICE`, `ROUTE_PRICE`, `QUOTECHECK_PRICE`, `DEPTH_PRICE`)
2. `mcp-bridge/budget.mjs` (`DEFAULT_PRICES`)

### Update Checklist:
1. Update price variables in `src/server.mjs`.
2. Update the corresponding route price in `mcp-bridge/budget.mjs` (`DEFAULT_PRICES`).
3. Update `src/manifest.mjs` default prices.
4. Verify tests pass:
   ```bash
   node test/discovery.test.mjs
   node scripts/check-discovery.mjs
   ```

---

## 2. When Adding or Renaming a Tool

Tools are exposed through both REST endpoints (`src/server.mjs`) and the MCP Bridge (`mcp-bridge/index.mjs`).

### Update Checklist:
1. **MCP Bridge:**
   - Register the tool in `mcp-bridge/index.mjs` under `server.tool(...)`.
   - Update `DESCRIPTIONS` dictionary in `mcp-bridge/index.mjs`.
2. **Canonical Manifest:**
   - Add tool metadata to `integrations.mcp.tools` in `src/manifest.mjs`.
3. **OpenAPI Specification:**
   - Add operation description and schemas to `src/openapi.mjs`.
4. **Bazaar Extension (if paid):**
   - Add `declareDiscoveryExtension` to route in `src/server.mjs`.
5. **Documentation:**
   - Add tool entry to `README.md`, `src/site/docs.html`, and `src/site/mcp.html`.
6. **Validate:**
   ```bash
   npm test
   node scripts/check-discovery.mjs
   ```

---

## 3. When Releasing a New Version

1. Bump `version` in:
   - Root `package.json`
   - `mcp-bridge/package.json`
   - `server.json` (top-level and `packages[].version`)
   - `src/manifest.mjs` (`version: "x.y.z"`)
   - `src/openapi.mjs` (`info.version: "x.y.z"`)
2. Build and publish release asset to GitHub releases:
   `https://github.com/a32116150-ctrl/verify402/releases/download/mcp-vX.Y.Z/verify402-mcp-X.Y.Z.tgz`
3. If publishing to npm:
   ```bash
   cd mcp-bridge
   npm publish --access public
   ```
4. If publishing to the MCP Registry:
   ```bash
   mcp-publisher validate server.json
   mcp-publisher publish server.json
   ```

---

## 4. When Adding a Supported Blockchain or Network

Verify402 supports Base mainnet and Solana mainnet. If adding another chain (e.g. Arbitrum, Polygon):
1. Configure chain in `src/config.mjs` (`CHAINS`).
2. Add network CAIP-2 identifier to `NETWORKS` in `src/server.mjs`.
3. Update `src/manifest.mjs` (`supportedNetworks`).
4. Update `mcp-bridge/payment-policy.mjs` (`DEFAULT_NETWORKS`).
5. Run policy tests:
   ```bash
   node --test mcp-bridge/test/payment-policy.test.mjs
   npm test
   ```

---

## 5. Automated CI Discovery Gates

GitHub Actions runs `npm test` on every PR and push to master. CI will fail if:
- `server.json` description exceeds 100 characters or violates the MCP Registry schema.
- `mcpName` in `mcp-bridge/package.json` differs from `server.json`.
- Prices in `src/manifest.mjs` or `src/openapi.mjs` differ from `budget.mjs`.
- Any required public endpoint is omitted from OpenAPI.
- A sensitive private key or credential pattern is detected in public metadata.
