// One shared, anonymous client label for every request the bridge makes.
//
// This is not an identity: it contains no wallet, key, account, or user id, and
// the server treats it as a self-declared hint. Its only job is to let /usage
// separate bridge traffic from generic HTTP probes. The version comes from the
// package manifest so a release bump cannot leave the label stale.

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export const CLIENT_ID = "verify402-mcp";
export const VERSION = pkg.version;
export const CLIENT_HEADERS = Object.freeze({
  "User-Agent": `${CLIENT_ID}/${VERSION}`,
  "X-Verify402-Client": `${CLIENT_ID}/${VERSION}`,
});
