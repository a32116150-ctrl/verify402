# Verify402 Distribution Directory & Registry Checklist

**Document Version:** 1.0.0
**Updated:** 2026-10-19
**Repository:** [https://github.com/a32116150-ctrl/verify402](https://github.com/a32116150-ctrl/verify402)
**Production URL:** [https://verify402.onrender.com](https://verify402.onrender.com)

This checklist tracks official and third-party registry listings for Verify402. Every entry is backed by verified repository evidence and explicit status codes:
- **VERIFIED**: Proven active and authenticated with cryptographic or on-chain proof.
- **IMPLEMENTED**: Code and protocol metadata are deployed and serving live responses.
- **PREPARED**: Manifests and submission texts are formatted and validated locally, pending external manual credentials or human approval.
- **NOT SUBMITTED**: Identified catalog where submission has not yet occurred.
- **SUBMITTED**: Formally submitted, waiting for third-party review.
- **ACCEPTED**: Approved and listed publicly.
- **REJECTED**: Rejected with documented rationale.

---

## Registry & Directory Summary Matrix

| Directory / Catalog | Category | Status | Blocker / Requirement |
|---|---|---|---|
| **Official MCP Registry** | MCP Specification | **VERIFIED** | Active listing at `io.github.a32116150-ctrl/verify402-mcp` v1.0.2 |
| **x402 Bazaar Discovery** | Protocol Discovery | **IMPLEMENTED** | Active in 402 challenge responses across all 5 paid routes |
| **402 Index** | x402 Directory | **VERIFIED** | Active via `/.well-known/402index-verify.txt` domain proof |
| **ERC-8004 Agent Card** | A2A Discovery | **IMPLEMENTED** | Active via `/.well-known/agent-card.json` |
| **Smithery.ai** | MCP Directory | **PREPARED** | Ready for submission once `verify402-mcp` is on npm |
| **Glama.ai** | MCP Registry | **PREPARED** | Submission text prepared for web form submission |
| **PulseMCP** | MCP Index | **PREPARED** | Submission payload prepared for review |
| **Cursor Directory** | Client Configs | **PREPARED** | Tested client configuration prepared |

---

## 1. Official MCP Registry (`modelcontextprotocol.io`)

- **Status:** **VERIFIED & ACTIVE**
- **Catalog URL:** [https://registry.modelcontextprotocol.io/](https://registry.modelcontextprotocol.io/)
- **Repository Reference:** [https://github.com/modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)
- **Local Manifest:** [`server.json`](../server.json)
- **Package Configuration:** `mcp-bridge/package.json` (`mcpName: "io.github.a32116150-ctrl/verify402-mcp"`)
- **Published Namespace:** `io.github.a32116150-ctrl/verify402-mcp`
- **Published Version:** `1.0.2`
- **Published At:** `2026-10-19T22:58:26Z`
- **Registry Query:**
  ```bash
  curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.0.2" | jq ._meta
  ```
- **Documentation:** Detailed guide in [`docs/mcp-registry-publishing.md`](mcp-registry-publishing.md).

---

## 2. x402 Bazaar Protocol Discovery

- **Status:** **IMPLEMENTED (ACTIVE)**
- **Specification:** [x402 Bazaar Extension Specification](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md)
- **Implementation:** `src/server.mjs` via `@x402/extensions/bazaar` (`declareDiscoveryExtension`).
- **Live Endpoints:**
  - `POST /verify` ($0.05 USDC)
  - `POST /safety` ($0.10 USDC)
  - `POST /route` ($0.03 USDC)
  - `POST /quotecheck` ($0.05 USDC)
  - `POST /depth` ($0.05 USDC)
- **Mechanism:** Any unpaid HTTP request receives `402 Payment Required` with an `extensions.bazaar` object containing `method`, `bodyType`, `input`, `inputSchema`, and `output` examples.
- **Verification Command:**
  ```bash
  curl -s -X POST https://verify402.onrender.com/verify -H "content-type: application/json" -d '{"target":"WETH"}' | jq .extensions.bazaar
  ```
- **Documentation:** Detailed guide in [`docs/x402-discovery.md`](x402-discovery.md).

---

## 3. 402 Index (`402index.com`)

- **Status:** **VERIFIED**
- **Catalog URL:** [https://402index.com/](https://402index.com/)
- **Verification Path:** `/.well-known/402index-verify.txt`
- **Verification Token Hash:** `83f1c578d78d2b9645a4640bcc77939bdfbae84a86b7798d4d753e18085f3b14`
- **Evidence:** Served live with `text/plain` content type on production.

---

## 4. Smithery.ai

- **Status:** **PREPARED**
- **Catalog URL:** [https://smithery.ai/](https://smithery.ai/)
- **Submission Process:** Smithery indexes servers from GitHub repositories or npm packages.
- **Submission Payload:**
  - Name: `verify402`
  - GitHub: `https://github.com/a32116150-ctrl/verify402`
  - Subfolder: `mcp-bridge`
  - Command: `npx -y verify402-mcp` (or GitHub tarball URL)
- **Action Required:** Submit repository URL at `https://smithery.ai/submit` after npm package publication.

---

## 5. Glama.ai MCP Registry

- **Status:** **PREPARED**
- **Catalog URL:** [https://glama.ai/mcp/servers](https://glama.ai/mcp/servers)
- **Submission Process:** Web form submission at `https://glama.ai/mcp/servers/submit`.
- **Submission Details:**
  - **Name:** verify402
  - **Title:** verify402 — On-chain truth verification & preflight gate
  - **Description:** Fail-closed preflight safety gate for crypto payments plus 5 paid on-chain truth checks (arbitrage, token safety, best route, quote fairness, depth).
  - **Transport:** stdio
  - **Repository URL:** `https://github.com/a32116150-ctrl/verify402`
  - **Tags:** `crypto`, `defi`, `x402`, `trading-bot`, `security`, `base`, `solana`

---

## 6. PulseMCP

- **Status:** **PREPARED**
- **Catalog URL:** [https://pulsemcp.com/](https://pulsemcp.com/)
- **Submission Process:** PR or submission form at [https://github.com/pulsemcp](https://github.com/pulsemcp).
- **Listing Type:** Developer tools & autonomous agent capabilities.

---

## 7. Cursor Directory & Awesome Lists

- **Status:** **PREPARED**
- **Target:** Cursor Directory (`cursor.directory`) / `awesome-mcp-servers`
- **Snippet:**
  ```json
  {
    "mcpServers": {
      "verify402": {
        "command": "npx",
        "args": [
          "-y",
          "--package=https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.2/verify402-mcp-1.0.2.tgz",
          "verify402-mcp"
        ],
        "env": {
          "VERIFY402_URL": "https://verify402.onrender.com"
        }
      }
    }
  }
  ```
