// The pre-signing gate: one call an agent makes before it signs anything.
//
// Two intents, one contract:
//
//   payment     an x402 payment request (scheme, network, asset, amount,
//               payTo, resource, timeout, authorization window).
//   transaction a chain transaction (to, data, value, optional from).
//
// The answer is three-state on purpose. A binary "safe / unsafe" would force
// honest uncertainty into a lie: an approval to an unvetted spender is not a
// pass, and a call we could not simulate is not a block. So:
//
//   PASS     every check in `checked` passed at this block.
//   CAUTION  at least one check needs a decision before signing.
//   BLOCK    at least one hard check failed. Do not sign.
//
// Every answer carries a short-lived receipt bound to the exact intent and,
// when the chain is readable, a pinned block. POST /preflight/verify recomputes
// the HMAC, so an executor can refuse a receipt it cannot verify.
//
// What this module deliberately does NOT do: reputation, sanctions, contract
// audits, balance-delta simulation. Those need data or trace support we do not
// have, and pretending otherwise is the one thing this service cannot afford.
// They are listed in `notChecked` on every response.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decodeErrorResult,
  decodeFunctionData,
  erc20Abi,
  isAddress,
  parseAbi,
} from "viem";
import { CHAINS } from "./config.mjs";
import { clientFor } from "./measure.mjs";
import { canonicalStable, sha256Hex } from "./recovery.mjs";

export const PREFLIGHT_SPEC = "verify402/preflight@1";
export const RECEIPT_SPEC = "verify402/preflight-receipt@1";
export const DEFAULT_TTL_SECONDS = 90;
export const MAX_TTL_SECONDS = 300;
export const MIN_TTL_SECONDS = 15;
// The supported EVM chains produce blocks every ~12s or faster. A block older
// than 30s is worth surfacing; older than 120s is not a usable "latest" block.
export const BLOCK_AGE_CAUTION_SECONDS = 30;
export const BLOCK_AGE_BLOCK_SECONDS = 120;

const MAX_DATA_BYTES = 32 * 1024;
const MAX_UINT256 = 2n ** 256n - 1n;
const UNLIMITED_THRESHOLD = 2n ** 255n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const MS = 1000;

// Testnet payment rails are accepted structurally even though the measurement
// registry only carries mainnet. No block is pinned there; the receipt says so.
const EXTRA_EVM = {
  84532: { name: "base-sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
  11155111: { name: "ethereum-sepolia", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
};

const SVM_MAINNET = {
  name: "solana-mainnet",
  genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
const SVM_DEVNET = {
  name: "solana-devnet",
  genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};
const SVM_BLOCKED_PAYEES = new Set([
  "11111111111111111111111111111111", // system program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL token program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token account program
]);

const NETWORK_ALIASES = {
  base: "eip155:8453",
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
  ethereum: "eip155:1",
  mainnet: "eip155:1",
  arbitrum: "eip155:42161",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

// An ephemeral secret makes receipts verifiable only inside the current
// process. That is acceptable for a 90-second gate, and fatal for a
// multi-instance deployment, so /info says which mode is live.
const RECEIPT_SECRET = process.env.PREFLIGHT_SECRET || randomBytes(32).toString("hex");
export const RECEIPT_SECRET_SOURCE = process.env.PREFLIGHT_SECRET ? "env" : "ephemeral";

export class PreflightError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PreflightError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- helpers ---

const block = (code, message) => ({ code, severity: "block", message });
const caution = (code, message) => ({ code, severity: "caution", message });
const unique = (arr) => [...new Set(arr)];

function verdictOf(reasons) {
  if (reasons.some((r) => r.severity === "block")) return "BLOCK";
  if (reasons.some((r) => r.severity === "caution")) return "CAUTION";
  return "PASS";
}

function summaryOf(verdict, reasons) {
  const blocks = reasons.filter((r) => r.severity === "block").length;
  const cautions = reasons.filter((r) => r.severity === "caution").length;
  if (verdict === "BLOCK") {
    return `BLOCK: ${blocks} hard check${blocks === 1 ? "" : "s"} failed. Do not sign.`;
  }
  if (verdict === "CAUTION") {
    return `CAUTION: ${cautions} check${cautions === 1 ? "" : "s"} need attention. Read the reasons before signing.`;
  }
  return "PASS: every check in `checked` passed at this block. See `notChecked` for what was not covered.";
}

function errorMessage(e) {
  if (e == null) return "unknown error";
  return e.shortMessage || e.details || e.cause?.shortMessage || e.cause?.details
    || e.cause?.reason || e.message || String(e);
}

function isRevert(e) {
  const names = [e?.name, e?.cause?.name, e?.cause?.cause?.name].filter(Boolean);
  if (names.includes("CallExecutionError")) return true;
  const msg = errorMessage(e);
  if (/rate limit|too many requests|timeout|timed out|fetch failed|network error|429|502|503|504/i.test(msg)) return false;
  return /execution reverted|revert/i.test(msg);
}

const ERROR_ABI = parseAbi(["error Error(string)"]);
const PANIC_ABI = parseAbi(["error Panic(uint256)"]);

function revertReason(e) {
  const data = e?.data || e?.cause?.data || e?.cause?.cause?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    for (const abi of [ERROR_ABI, PANIC_ABI]) {
      try {
        const decoded = decodeErrorResult({ abi, data });
        if (decoded.errorName === "Error") return String(decoded.args[0]);
        if (decoded.errorName === "Panic") return `Panic(0x${BigInt(decoded.args[0]).toString(16)})`;
      } catch {
        // Try the next shape; fall through to the provider message.
      }
    }
  }
  return errorMessage(e);
}

function parseRawAmount(value) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_UINT256) throw new Error("amount is outside uint256");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("amount must be a positive integer");
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = BigInt(value.trim());
    if (n > MAX_UINT256) throw new Error("amount is outside uint256");
    return n;
  }
  throw new Error("amount must be a positive integer in raw units (a decimal string)");
}

function parseWei(value) {
  if (value == null || value === "") return 0n;
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error("value must be non-negative");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("value must be a non-negative integer");
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error("value must be a non-negative integer string in wei");
}

function normalizeHex(value) {
  if (value == null || value === "") return "0x";
  if (typeof value !== "string") throw new Error("data must be a hex string");
  const s = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(s) || s.length % 2 !== 0) throw new Error("data must be even-length hex");
  if ((s.length - 2) / 2 > MAX_DATA_BYTES) throw new Error(`data exceeds ${MAX_DATA_BYTES} bytes`);
  return s;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function isSvmAddress(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const ch of value) {
    const i = BASE58.indexOf(ch);
    if (i < 0) return false;
    n = n * 58n + BigInt(i);
  }
  let zeros = 0;
  for (const ch of value) {
    if (ch === "1") zeros++;
    else break;
  }
  let bytes = 0;
  for (let x = n; x > 0n; x >>= 8n) bytes++;
  return zeros + bytes === 32;
}

// EIP-55 is a typo detector, not a chain rule. All-lowercase is valid; mixed
// case must carry a correct checksum, because a mistyped address is exactly
// the failure this gate exists to catch.
function normalizeEvmAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const hasLower = /[a-f]/.test(body);
  const hasUpper = /[A-F]/.test(body);
  if (hasLower && hasUpper && !isAddress(value)) return null;
  return value.toLowerCase();
}

function parseNetwork(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = NETWORK_ALIASES[s.toLowerCase()] || s;

  if (s.startsWith("eip155:")) {
    const chainId = Number(s.slice(7));
    if (!Number.isInteger(chainId) || chainId <= 0) {
      return { family: "evm", chainId, supported: false, name: null, usdc: null, decimals: null, measurement: false };
    }
    const c = CHAINS[chainId];
    const x = EXTRA_EVM[chainId];
    if (!c && !x) {
      return { family: "evm", chainId, supported: false, name: null, usdc: null, decimals: null, measurement: false };
    }
    return {
      family: "evm",
      chainId,
      supported: true,
      name: c?.name ?? x.name,
      usdc: c?.tokens?.USDC?.address ?? x.usdc,
      decimals: 6,
      measurement: Boolean(c),
    };
  }

  if (s.startsWith("solana:")) {
    const genesis = s.slice(7);
    const known = genesis === SVM_MAINNET.genesis ? SVM_MAINNET
      : genesis === SVM_DEVNET.genesis ? SVM_DEVNET : null;
    return {
      family: "svm",
      chainId: null,
      genesis,
      supported: Boolean(known),
      name: known?.name ?? null,
      usdc: known?.usdc ?? null,
      decimals: 6,
      measurement: false,
    };
  }

  return { family: "unknown", chainId: null, supported: false, name: null, usdc: null, decimals: null, measurement: false };
}

function networkKey(raw) {
  const net = parseNetwork(raw);
  if (!net) return "";
  if (net.family === "evm") return `eip155:${net.chainId}`;
  if (net.family === "svm") return `solana:${net.genesis}`;
  return String(raw ?? "").toLowerCase();
}

function canonicalUsdc(net) {
  if (!net || !net.supported) return null;
  if (net.family === "evm") {
    return CHAINS[net.chainId]?.tokens?.USDC?.address ?? EXTRA_EVM[net.chainId]?.usdc ?? null;
  }
  if (net.family === "svm") return net.usdc;
  return null;
}

function canonicalUsdcDecimals(net) {
  if (!net || !net.supported) return null;
  if (net.family === "evm") {
    return CHAINS[net.chainId]?.tokens?.USDC?.decimals ?? EXTRA_EVM[net.chainId]?.decimals ?? null;
  }
  if (net.family === "svm") return 6;
  return null;
}

function sameAsset(net, a, b) {
  if (a == null || b == null) return false;
  if (net?.family === "svm") return String(a) === String(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function matchesList(list, value, net) {
  if (!Array.isArray(list)) return true;
  if (value == null) return false;
  if (net?.family === "svm") return list.includes(value);
  return list.some((x) => String(x).toLowerCase() === String(value).toLowerCase());
}

function normalizePolicy(p) {
  if (p == null) return {};
  if (typeof p !== "object" || Array.isArray(p)) {
    throw new PreflightError(400, "invalid_policy", "policy must be an object");
  }
  const out = {};

  if (p.maxAmountUsd != null) {
    const n = Number(p.maxAmountUsd);
    if (!Number.isFinite(n) || n < 0) throw new PreflightError(400, "invalid_policy", "policy.maxAmountUsd must be a non-negative number");
    out.maxAmountUsd = n;
  }
  if (p.maxValueWei != null) {
    let n;
    try {
      n = BigInt(String(p.maxValueWei));
    } catch {
      throw new PreflightError(400, "invalid_policy", "policy.maxValueWei must be a non-negative integer string");
    }
    if (n < 0n) throw new PreflightError(400, "invalid_policy", "policy.maxValueWei must be non-negative");
    // Keep the normalized policy JSON-safe: a BigInt in the response would
    // break res.json() and turn an honest BLOCK into a 503.
    out.maxValueWei = n.toString();
  }
  if (p.maxValueEth != null) {
    const n = Number(p.maxValueEth);
    if (!Number.isFinite(n) || n < 0) throw new PreflightError(400, "invalid_policy", "policy.maxValueEth must be a non-negative number");
    out.maxValueWei = BigInt(Math.round(n * 1e18)).toString();
  }
  if (p.maxTimeoutSeconds != null) {
    const n = Number(p.maxTimeoutSeconds);
    if (!Number.isFinite(n) || n <= 0) throw new PreflightError(400, "invalid_policy", "policy.maxTimeoutSeconds must be a positive number");
    out.maxTimeoutSeconds = n;
  }
  for (const key of ["allowedNetworks", "allowedPayTo", "allowedTo", "allowedSpenders", "allowedAssets", "allowedFacilitators"]) {
    if (p[key] != null) {
      if (!Array.isArray(p[key])) throw new PreflightError(400, "invalid_policy", `policy.${key} must be an array`);
      out[key] = p[key].map((x) => String(x));
    }
  }
  if (p.expectedResource != null) {
    const s = String(p.expectedResource);
    try {
      new URL(s);
    } catch {
      throw new PreflightError(400, "invalid_policy", "policy.expectedResource must be a URL");
    }
    out.expectedResource = s;
  }
  if (p.forbidUnlimitedApproval != null) out.forbidUnlimitedApproval = Boolean(p.forbidUnlimitedApproval);
  return out;
}

function ttlOf(body) {
  const n = Number(body?.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(n)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(n)));
}

function normalizeKind(body) {
  const k = String(body?.kind ?? "").trim().toLowerCase();
  if (k) return k;
  if (body?.payment && typeof body.payment === "object") return "payment";
  if (body?.transaction && typeof body.transaction === "object") return "transaction";
  if (body?.to != null || body?.data != null || body?.value != null) return "transaction";
  if (body?.payTo != null || body?.asset != null || body?.amount != null) return "payment";
  return "";
}

function getClient(chainId, clientFactory) {
  if (typeof clientFactory === "function") {
    const client = clientFactory(chainId);
    if (!client) throw new PreflightError(503, "chain_unavailable", `no client available for chainId ${chainId}`);
    return client;
  }
  try {
    return clientFor(chainId);
  } catch (e) {
    throw new PreflightError(503, "chain_unavailable", `no client available for chainId ${chainId}: ${errorMessage(e)}`);
  }
}

async function getBlockSafe(client, chainId) {
  try {
    const b = await client.getBlock({ blockTag: "latest" });
    if (!b || b.number == null || b.timestamp == null) {
      throw new Error("the RPC returned a block without a number or timestamp");
    }
    return b;
  } catch (e) {
    if (e instanceof PreflightError) throw e;
    throw new PreflightError(503, "chain_unavailable", `could not read chainId ${chainId} at a pinned block: ${errorMessage(e)}`);
  }
}

// ------------------------------------------------------------- calldata -----

const ABI_TRANSFER = parseAbi(["function transfer(address to, uint256 amount)"]);
const ABI_APPROVE = parseAbi(["function approve(address spender, uint256 amount)"]);
const ABI_TRANSFER_FROM = parseAbi(["function transferFrom(address from, address to, uint256 amount)"]);
const ABI_V2_EXACT = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);
const ABI_V2_ETH_IN = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
]);
const ABI_V3_EXACT_IN = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

const V2_EXACT_SELECTORS = new Set(["0x38ed1739", "0x18cbafe5", "0x5c11d795", "0x791ac947"]);
const V2_ETH_IN_SELECTORS = new Set(["0x7ff36ab5", "0xb6f9de95"]);
const MULTICALL_SELECTORS = new Set(["0xac9650d8", "0x5ae401dc"]);
const UNVERIFIED_SWAP_SELECTORS = new Set([
  "0x8803dbee", "0x4a25d94a", "0xfb3bdb41", // V2 exact-out
  "0xc04b8d59", "0xdb3e2198", "0xf28c0498", // V3 multi-hop / exact-out
  "0x3593564c", // Universal Router execute
]);

export function decodeCalldata(data) {
  const d = String(data).toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(d) || d.length < 10) throw new Error("calldata must begin with a 4-byte selector");
  const selector = d.slice(0, 10);

  if (selector === "0xa9059cbb") {
    const { args } = decodeFunctionData({ abi: ABI_TRANSFER, data: d });
    return { action: "transfer", recipient: args[0], amount: args[1].toString() };
  }
  if (selector === "0x095ea7b3") {
    const { args } = decodeFunctionData({ abi: ABI_APPROVE, data: d });
    return { action: "approve", spender: args[0], amount: args[1].toString() };
  }
  if (selector === "0x23b872dd") {
    const { args } = decodeFunctionData({ abi: ABI_TRANSFER_FROM, data: d });
    return { action: "transferFrom", from: args[0], to: args[1], amount: args[2].toString() };
  }
  if (selector === "0xd505accf") return { action: "permit", protocol: "eip-2612" };

  if (V2_EXACT_SELECTORS.has(selector)) {
    const { args } = decodeFunctionData({ abi: ABI_V2_EXACT, data: d });
    return {
      action: "swap",
      protocol: "uniswap-v2",
      amountIn: args[0].toString(),
      amountOutMinimum: args[1].toString(),
      path: args[2].map((a) => a.toLowerCase()),
      recipient: args[3],
      deadline: Number(args[4]),
    };
  }
  if (V2_ETH_IN_SELECTORS.has(selector)) {
    const { args } = decodeFunctionData({ abi: ABI_V2_ETH_IN, data: d });
    return {
      action: "swap",
      protocol: "uniswap-v2-eth-in",
      amountIn: null,
      amountOutMinimum: args[0].toString(),
      path: args[1].map((a) => a.toLowerCase()),
      recipient: args[2],
      deadline: Number(args[3]),
    };
  }
  if (selector === "0x414bf389") {
    const { args } = decodeFunctionData({ abi: ABI_V3_EXACT_IN, data: d });
    const p = args[0];
    return {
      action: "swap",
      protocol: "uniswap-v3",
      tokenIn: p.tokenIn.toLowerCase(),
      tokenOut: p.tokenOut.toLowerCase(),
      fee: Number(p.fee),
      recipient: p.recipient,
      deadline: Number(p.deadline),
      amountIn: p.amountIn.toString(),
      amountOutMinimum: p.amountOutMinimum.toString(),
    };
  }
  if (UNVERIFIED_SWAP_SELECTORS.has(selector)) return { action: "swap", protocol: "unverified", selector };
  if (MULTICALL_SELECTORS.has(selector)) return { action: "multicall", selector };
  return { action: "unknown", selector };
}

function checkDecoded(decoded, { from, policy, now, value }) {
  const reasons = [];
  const notChecked = [];
  const fromLc = from?.toLowerCase() ?? null;
  const addr = (a) => (typeof a === "string" ? a.toLowerCase() : null);

  if (decoded.action === "transfer") {
    if (decoded.amount === "0") reasons.push(caution("zero_amount", "transfer amount is zero"));
    if ([ZERO_ADDRESS, DEAD_ADDRESS].includes(addr(decoded.recipient))) {
      reasons.push(caution("burn_recipient", "transfer recipient is the zero or dead address"));
    }
    notChecked.push("recipient reputation");
  } else if (decoded.action === "approve") {
    const unlimited = BigInt(decoded.amount) >= UNLIMITED_THRESHOLD;
    if (unlimited) {
      if (policy.forbidUnlimitedApproval) {
        reasons.push(block("unlimited_approval", "approve grants an unlimited allowance and policy.forbidUnlimitedApproval is set"));
      } else {
        reasons.push(caution("unlimited_approval", "approve grants an unlimited allowance; the spender can move the full balance"));
      }
    }
    if (policy.allowedSpenders) {
      if (!matchesList(policy.allowedSpenders, decoded.spender, { family: "evm" })) {
        reasons.push(block("spender_not_allowed", "spender is outside policy.allowedSpenders"));
      }
    } else {
      reasons.push(caution("approval_unverified_spender", "the spender has not been vetted by an allowlist; confirm the contract and the allowance"));
    }
    notChecked.push("spender reputation");
  } else if (decoded.action === "transferFrom") {
    if (fromLc && addr(decoded.from) !== fromLc) {
      reasons.push(caution("transfer_from_third_party", "the transaction moves tokens owned by a different address"));
    }
    if (!fromLc) {
      reasons.push(caution("transfer_from_unverified_owner", "no from address was supplied, so ownership and allowance were not checked"));
    }
    notChecked.push("allowance", "owner authorization");
  } else if (decoded.action === "permit") {
    reasons.push(caution("permit_risk", "an on-chain permit grants an allowance; verify the spender and value in the signed data"));
    notChecked.push("permit signature intent");
  } else if (decoded.action === "swap") {
    if (decoded.deadline != null && decoded.deadline > 0 && Math.floor(now / MS) > decoded.deadline) {
      reasons.push(block("swap_deadline_expired", `the swap deadline ${decoded.deadline} has passed`));
    }
    if (decoded.amountOutMinimum === "0") {
      reasons.push(caution("zero_min_out", "amountOutMinimum is zero: the swap accepts any output and is exposed to sandwiching"));
    } else if (decoded.amountOutMinimum != null && BigInt(decoded.amountOutMinimum) <= 1n) {
      reasons.push(caution("minimal_min_out", "amountOutMinimum is 1 raw unit or less: the swap has effectively no slippage protection"));
    }
    if (fromLc && decoded.recipient && addr(decoded.recipient) !== fromLc) {
      reasons.push(caution("swap_recipient_mismatch", "the swap output goes to a different address than the payer"));
    }
    if (decoded.amountIn === "0") reasons.push(caution("zero_amount_in", "the swap amountIn is zero"));
    if (decoded.protocol === "unverified") {
      reasons.push(caution("swap_route_unverified", "the swap was recognized only by selector; the route and minimum output were not decoded"));
    }
    if (decoded.protocol === "uniswap-v2-eth-in" && value === 0n) {
      reasons.push(block("missing_value", "this ETH-in swap has value 0 and cannot execute"));
    }
    if (decoded.protocol !== "uniswap-v2-eth-in" && value > 0n) {
      reasons.push(caution("value_with_token_swap", "a token swap carries native value; confirm the router expects it"));
    }
    notChecked.push("slippage beyond amountOutMinimum", "route quality", "mev/sandwich protection");
  } else if (decoded.action === "multicall") {
    reasons.push(caution("multicall_unverified", "multicall batches calls; the individual actions were not decoded"));
    notChecked.push("inner calls");
  } else {
    reasons.push(caution("unrecognized_calldata", `selector ${decoded.selector} is not a known transfer, approval, permit or swap; only the simulation result is available`));
    notChecked.push("calldata semantics");
  }

  return { reasons, notChecked };
}

// ---------------------------------------------------------------- receipt ---

function makeReceipt({ kind, verdict, intentHash, block: chainBlock, ttlSeconds, checked, notChecked, now }) {
  const payload = {
    spec: RECEIPT_SPEC,
    id: `pf_${randomBytes(8).toString("hex")}`,
    kind,
    verdict,
    intentHash,
    blockNumber: chainBlock ? Number(chainBlock.number) : null,
    blockHash: chainBlock?.hash ?? null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * MS).toISOString(),
    ttlSeconds,
    checked,
    notChecked,
    algorithm: "hmac-sha256",
  };
  const signature = createHmac("sha256", RECEIPT_SECRET).update(canonicalStable(payload)).digest("hex");
  return { ...payload, signature };
}

export function verifyReceipt(receipt, { now = Date.now() } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, reason: "missing_receipt" };
  }
  const { signature, ...payload } = receipt;
  if (payload.spec !== RECEIPT_SPEC) return { valid: false, reason: "unknown_spec" };
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) {
    return { valid: false, reason: "missing_signature" };
  }
  const expected = createHmac("sha256", RECEIPT_SECRET).update(canonicalStable(payload)).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad_signature" };

  const expires = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expires)) return { valid: false, reason: "bad_expiry" };
  if (expires <= now) return { valid: false, reason: "expired", expiredAt: payload.expiresAt };

  return {
    valid: true,
    reason: null,
    verdict: payload.verdict,
    kind: payload.kind,
    intentHash: payload.intentHash,
    blockNumber: payload.blockNumber,
    blockHash: payload.blockHash,
    expiresAt: payload.expiresAt,
  };
}

const NOTE = "A PASS is not a guarantee, a counterparty audit, or a prompt-injection filter. It means the checks listed in `checked` passed at this block; `notChecked` lists what was not examined, including tool metadata and response content. Receipts expire and are bound to the exact intent.";

function finish({ kind, reasons, checked, notChecked, intent, block: chainBlock, simulation, decoded, payerBalance, ttlSeconds, now }) {
  const reasonsFinal = [...reasons];
  let blockAgeSeconds = null;
  if (chainBlock?.timestamp != null) {
    blockAgeSeconds = Math.max(0, Math.floor(now / 1000) - Number(chainBlock.timestamp));
    checked.push("block_freshness");
    if (blockAgeSeconds > BLOCK_AGE_BLOCK_SECONDS) {
      reasonsFinal.push(block("stale_block", `the latest readable block is ${blockAgeSeconds}s old, above the ${BLOCK_AGE_BLOCK_SECONDS}s hard limit`));
    } else if (blockAgeSeconds > BLOCK_AGE_CAUTION_SECONDS) {
      reasonsFinal.push(caution("stale_block", `the latest readable block is ${blockAgeSeconds}s old; state may have moved`));
    }
  }
  const verdict = verdictOf(reasonsFinal);
  const checkedFinal = unique(checked);
  const notCheckedFinal = unique(notChecked);
  const intentHash = sha256Hex(canonicalStable(intent));
  const receipt = makeReceipt({
    kind,
    verdict,
    intentHash,
    block: chainBlock,
    ttlSeconds,
    checked: checkedFinal,
    notChecked: notCheckedFinal,
    now,
  });
  return {
    ok: true,
    spec: PREFLIGHT_SPEC,
    kind,
    verdict,
    sign_allowed: verdict !== "BLOCK",
    requires_ack: verdict === "CAUTION",
    summary: summaryOf(verdict, reasonsFinal),
    reasons: reasonsFinal,
    checked: checkedFinal,
    notChecked: notCheckedFinal,
    intent,
    intentHash,
    block: chainBlock ? {
      number: Number(chainBlock.number),
      hash: chainBlock.hash,
      ...(chainBlock.timestamp != null
        ? { timestamp: Number(chainBlock.timestamp), ageSeconds: blockAgeSeconds }
        : {}),
    } : null,
    simulation: simulation ?? undefined,
    decoded: decoded ?? undefined,
    payerBalance: payerBalance ?? undefined,
    receipt,
    note: NOTE,
  };
}

// ---------------------------------------------------------------- payment ---

async function paymentPreflight(body, { clientFactory, now }) {
  const raw = body.payment && typeof body.payment === "object" && !Array.isArray(body.payment)
    ? body.payment
    : body;
  const policy = normalizePolicy(body.policy);
  const reasons = [];
  const checked = [];
  const notChecked = [
    "recipient reputation",
    "sanctions screening",
    "payment signature / signed payload",
    "facilitator settlement",
    "off-chain promises",
    "counterparty identity / tool metadata",
    "prompt injection / hidden Unicode in tool output",
  ];

  const net = parseNetwork(raw.network);
  const chainHint = body.chainId ?? raw.chainId ?? null;

  const scheme = raw.scheme == null ? null : String(raw.scheme).trim().toLowerCase();
  if (!scheme) {
    reasons.push(caution("missing_scheme", "the payment request does not name a scheme; x402 exact is expected"));
  } else if (scheme !== "exact") {
    reasons.push(caution("non_exact_scheme", `scheme "${scheme}" is not the x402 exact scheme; this preflight only understands exact`));
  } else {
    checked.push("scheme");
  }

  if (!raw.network) {
    reasons.push(block("missing_network", "the payment request does not name a network"));
  } else if (!net || !net.supported) {
    reasons.push(block("unsupported_network", `network "${raw.network}" is not a known x402 EVM or Solana network`));
  } else {
    checked.push("network");
    if (chainHint != null) {
      if (net.family === "evm" && Number(chainHint) !== net.chainId) {
        reasons.push(block("chain_mismatch", `chainId ${chainHint} does not match network ${raw.network}`));
      }
      if (net.family === "svm" && Number.isFinite(Number(chainHint))) {
        reasons.push(block("chain_mismatch", `chainId ${chainHint} does not match a Solana network`));
      }
    }
    if (policy.allowedNetworks && !policy.allowedNetworks.some((n) => networkKey(n) === networkKey(raw.network))) {
      reasons.push(block("network_not_allowed", `network "${raw.network}" is outside policy.allowedNetworks`));
    }
  }

  let asset = raw.asset == null ? null : String(raw.asset).trim();
  if (asset && net?.supported && /^usdc$/i.test(asset)) asset = canonicalUsdc(net);
  const assetNorm = net?.family === "evm" && asset ? normalizeEvmAddress(asset) : asset;
  const assetValid = net?.family === "evm"
    ? Boolean(assetNorm)
    : net?.family === "svm"
      ? (asset ? isSvmAddress(asset) : false)
      : Boolean(asset);

  if (!asset) {
    reasons.push(block("missing_asset", "the payment request does not name an asset"));
  } else if (net?.supported && net.family === "evm" && !assetNorm) {
    reasons.push(block("invalid_asset", "asset is not a valid EVM address"));
  } else if (net?.supported && net.family === "svm" && !isSvmAddress(asset)) {
    reasons.push(block("invalid_asset", "asset is not a valid Solana mint address"));
  } else {
    const canon = canonicalUsdc(net);
    if (policy.allowedAssets && !policy.allowedAssets.some((a) => sameAsset(net, a, asset))) {
      reasons.push(block("asset_not_allowed", `asset "${asset}" is outside policy.allowedAssets`));
    } else if (canon && !sameAsset(net, asset, canon)) {
      reasons.push(caution("non_canonical_asset", `asset "${asset}" is not canonical USDC on ${net.name}; confirm the token is what the seller accepts`));
    } else if (canon) {
      checked.push("asset");
    } else {
      notChecked.push("asset canonicality");
    }
  }

  let amount = null;
  try {
    amount = parseRawAmount(raw.amount);
    if (amount <= 0n) throw new Error("amount must be greater than zero");
    checked.push("amount");
  } catch (e) {
    reasons.push(block("invalid_amount", `amount must be a positive integer in raw units: ${e.message}`));
  }

  if (amount != null && policy.maxAmountUsd != null && assetValid && net?.supported) {
    const canon = canonicalUsdc(net);
    if (canon && sameAsset(net, asset, canon)) {
      const decimals = canonicalUsdcDecimals(net);
      const usd = Number(amount) / 10 ** decimals;
      if (usd > policy.maxAmountUsd) {
        reasons.push(block("amount_over_policy", `amount is $${usd.toFixed(6)}, above policy.maxAmountUsd $${policy.maxAmountUsd}`));
      }
    } else {
      reasons.push(block("amount_unit_unknown", "policy.maxAmountUsd is set but the asset's decimals are unknown, so the cap cannot be enforced"));
    }
  } else if (amount != null && policy.maxAmountUsd != null) {
    notChecked.push("amount cap");
  }

  let payTo = null;
  if (raw.payTo == null || raw.payTo === "") {
    reasons.push(block("missing_payee", "the payment request does not name payTo"));
  } else if (net?.supported && net.family === "evm") {
    payTo = normalizeEvmAddress(String(raw.payTo));
    if (!payTo) {
      reasons.push(block("invalid_payee", "payTo is not a valid EVM address (or has a bad checksum)"));
    } else {
      checked.push("payee");
      if (payTo === ZERO_ADDRESS || payTo === DEAD_ADDRESS) {
        reasons.push(block("burn_address", "payTo is the zero or dead address"));
      }
      if (policy.allowedPayTo && !matchesList(policy.allowedPayTo, payTo, net)) {
        reasons.push(block("payee_not_allowed", "payTo is outside policy.allowedPayTo"));
      }
    }
  } else if (net?.supported && net.family === "svm") {
    payTo = String(raw.payTo).trim();
    if (!isSvmAddress(payTo)) {
      reasons.push(block("invalid_payee", "payTo is not a valid Solana address"));
    } else {
      checked.push("payee");
      if (SVM_BLOCKED_PAYEES.has(payTo)) {
        reasons.push(block("burn_address", "payTo is a Solana system/token program, not a wallet"));
      }
      if (policy.allowedPayTo && !matchesList(policy.allowedPayTo, payTo, net)) {
        reasons.push(block("payee_not_allowed", "payTo is outside policy.allowedPayTo"));
      }
    }
  } else {
    payTo = raw.payTo == null ? null : String(raw.payTo);
    notChecked.push("payee format");
  }

  const resource = raw.resource == null ? null : String(raw.resource);
  if (!resource) {
    notChecked.push("resource identity");
    reasons.push(caution("resource_missing", "the payment request carries no resource URL, so the agent cannot verify what it is paying for"));
  } else {
    try {
      const url = new URL(resource);
      if (!["http:", "https:"].includes(url.protocol)) {
        reasons.push(block("invalid_resource", "resource must be an http(s) URL"));
      } else {
        checked.push("resource");
        if (url.protocol === "http:") {
          reasons.push(caution("non_https_resource", "resource is plain http; the payment request could have been altered in transit"));
        }
        if (policy.expectedResource) {
          const expected = new URL(policy.expectedResource);
          if (url.href.replace(/\/$/, "") !== expected.href.replace(/\/$/, "")) {
            reasons.push(block("resource_mismatch", "resource does not match policy.expectedResource"));
          }
        }
      }
    } catch {
      reasons.push(block("invalid_resource", "resource is not a parseable URL"));
    }
  }

  if (raw.maxTimeoutSeconds != null) {
    const timeout = Number(raw.maxTimeoutSeconds);
    if (!Number.isInteger(timeout) || timeout <= 0) {
      reasons.push(block("invalid_timeout", "maxTimeoutSeconds must be a positive integer"));
    } else {
      checked.push("timeout");
      if (timeout > 900) reasons.push(caution("long_timeout", `maxTimeoutSeconds ${timeout} is longer than 15 minutes`));
      if (policy.maxTimeoutSeconds != null && timeout > policy.maxTimeoutSeconds) {
        reasons.push(caution("timeout_over_policy", `maxTimeoutSeconds ${timeout} is above policy.maxTimeoutSeconds ${policy.maxTimeoutSeconds}`));
      }
    }
  }

  const extra = raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra) ? raw.extra : {};
  const validBefore = extra.validBefore ?? raw.validBefore;
  const validAfter = extra.validAfter ?? raw.validAfter;
  if (validBefore != null) {
    const t = Number(validBefore);
    if (!Number.isFinite(t)) {
      reasons.push(block("invalid_authorization", "validBefore must be a unix timestamp in seconds"));
    } else if (t * MS <= now) {
      reasons.push(block("authorization_expired", "the payment authorization has already expired"));
    } else {
      checked.push("authorization_window");
    }
  }
  if (validAfter != null) {
    const t = Number(validAfter);
    if (Number.isFinite(t) && t * MS > now) {
      reasons.push(caution("authorization_not_yet_valid", "the payment authorization is not valid yet"));
    }
  }

  const facilitator = raw.facilitator ?? extra.facilitator;
  if (facilitator != null) {
    try {
      const url = new URL(String(facilitator));
      if (url.protocol !== "https:") {
        reasons.push(caution("non_https_facilitator", "facilitator URL is not https"));
      }
      checked.push("facilitator");
      if (policy.allowedFacilitators && !policy.allowedFacilitators.includes(String(facilitator))) {
        reasons.push(caution("facilitator_not_allowed", "facilitator is outside policy.allowedFacilitators"));
      }
    } catch {
      reasons.push(caution("invalid_facilitator", "facilitator is not a parseable URL"));
    }
  }

  let from = null;
  const fromRaw = body.from ?? raw.from ?? null;
  if (fromRaw != null) {
    if (net?.family === "svm") {
      from = String(fromRaw).trim();
      if (!isSvmAddress(from)) reasons.push(block("invalid_payer", "from is not a valid Solana address"));
    } else {
      from = normalizeEvmAddress(String(fromRaw));
      if (!from) reasons.push(block("invalid_payer", "from is not a valid EVM address (or has a bad checksum)"));
    }
  }

  let blockData = null;
  let payerBalance = null;
  const canon = canonicalUsdc(net);
  const canReadBalance = net?.family === "evm" && net.measurement && from && canon && sameAsset(net, asset, canon);
  if (net?.family === "evm" && net.measurement) {
    const client = getClient(net.chainId, clientFactory);
    const blockPromise = getBlockSafe(client, net.chainId);
    const balancePromise = canReadBalance
      ? client.readContract({ address: canon, abi: erc20Abi, functionName: "balanceOf", args: [from] })
        .then((bal) => ({ bal }))
        .catch((error) => ({ error }))
      : Promise.resolve(null);
    const [b, balanceResult] = await Promise.all([blockPromise, balancePromise]);
    blockData = b;
    if (balanceResult?.bal != null) {
      const decimals = canonicalUsdcDecimals(net);
      payerBalance = { raw: balanceResult.bal.toString(), usd: Number(balanceResult.bal) / 10 ** decimals };
      checked.push("payer_balance");
      if (amount != null && balanceResult.bal < amount) {
        reasons.push(block("insufficient_balance", `payer holds ${payerBalance.usd} USDC, less than the requested ${Number(amount) / 10 ** decimals}`));
      }
    } else if (balanceResult?.error) {
      reasons.push(caution("balance_unavailable", `could not read the payer's USDC balance: ${errorMessage(balanceResult.error)}`));
      notChecked.push("payer_balance");
    } else {
      notChecked.push("payer_balance");
    }
  } else if (net?.family === "evm") {
    notChecked.push("evm block binding (testnet chain)");
    notChecked.push("payer_balance");
  } else if (net?.family === "svm") {
    notChecked.push("solana slot binding");
    notChecked.push("payer_balance");
  } else {
    notChecked.push("network state");
    notChecked.push("payer_balance");
  }

  const numberOrNull = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const intent = {
    kind: "payment",
    payment: {
      scheme,
      network: raw.network == null ? null : String(raw.network),
      asset: assetNorm ?? asset ?? null,
      amount: amount != null ? amount.toString() : (raw.amount == null ? null : String(raw.amount)),
      payTo: payTo ?? (raw.payTo == null ? null : String(raw.payTo)),
      resource,
      maxTimeoutSeconds: numberOrNull(raw.maxTimeoutSeconds),
      extra: {
        validAfter: numberOrNull(validAfter),
        validBefore: numberOrNull(validBefore),
        facilitator: facilitator == null ? null : String(facilitator),
      },
    },
    from: from ?? (fromRaw == null ? null : String(fromRaw)),
    policy,
  };

  return finish({
    kind: "payment",
    reasons,
    checked,
    notChecked,
    intent,
    block: blockData,
    payerBalance,
    ttlSeconds: ttlOf(body),
    now,
  });
}

// ------------------------------------------------------------ transaction ---

async function transactionPreflight(body, { clientFactory, now }) {
  const raw = body.transaction && typeof body.transaction === "object" && !Array.isArray(body.transaction)
    ? body.transaction
    : body;
  const policy = normalizePolicy(body.policy);
  const reasons = [];
  const checked = [];
  const notChecked = [
    "recipient reputation",
    "sanctions screening",
    "state-change/balance-delta simulation",
    "gas price/limit chosen by the signer",
    "raw signed transaction binding",
    "contract audit",
    "off-chain promises",
    "counterparty identity / tool metadata",
    "prompt injection / hidden Unicode in tool output",
  ];

  const chainId = Number(raw.chainId ?? body.chainId ?? 1);
  const c = CHAINS[chainId];
  if (!c) {
    reasons.push(block("unsupported_chain", `chainId ${chainId} is not in the measurement registry`));
  } else {
    checked.push("chain");
  }

  let from = null;
  const fromRaw = body.from ?? raw.from ?? null;
  if (fromRaw != null) {
    from = normalizeEvmAddress(String(fromRaw));
    if (!from) reasons.push(block("invalid_payer", "from is not a valid EVM address (or has a bad checksum)"));
  }

  let to = null;
  const toRaw = raw.to ?? body.to ?? null;
  if (toRaw == null || toRaw === "") {
    reasons.push(block("missing_to", "to is required"));
  } else {
    to = normalizeEvmAddress(String(toRaw));
    if (!to) {
      reasons.push(block("invalid_to", "to is not a valid EVM address (or has a bad checksum)"));
    } else {
      checked.push("recipient");
      if (to === ZERO_ADDRESS || to === DEAD_ADDRESS) reasons.push(block("burn_address", "to is the zero or dead address"));
      if (policy.allowedTo && !matchesList(policy.allowedTo, to, { family: "evm" })) {
        reasons.push(block("to_not_allowed", "to is outside policy.allowedTo"));
      }
    }
  }

  let data = "0x";
  try {
    data = normalizeHex(raw.data ?? body.data);
  } catch (e) {
    reasons.push(block("malformed_calldata", e.message));
  }

  let value = 0n;
  try {
    value = parseWei(raw.value ?? body.value);
  } catch (e) {
    reasons.push(block("invalid_value", e.message));
  }
  checked.push("value");
  if (policy.maxValueWei != null && value > BigInt(policy.maxValueWei)) {
    reasons.push(block("value_over_policy", `value ${value} wei is above policy.maxValueWei ${policy.maxValueWei}`));
  }

  let decoded = null;
  if (data !== "0x") {
    try {
      decoded = decodeCalldata(data);
      checked.push("calldata");
    } catch (e) {
      reasons.push(block("malformed_calldata", `calldata could not be decoded: ${e.message}`));
    }
  } else {
    checked.push("calldata");
    if (value === 0n) reasons.push(caution("noop_transaction", "the transaction has no calldata and no value; it would do nothing"));
  }

  if (decoded) {
    const extra = checkDecoded(decoded, { from, policy, now, value });
    reasons.push(...extra.reasons);
    notChecked.push(...extra.notChecked);
  }

  let chainBlock = null;
  let client = null;
  let simulation = null;

  if (c) {
    client = getClient(chainId, clientFactory);
    const codePromise = (to && data !== "0x")
      ? client.getCode({ address: to }).then((code) => ({ code })).catch((error) => ({ error }))
      : Promise.resolve(null);
    const [b, codeResult] = await Promise.all([getBlockSafe(client, chainId), codePromise]);
    chainBlock = b;

    if (codeResult) {
      if (codeResult.error) {
        reasons.push(caution("contract_code_unavailable", `could not read code at ${to}: ${errorMessage(codeResult.error)}`));
        notChecked.push("contract_code");
      } else if (!codeResult.code || codeResult.code === "0x") {
        reasons.push(block("target_not_contract", `to ${to} has no bytecode; calldata sent to an EOA does nothing`));
      } else {
        checked.push("contract_code");
      }
    }

    if (decoded && ["transfer", "approve", "transferFrom"].includes(decoded.action) && to) {
      try {
        const [decimals, symbol] = await Promise.all([
          client.readContract({ address: to, abi: erc20Abi, functionName: "decimals" }),
          client.readContract({ address: to, abi: erc20Abi, functionName: "symbol" }),
        ]);
        decoded.token = { address: to, symbol: String(symbol), decimals: Number(decimals) };
        checked.push("token_metadata");
        if (!Number.isFinite(decoded.token.decimals) || decoded.token.decimals > 36) {
          reasons.push(caution("implausible_token_metadata", "token decimals are outside a plausible range"));
        }
      } catch (e) {
        reasons.push(caution("token_metadata_unavailable", `the target did not answer standard ERC-20 metadata calls: ${errorMessage(e)}`));
        notChecked.push("token_metadata");
      }
    }

    if (from) {
      try {
        await client.call({ account: from, to, data: data === "0x" ? undefined : data, value });
        simulation = { status: "ok" };
        checked.push("simulation");
      } catch (e) {
        const msg = errorMessage(e);
        if (isRevert(e)) {
          simulation = { status: "revert", reason: revertReason(e) };
          reasons.push(block("simulation_revert", `the call reverted at this block: ${simulation.reason}`));
        } else if (/insufficient funds/i.test(msg)) {
          simulation = { status: "error", reason: msg };
          reasons.push(block("insufficient_funds", `the payer cannot cover value + gas: ${msg}`));
        } else {
          simulation = { status: "unavailable", reason: msg };
          reasons.push(caution("simulation_unavailable", `the call could not be simulated: ${msg}`));
          notChecked.push("simulation");
        }
      }
    } else {
      simulation = { status: "skipped", reason: "no from address supplied" };
      reasons.push(caution("simulation_skipped_no_from", "no from address was supplied, so the call was not simulated; pass the payer address to enable simulation"));
      notChecked.push("simulation");
    }
  } else {
    notChecked.push("simulation");
    notChecked.push("block binding");
  }

  const intent = {
    kind: "transaction",
    chainId,
    from: from ?? (fromRaw == null ? null : String(fromRaw)),
    to: to ?? (toRaw == null ? null : String(toRaw)),
    data,
    value: value.toString(),
    policy,
  };

  return finish({
    kind: "transaction",
    reasons,
    checked,
    notChecked,
    intent,
    block: chainBlock,
    simulation,
    decoded,
    ttlSeconds: ttlOf(body),
    now,
  });
}

// ---------------------------------------------------------------- entry -----

export async function preflight(input, opts = {}) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const kind = normalizeKind(body);
  const now = opts.now ?? Date.now();

  if (kind === "payment") return paymentPreflight(body, { ...opts, now });
  if (kind === "transaction") return transactionPreflight(body, { ...opts, now });
  throw new PreflightError(400, "invalid_kind", "kind must be 'payment' or 'transaction' (or supply payment / transaction / to)");
}
