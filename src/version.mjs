// One release identity for the service metadata and the MCP package it ships.
// The published npm package has its own package.json; the release-consistency
// test asserts that this constant, mcp-bridge/package.json, server.json,
// package-lock.json, the manifest, OpenAPI, and the /mcp page agree.
export const RELEASE_VERSION = "2.6.1";

// The version a user can actually install from the public npm registry today.
// 2.0.0 is the v2 release (assure bundle, six paid tools); 2.0.1 a consistency
// patch; 2.5.0 the mainnet-only release (the testnet demo retired 2026-11-19);
// 2.6.0 lists all nine tools for every install (paid tools refuse without EVM_PRIVATE_KEY);
// 2.6.1 aligns the bridge's price defaults and public copy with the live service.
export const PUBLISHED_VERSION = "2.6.1";

// Machine-readable statement of where this source tree sits in the release
// process. "published" means the npm artifact exists and was verified:
// `npm view verify402-mcp@1.1.2 version` answers 1.1.2, published
// 2026-11-17T14:13:26.566Z, shasum 802f1d36a1f7686c1adc14a134fc739663434055
// (identical to the inspected dry-run pack), gitHead
// 39c7f56c5d393ffa5e9b210ded8b61e5ba5f27fe. The MCP Registry entry and the
// Render deployment remain separate approval gates in PUBLISH_STEPS_FOR_ME.md.
export const RELEASE_STATUS = "published";
