// Policy helpers for the post-deploy checker.
//
// The public demo is testnet only for this repair. Keeping the mode and
// free-only smoke environment rules here makes them directly testable without
// importing the checker (which performs network requests at top level).
//
// Mainnet deployment checks are not implemented by this script yet. A caller
// that sets EXPECTED_MODE=mainnet must fail before any request is made rather
// than silently running testnet assertions against a mainnet service.

import { RELEASE_VERSION } from "../src/version.mjs";

export const SUPPORTED_EXPECTED_MODES = ["testnet"];
export const DEFAULT_EXPECTED_MODE = "testnet";

// Payment credentials that must never reach a post-deploy smoke child. The
// free-only smoke path does not need any of them.
export const PAYMENT_CREDENTIAL_ENV = [
  "EVM_PRIVATE_KEY",
  "SVM_PRIVATE_KEY",
  "PRIVATE_KEY",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "PREFLIGHT_SECRET",
];

export function resolveExpectedVersion(raw) {
  return String(raw || "").trim() || RELEASE_VERSION;
}

export function resolveExpectedMode(raw) {
  return String(raw || "").trim() || DEFAULT_EXPECTED_MODE;
}

export function assertSupportedExpectedMode(mode) {
  if (!SUPPORTED_EXPECTED_MODES.includes(mode)) {
    throw new Error(
      `unsupported EXPECTED_MODE "${mode}": this checker supports testnet only; ` +
        "mainnet deployment checks are not implemented",
    );
  }
}

/**
 * Build the environment for the post-deploy smoke run. The post-deploy
 * checker is free-only by contract: SMOKE_PAID is forced to "0" and payment
 * credentials are removed, even if the parent process set them.
 */
export function buildFreeSmokeEnv(env = process.env) {
  const free = { ...env, SMOKE_PAID: "0" };
  for (const name of PAYMENT_CREDENTIAL_ENV) delete free[name];
  return free;
}
