// Known-router plug-ins for the free gate, and quote binding.
//
// The public tree ships no router definitions. An operator can load private
// definitions with VERIFY402_ROUTER_PLUGINS=/path/a.mjs,/path/b.mjs; each
// module exports `routers`, an array of:
//   {
//     id, name,
//     upgradeable?: boolean,                 // disclosed in notChecked
//     deployments: { [lowercaseAddress]: [chainId, ...] },
//     decode?(data): decodedSwap | null,     // null = not decoded
//   }
// A router is recognised only by (chainId, address). Decoding is keyed on the
// router, not on the selector alone, so a look-alike contract never inherits a
// trusted router's decoding.

const registry = new Map();
let pluginsLoaded = null;

export function registerRouter(def) {
  if (!def || typeof def.id !== "string" || !def.deployments) throw new Error("router plug-in needs id and deployments");
  registry.set(def.id, def);
}

export function clearRouters() {
  registry.clear();
}

/** Load VERIFY402_ROUTER_PLUGINS once. A plug-in that fails to load is skipped and reported. */
export function loadRouterPlugins(spec = process.env.VERIFY402_ROUTER_PLUGINS) {
  if (pluginsLoaded) return pluginsLoaded;
  pluginsLoaded = (async () => {
    const paths = String(spec || "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const p of paths) {
      try {
        const mod = await import(p.startsWith("file:") ? p : `file://${p}`);
        for (const def of mod.routers || []) registerRouter(def);
      } catch (e) {
        console.error(JSON.stringify({ event: "verify402.router_plugin_failed", error: e.message }));
      }
    }
    return registry.size;
  })();
  return pluginsLoaded;
}

/** The known router at `to` on `chainId`, or null. */
export function knownRouter(chainId, to) {
  if (typeof to !== "string") return null;
  const address = to.toLowerCase();
  for (const def of registry.values()) {
    const chains = def.deployments[address];
    if (chains && chains.includes(Number(chainId))) {
      return {
        id: def.id,
        name: def.name,
        address,
        upgradeable: Boolean(def.upgradeable),
        decode: typeof def.decode === "function" ? def.decode : null,
      };
    }
  }
  return null;
}

// ----------------------------------------------------------- quote binding --
// An integrator that got a transaction from a swap API usually also holds the
// quote it was built from. Passing that quote lets the gate prove the bytes
// about to be signed are the terms that were quoted: same contract as the
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
 * { mismatches, problems: [{code, severity, message}], bound }.
 * Quote shape: spender, input {amount, token}, output {amount, minimumAmount,
 * token}, expiresAt (unix seconds). Tokens may be addresses or {address}.
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
