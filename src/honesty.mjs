// Honesty contract for the paid routes.
//
// The free gate has always returned `checked` and `notChecked`. The paid
// routes are held to the same standard: every 200 and every typed failure says
// what was measured and what was not. The lists below are the real limits from
// AUDIT.md section 4.3, not marketing copy.

export const UNCONFIGURED_VENUES = {
  1: "Curve, Balancer, PancakeSwap, and other venues not in config",
  42161: "Camelot, Trader Joe, and other venues not in config",
  8453: "Aerodrome, Uniswap V4, PancakeSwap, and other Base-native venues not in config (Base has no configured V2 router)",
};

export function unconfiguredVenues(chainId) {
  return UNCONFIGURED_VENUES[chainId] ?? "venues not in config";
}

export const PAID_ROUTE_LIMITS = {
  "/verify": {
    checked: [
      "best buy quote at one pinned block",
      "best sell quote at one pinned block",
      "configured gas cost",
      "configured flash-loan premium",
    ],
    notChecked: [
      "execution / whether a transaction would succeed",
      "MEV, sandwiching, and private orderflow",
      "bridge or centralized-exchange liquidity",
      "venues not in config",
      "balance-delta and state-change simulation",
      "slippage beyond what the venues themselves report",
    ],
  },
  "/safety": {
    checked: [
      "token contract facts (name, symbol, decimals, total supply)",
      "external market data and scam signals",
      "quote-based sellability at a USD-sized probe",
      "round-trip cost at the intended size",
    ],
    notChecked: [
      "actual token transfer or sell execution",
      "transfer tax / fee-on-transfer",
      "blacklist / allowlist restrictions",
      "pause / trading-disable switches",
      "max-transaction / max-wallet limits",
      "holder concentration",
      "contract audit",
      "sanctions screening",
      "venues not in config",
    ],
  },
  "/route": {
    checked: [
      "every configured venue for one pair and size at one pinned block",
      "direct and WETH-routed paths",
    ],
    notChecked: [
      "aggregators and unconfigured DEX venues",
      "execution / whether a swap would succeed",
      "slippage protection chosen by the caller",
      "MEV, sandwiching, and private orderflow",
    ],
  },
  "/quotecheck": {
    checked: [
      "offered quote shape and echo guard",
      "configured venue book at one pinned block",
      "comparison of the offer to the chain best",
    ],
    notChecked: [
      "that the offer is executable",
      "that venueClaimed is true",
      "that chainIn is the chain that produced the offer",
      "signature or provenance of the offer",
      "venues not in config",
    ],
  },
  "/depth": {
    checked: [
      "entry quotes at a size ladder",
      "exit quotes for the exact position",
      "round-trip cost, impact, and capacity under the tolerance",
    ],
    notChecked: [
      "real execution or state changes",
      "venues not in config",
      "decimals for tokens outside the configured registry",
      "MEV and private orderflow",
    ],
  },
};

export const PAID_ROUTES = Object.keys(PAID_ROUTE_LIMITS);

export function isPaidRoute(path) {
  return PAID_ROUTES.includes(path);
}

function uniqueNonEmpty(list) {
  const out = [...new Set((list || []).filter((x) => typeof x === "string" && x.trim() !== ""))];
  return out;
}

/**
 * Merge the route's declared limits with anything the engine actually measured.
 * Both arrays are always non-empty, even on a typed failure.
 */
export function paidHonesty(route, { checked = [], notChecked = [] } = {}) {
  const base = PAID_ROUTE_LIMITS[route] || { checked: [], notChecked: [] };
  const checkedFinal = uniqueNonEmpty([...base.checked, ...checked]);
  const notCheckedFinal = uniqueNonEmpty([...base.notChecked, ...notChecked]);
  if (!checkedFinal.length) checkedFinal.push("request validation");
  if (!notCheckedFinal.length) notCheckedFinal.push("not measured");
  return { checked: checkedFinal, notChecked: notCheckedFinal };
}

/**
 * A typed failure still has to say what happened. On a transport/decode
 * failure we only claim request validation, and we name the missing work.
 */
export function honestFailure(route, kind = null) {
  const reason = kind === "transport"
    ? "market measurement did not run: the chain/provider could not be read"
    : kind === "decode"
      ? "market measurement did not run: the provider returned undecodable data"
      : "market measurement did not run";
  // Do NOT merge the route's normal `checked` list: on a failure those checks
  // did not run, and claiming them would be the exact dishonesty this contract
  // exists to prevent. Keep the route's static notChecked limits, plus the
  // reason this particular call produced nothing.
  const base = PAID_ROUTE_LIMITS[route] || { notChecked: [] };
  return {
    checked: ["request validation"],
    notChecked: uniqueNonEmpty([reason, ...base.notChecked]),
  };
}
