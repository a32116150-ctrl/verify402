// Known swap routers the free gate can name and, where the layout is known,
// decode.
//
// A router is recognised only by (chainId, address). Decoding is keyed on the
// router, not on the selector alone: a 4-byte selector is not an identity, and
// a look-alike contract must never inherit a trusted router's decoding.
//
// LCX Liberty DEX (dex.lcx.com):
//   * Router 0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0 on Ethereum (1), OP
//     Mainnet (10), Arbitrum (42161) and Base (8453), as stated by LCX
//     (2026-11-25). Other LCX networks use 0x0000000000654902B6Ed6cC240cc81CB4c4a3dff;
//     none of those chains is in the measurement registry yet, so it is not
//     listed. The live value per chain is GET /v1/chains `router` and every
//     quote's `spender`.
//   * The router is an EIP-1967 upgradeable proxy: its logic can change. The
//     gate says so in notChecked instead of assuming a fixed implementation.
//   * Selector 0xfc54261d: the head of the calldata is
//       tokenIn, tokenOut, amountIn, minimumAmountOut, recipient, deadline,
//       <offset to the route bytes>
//     Inferred from POST /v1/swap responses on Base (2026-11-26) and checked
//     against the quote that came with each one (input.amount,
//     output.minimumAmount, taker). Decoding is defensive: any word that does
//     not have the expected shape means "not decoded", never a guess.

const LCX_ROUTER_A = "0x0000000000b1ae06c96ab73ff4360d7aeaab56f0";

export const KNOWN_ROUTERS = Object.freeze({
  lcx: Object.freeze({
    id: "lcx",
    name: "LCX Liberty DEX",
    upgradeable: true,
    deployments: Object.freeze({
      [LCX_ROUTER_A]: Object.freeze([1, 10, 42161, 8453]),
    }),
  }),
});

export const LCX_SWAP_SELECTOR = "0xfc54261d";

/** The known router at `to` on `chainId`, or null. */
export function knownRouter(chainId, to) {
  if (typeof to !== "string") return null;
  const address = to.toLowerCase();
  for (const router of Object.values(KNOWN_ROUTERS)) {
    const chains = router.deployments[address];
    if (chains && chains.includes(Number(chainId))) {
      return { id: router.id, name: router.name, address, upgradeable: router.upgradeable };
    }
  }
  return null;
}

const HEAD_WORDS = 7;

function word(hex, i) {
  return hex.slice(i * 64, i * 64 + 64);
}

function asAddress(w) {
  if (!/^0{24}[0-9a-f]{40}$/.test(w)) return null;
  return `0x${w.slice(24)}`;
}

/**
 * Decode an LCX router call. Returns a swap description for the known
 * selector, or null when the calldata does not match the known layout (the
 * caller then reports it as an LCX call that was not decoded).
 */
export function decodeLcxCall(data) {
  const d = String(data).toLowerCase();
  if (d.slice(0, 10) !== LCX_SWAP_SELECTOR) return null;
  const body = d.slice(10);
  if (body.length < HEAD_WORDS * 64 || body.length % 64 !== 0) return null;
  const tokenIn = asAddress(word(body, 0));
  const tokenOut = asAddress(word(body, 1));
  const recipient = asAddress(word(body, 4));
  if (!tokenIn || !tokenOut || !recipient) return null;
  const amountIn = BigInt(`0x${word(body, 2)}`);
  const amountOutMinimum = BigInt(`0x${word(body, 3)}`);
  const deadline = BigInt(`0x${word(body, 5)}`);
  const routeOffset = BigInt(`0x${word(body, 6)}`);
  // The route bytes must start inside the calldata, after the head.
  if (routeOffset < BigInt(HEAD_WORDS * 32) || routeOffset >= BigInt(body.length / 2)) return null;
  if (deadline > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    action: "swap",
    protocol: "lcx-liberty",
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    recipient,
    deadline: Number(deadline),
    layout: "inferred from LCX /v1/swap responses (2026-11-26); route bytes not decoded",
  };
}

// ----------------------------------------------------------- quote binding --
// An integrator that got the transaction from LCX's POST /v1/swap also holds
// the quote it was built from. Passing that quote lets the gate prove the
// bytes about to be signed are the terms that were quoted: same router as the
// quoted spender, same tokens, same amount in, same minimum out.

function tokenAddress(t) {
  if (typeof t === "string") return t.toLowerCase();
  if (t && typeof t === "object" && typeof t.address === "string") return t.address.toLowerCase();
  return null;
}

function rawAmount(v) {
  if (v == null) return null;
  const s = String(v);
  return /^\d+$/.test(s) ? BigInt(s) : null;
}

export const DEFAULT_MAX_FLOOR_GAP_BPS = 300;

/**
 * Compare a decoded swap and its target against a supplied quote. Returns
 * { mismatches: [field...], problems: [{code, severity, message}] }.
 * `quote` follows LCX's quote object: spender, input {amount, token},
 * output {amount, minimumAmount, token}, expiresAt (unix seconds).
 */
export function bindQuote(quote, { to, decoded, nowMs, maxFloorGapBps = DEFAULT_MAX_FLOOR_GAP_BPS }) {
  const problems = [];
  const mismatches = [];
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    problems.push({ code: "invalid_quote", severity: "block", message: "quote must be an object (the quote returned with the transaction)" });
    return { mismatches, problems, bound: false };
  }

  const spender = typeof quote.spender === "string" ? quote.spender.toLowerCase() : null;
  if (spender && to && spender !== String(to).toLowerCase()) mismatches.push("spender");

  const expiresAt = Number(quote.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Math.floor(nowMs / 1000) > expiresAt) {
    problems.push({ code: "quote_expired", severity: "caution", message: `the quote expired at ${expiresAt}; ask for a fresh one before signing` });
  }

  const quotedOut = rawAmount(quote.output?.amount);
  const quotedMin = rawAmount(quote.output?.minimumAmount);
  if (quotedOut && quotedMin != null && quotedOut > 0n) {
    const gapBps = Number(((quotedOut - quotedMin) * 10_000n) / quotedOut);
    if (gapBps > maxFloorGapBps) {
      problems.push({
        code: "wide_slippage_floor",
        severity: "caution",
        message: `the quoted minimum is ${(gapBps / 100).toFixed(2)}% below the quoted output (limit ${(maxFloorGapBps / 100).toFixed(2)}%)`,
      });
    }
  }

  if (!decoded || decoded.action !== "swap" || decoded.protocol === "unverified" || decoded.amountOutMinimum == null) {
    problems.push({
      code: "quote_not_bound",
      severity: "caution",
      message: "the transaction's calldata could not be decoded, so it was not matched against the quote",
    });
    if (mismatches.length) {
      problems.push({ code: "quote_terms_mismatch", severity: "block", message: `the transaction does not match the quote: ${mismatches.join(", ")}` });
    }
    return { mismatches, problems, bound: false };
  }

  const qIn = tokenAddress(quote.input?.token);
  const qOut = tokenAddress(quote.output?.token);
  const qAmountIn = rawAmount(quote.input?.amount);
  if (qIn && decoded.tokenIn && qIn !== decoded.tokenIn.toLowerCase()) mismatches.push("tokenIn");
  if (qOut && decoded.tokenOut && qOut !== decoded.tokenOut.toLowerCase()) mismatches.push("tokenOut");
  if (qAmountIn != null && decoded.amountIn != null && qAmountIn !== BigInt(decoded.amountIn)) mismatches.push("amountIn");
  if (quotedMin != null && quotedMin !== BigInt(decoded.amountOutMinimum)) mismatches.push("minimumAmount");

  if (mismatches.length) {
    problems.push({
      code: "quote_terms_mismatch",
      severity: "block",
      message: `the transaction does not match the quote it came with: ${mismatches.join(", ")}`,
    });
  }
  return { mismatches, problems, bound: mismatches.length === 0 };
}
