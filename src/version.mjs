// One release identity for the service metadata and the MCP package it ships.
// The published npm package has its own package.json; the release-consistency
// test asserts that this constant, mcp-bridge/package.json, server.json,
// package-lock.json, the manifest, OpenAPI, and the /mcp page agree.
export const RELEASE_VERSION = "1.0.6";

// The version a user can actually install from the public npm registry today.
// 1.0.6 is the current release; the immutable 1.0.5 package remains published
// and must never be republished. Public install instructions point at this
// version.
export const PUBLISHED_VERSION = "1.0.6";

// Machine-readable statement of where this source tree sits in the release
// process. "published" means the npm artifact exists and was verified. The MCP
// Registry entry and the Render deployment remain separate approval gates in
// PUBLISH_STEPS_FOR_ME.md.
export const RELEASE_STATUS = "published";
