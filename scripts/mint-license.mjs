// Issue a signed license for running verify402's paid engines locally.
//
// The signing key lives outside the repo (mode 600), never in source control:
//   ~/.config/verify402/license-private.pem
// The matching verifier key is embedded in src/license.mjs.
//
// Usage:
//   node scripts/mint-license.mjs --id agent-name --days 365
//   node scripts/mint-license.mjs --id agent-name --out /path/to/license.txt
//
// The token is a credential. Prefer --out and keep the file private.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  return value;
}

const keyPath = arg("key", join(homedir(), ".config", "verify402", "license-private.pem"));
const outPath = arg("out", null);
const id = arg("id", `license-${new Date().toISOString().slice(0, 10)}`);
const days = Number(arg("days", "365"));
if (!Number.isInteger(days) || days < 1 || days > 3650) {
  console.error("--days must be a whole number between 1 and 3650");
  process.exit(1);
}
if (!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) {
  console.error("--id may contain letters, digits, dot, underscore, colon and dash only");
  process.exit(1);
}

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
} catch (error) {
  console.error(`cannot read signing key at ${keyPath}: ${error.message}`);
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const payload = {
  v: 1,
  kind: "verify402-local-license",
  id,
  iat: now,
  exp: now + days * 86_400,
};
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const data = `v1.${body}`;
const signature = sign(null, Buffer.from(data, "utf8"), privateKey).toString("base64url");
const token = `${data}.${signature}`;

if (outPath) {
  writeFileSync(outPath, `${token}\n`, { mode: 0o600 });
  console.error(`license written to ${outPath} (expires ${new Date(payload.exp * 1000).toISOString()})`);
} else {
  console.log(token);
}
