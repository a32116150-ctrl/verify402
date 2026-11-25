// Solana settlement truth for payment recovery.
//
// On Base, the USDC contract answers "was this authorization used?" in one
// view call (EIP-3009 authorizationState). Solana has no such call, and the
// transaction id is the facilitator's fee-payer signature, which the payer
// never sees. Two facts are still provable from the chain:
//
//   1. Did it land? The payer's own signature is inside the signed
//      transaction. Ed25519 signatures are deterministic, so the payer's
//      signature identifies this exact message. We list the payer's recent
//      transactions and look for one that carries that signature.
//   2. Can it never land? The transaction is pinned to a recent blockhash,
//      which expires after ~150 slots. Once the blockhash is no longer valid at
//      FINALIZED commitment, every transaction that could have landed with it is
//      itself finalized, so a finalized search that does not find it is a
//      definitive "not settled".
//
// The checker answers true (settled), "expired" (definitively not settled), or
// false (still unknown), and throws whenever it cannot be sure. Recovery treats
// a throw as fail-closed: the record stays pending and the key stays blocked.
//
// No dependencies: the wire format is decoded by hand and RPC is plain fetch.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes) {
  const input = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function compactU16(buf, offset) {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    if (offset + i >= buf.length) throw new Error("truncated compact-u16");
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, offset + i + 1];
  }
  throw new Error("invalid compact-u16");
}

function take(buf, offset, n) {
  if (offset + n > buf.length) throw new Error("truncated transaction");
  return [buf.subarray(offset, offset + n), offset + n];
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Version-1 wire format (message first, signatures last):
//   0x81 | header[3] | configMask u32 | lifetimeToken[32] | numInstructions u8
//   | numStaticAccounts u8 | staticAccounts[32 each] | config values
//   | instruction headers (u8 program, u8 numAccounts, u16 dataLen) | payloads
//   | signatures[64 each, count = header[0]]
// Config values, in order, when the mask bit is set: priority fee u64 (bits
// 0-1 both set), compute-unit limit u32 (bit 2), loaded-accounts limit u32
// (bit 3), heap size u32 (bit 4).
function decodeV1(buf) {
  if (buf.length < 1 + 3 + 4 + 32 + 2) throw new Error("truncated v1 transaction");
  const numRequiredSignatures = buf[1];
  const configMask = buf.readUInt32LE(4);
  const lifetime = buf.subarray(8, 40);
  const numInstructions = buf[40];
  const numStatic = buf[41];
  let o = 42;
  const accountKeys = [];
  for (let i = 0; i < numStatic; i++) {
    let key;
    [key, o] = take(buf, o, 32);
    accountKeys.push(base58(key));
  }
  const feeBits = configMask & 3;
  if (feeBits === 1 || feeBits === 2) throw new Error("invalid v1 priority-fee mask");
  o += (feeBits === 3 ? 8 : 0)
    + (configMask & 4 ? 4 : 0)
    + (configMask & 8 ? 4 : 0)
    + (configMask & 16 ? 4 : 0);
  const headers = [];
  for (let i = 0; i < numInstructions; i++) {
    let h;
    [h, o] = take(buf, o, 4);
    headers.push({ program: h[0], accounts: h[1], dataLen: h.readUInt16LE(2) });
  }
  let durableNonce = false;
  for (let i = 0; i < headers.length; i++) {
    let data;
    [, o] = take(buf, o, headers[i].accounts);
    [data, o] = take(buf, o, headers[i].dataLen);
    if (i === 0) {
      durableNonce = accountKeys[headers[0].program] === SYSTEM_PROGRAM
        && headers[0].accounts === 3 && data.length >= 4 && data.readUInt32LE(0) === 4;
    }
  }
  const signatures = [];
  for (let i = 0; i < numRequiredSignatures; i++) {
    let sig;
    [sig, o] = take(buf, o, 64);
    signatures.push(sig);
  }
  if (o !== buf.length) throw new Error("unexpected trailing bytes in v1 transaction");
  if (numStatic < numRequiredSignatures) throw new Error("fewer static accounts than signers");
  return {
    signatures,
    message: buf.subarray(0, buf.length - 64 * numRequiredSignatures),
    signers: accountKeys.slice(0, numRequiredSignatures),
    recentBlockhash: base58(lifetime),
    durableNonce,
  };
}

/** Decode a base64 Solana wire transaction (legacy, v0, or v1). */
export function decodeSolanaTransaction(txBase64) {
  const buf = Buffer.from(String(txBase64), "base64");
  if (buf.length === 0) throw new Error("empty transaction");
  // Legacy/v0 start with the signature count (high bit clear); v1 starts with
  // its version byte 0x81 because the message comes first.
  if (buf[0] & 0x80) {
    if ((buf[0] & 0x7f) !== 1) throw new Error("unsupported transaction version");
    return decodeV1(buf);
  }
  let o = 0;
  let count;
  [count, o] = compactU16(buf, o);
  if (count < 1 || count > 16) throw new Error("unexpected signature count");
  const signatures = [];
  for (let i = 0; i < count; i++) {
    let sig;
    [sig, o] = take(buf, o, 64);
    signatures.push(sig);
  }
  const message = buf.subarray(o);
  let m = 0;
  if (message[m] & 0x80) m += 1; // versioned message prefix
  let header;
  [header, m] = take(message, m, 3);
  const numRequiredSignatures = header[0];
  let keyCount;
  [keyCount, m] = compactU16(message, m);
  const accountKeys = [];
  for (let i = 0; i < keyCount; i++) {
    let key;
    [key, m] = take(message, m, 32);
    accountKeys.push(base58(key));
  }
  let blockhash;
  [blockhash, m] = take(message, m, 32);
  let ixCount;
  [ixCount, m] = compactU16(message, m);
  let durableNonce = false;
  if (ixCount > 0) {
    let programIndex;
    [programIndex, m] = take(message, m, 1);
    let accCount;
    [accCount, m] = compactU16(message, m);
    [, m] = take(message, m, accCount);
    let dataLen;
    [dataLen, m] = compactU16(message, m);
    let data;
    [data, m] = take(message, m, dataLen);
    // AdvanceNonceAccount (system instruction 4) first => durable nonce: the
    // blockhash field is a nonce value and never expires on a timer.
    durableNonce = accountKeys[programIndex[0]] === SYSTEM_PROGRAM
      && data.length >= 4 && data.readUInt32LE(0) === 4;
  }
  if (numRequiredSignatures !== count || keyCount < count) {
    throw new Error("signature count does not match the message header");
  }
  return {
    signatures,
    message,
    signers: accountKeys.slice(0, count),
    recentBlockhash: base58(blockhash),
    durableNonce,
  };
}

/**
 * The payer's part of a partially signed x402 exact transaction: the first
 * signer slot that carries a real (non-zero) signature. The fee-payer slot is
 * still empty when the client sends it; the facilitator signs at settlement.
 */
export function solanaPaymentRef(txBase64) {
  const tx = decodeSolanaTransaction(txBase64);
  const index = tx.signatures.findIndex((sig) => sig.some((b) => b !== 0));
  if (index < 0) throw new Error("transaction carries no payer signature");
  return {
    payerSigner: tx.signers[index],
    payerSignature: base58(tx.signatures[index]),
    recentBlockhash: tx.recentBlockhash,
    durableNonce: tx.durableNonce,
  };
}

const DEFAULT_RPC = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "https://api.mainnet-beta.solana.com",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "https://api.devnet.solana.com",
};

export function solanaRpcUrl(network) {
  return process.env.SOLANA_RPC_URL || DEFAULT_RPC[network] || null;
}

// A blockhash lives ~150 slots (~60-90 s). Never call a payment expired until
// well past that, so a slow-to-finalize transaction cannot be missed.
export const SOLANA_EXPIRY_GRACE_MS = 3 * 60 * 1000;
export const SUPPORTED_TX_VERSION = 1;
const MAX_CANDIDATES = 50;
const SEARCH_LIMIT = 200;

async function rpcCall(rpcUrl, fetchImpl, method, params) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`solana rpc ${method} returned ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(`solana rpc ${method} error ${body.error.code ?? ""}`.trim());
  return body?.result;
}

/**
 * Re-check one staged Solana payment. Returns true (settled), "expired"
 * (definitively not settled), or false (unknown, still inside the window).
 * Throws when the chain cannot answer with certainty.
 */
export async function checkSolanaPayment(ref, {
  rpcUrl,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  if (!rpcUrl) throw new Error("no Solana RPC configured for this network");
  if (!ref?.payerSigner || !ref?.payerSignature || !ref?.recentBlockhash) {
    throw new Error("Solana payment reference is incomplete");
  }

  // Expiry first, then search: if the blockhash is dead at finalized
  // commitment, any landing is already finalized and the search is complete.
  const oldEnough = Number.isFinite(ref.observedAt) && now - ref.observedAt >= SOLANA_EXPIRY_GRACE_MS;
  let expired = false;
  if (!ref.durableNonce && oldEnough) {
    const valid = await rpcCall(rpcUrl, fetchImpl, "isBlockhashValid", [
      ref.recentBlockhash,
      { commitment: "finalized" },
    ]);
    expired = valid?.value === false;
  }

  const list = await rpcCall(rpcUrl, fetchImpl, "getSignaturesForAddress", [
    ref.payerSigner,
    { limit: SEARCH_LIMIT, commitment: "finalized" },
  ]);
  if (!Array.isArray(list)) throw new Error("unexpected getSignaturesForAddress result");
  const windowStart = Number.isFinite(ref.observedAt) ? Math.floor(ref.observedAt / 1000) - 300 : null;
  const candidates = list.filter((s) => windowStart === null || s.blockTime == null || s.blockTime >= windowStart);
  const exhaustive = list.length < SEARCH_LIMIT
    || (windowStart !== null && list.at(-1)?.blockTime != null && list.at(-1).blockTime < windowStart);
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error("too many recent transactions for this payer to search safely");
  }

  for (const c of candidates) {
    const tx = await rpcCall(rpcUrl, fetchImpl, "getTransaction", [
      c.signature,
      // Version 1 must be allowed: the live challenge advertises
      // transactionVersions [0, 1], and the RPC refuses a v1 transaction to a
      // client that only declares support up to v0.
      { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: SUPPORTED_TX_VERSION },
    ]);
    const sigs = tx?.transaction?.signatures;
    if (!Array.isArray(sigs) || !sigs.includes(ref.payerSignature)) continue;
    // Found this exact payment. A failed transaction moved no funds and its
    // signature can never be processed again.
    return tx.meta?.err == null ? true : "expired";
  }

  if (expired && exhaustive) return "expired";
  if (expired) throw new Error("payer history too long to prove the payment never landed");
  return false;
}
