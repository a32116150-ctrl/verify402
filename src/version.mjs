// One release identity for the service metadata and the MCP package it ships.
// The published npm package has its own package.json; the release-consistency
// test asserts that this constant, mcp-bridge/package.json, server.json,
// package-lock.json, the manifest, OpenAPI, and the /mcp page agree.
export const RELEASE_VERSION = "1.1.1";

// The version a user can actually install from the public npm registry today.
// 1.1.1 is a marker release: no bridge runtime change (the only source diff
// from 1.1.0 is one corrected comment), and it exists so the version a caller
// installs matches the version the service reports. The immutable 1.1.0, 1.0.9, 1.0.8, and 1.0.7 packages remain
// published and must never be republished. Public install instructions point at
// this version.
export const PUBLISHED_VERSION = "1.1.1";

// Machine-readable statement of where this source tree sits in the release
// process. "published" means the npm artifact exists and was verified:
// `npm view verify402-mcp@1.1.1 version` answers 1.1.1, published
// 2026-11-16T15:36:48.514Z, shasum f9d0f0c40f8aa9806b067848fa2cb67a4e5b3e1a
// (identical to the inspected dry-run pack), gitHead
// 7c43cbf5406d73d9ae396ed1363170414a2cc74e. The MCP Registry entry and the
// Render deployment remain separate approval gates in PUBLISH_STEPS_FOR_ME.md.
export const RELEASE_STATUS = "published";
