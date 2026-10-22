// One release identity for the service metadata and the MCP package it ships.
// The published npm package has its own package.json; the release-consistency
// test asserts that this constant, mcp-bridge/package.json, server.json,
// package-lock.json, the manifest, OpenAPI, and the /mcp page agree.
export const RELEASE_VERSION = "1.0.5";

// The version a user can actually install from the public npm registry today.
// 1.0.4 is immutable and must never be republished. Everything in this tree
// describes 1.0.5 as a CANDIDATE until a human creates, verifies, and publishes
// the artifact; public install instructions must therefore point at this
// version, not at RELEASE_VERSION.
export const PUBLISHED_VERSION = "1.0.4";

// Machine-readable statement of where this source tree sits in the release
// process. "candidate-unpublished" means: not on npm, not in the MCP registry,
// and not deployed, until a human completes the runbook in
// PUBLISH_STEPS_FOR_ME.md.
export const RELEASE_STATUS = "candidate-unpublished";
