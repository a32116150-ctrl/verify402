// One release identity for the service metadata and the MCP package it ships.
// The published npm package has its own package.json; the release-consistency
// test asserts that this constant, mcp-bridge/package.json, server.json,
// package-lock.json, the manifest, OpenAPI, and the /mcp page agree.
export const RELEASE_VERSION = "1.1.2";

// The version a user can actually install from the public npm registry today.
// 1.1.2 carries a real bridge fix: the installed payer now carries the
// challenge's `extensions.bazaar` declaration into the payment payload, so a
// settlement can be cataloged. The 1.1.1/1.1.0 packages remain on the registry.
// Before the npm artifact for 1.1.2 is verified, this constant matches the
// prepared release so /info and the manifest are consistent with the tree.
export const PUBLISHED_VERSION = "1.1.2";

// Machine-readable statement of where this source tree sits in the release
// process. "published" means the npm artifact exists and was verified with
// `npm view verify402-mcp@1.1.2 version` and RELEASE_STATUS is only flipped then.
export const RELEASE_STATUS = "prepared";
