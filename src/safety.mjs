// Public client for the paid safety engine.
//
// The implementation (contract facts, quote-based sellability, round-trip
// haircut, Dexscreener context and the TRUST / CAUTION / AVOID judgement) lives
// only in the private verify402-engine service. This module is a thin proxy so
// a clone of the public repository cannot run the paid check locally.

import { callPaidEngine } from "./paid-engine.mjs";

export async function preTradeCheck(chainId, opts = {}) {
  return callPaidEngine("safety", chainId, opts);
}

// Solana token safety (mint and freeze authority, Token-2022 extensions). No
// EVM chain: the mint address is the whole input.
export async function solanaTokenSafety(opts = {}) {
  return callPaidEngine("solana-safety", null, opts);
}
