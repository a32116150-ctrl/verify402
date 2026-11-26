// Advice for a transaction preflight: what signing will do, in plain words,
// and how to fix what was flagged.
//
// Advice never changes the verdict and is not covered by the receipt. Amounts
// are the transaction's own terms (amount sent, minimum received), not a
// price prediction; dollar figures here are given only for known dollar
// stables, at an assumed 1:1 parity. Enrichers loaded as plug-ins may add
// `involved` (who the transaction touches) and `risk` (dollar exposure).

import { formatUnits } from "viem";
import { PRICE_DEFAULTS } from "./contract.mjs";
import { findToken, STABLE } from "./tokens.mjs";
import { enrichers } from "./routers.mjs";

const ENRICHER_TIMEOUT_MS = 2500;
const UNLIMITED = 2n ** 255n;
const NATIVE = { address: null, symbol: "ETH", decimals: 18, native: true };
const DEFAULT_SLIPPAGE_BPS = 50n;

const lc = (a) => (typeof a === "string" ? a.toLowerCase() : null);
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const msgs = (list) => list.map((r) => cap(String(r.message).replace(/\.$/, ""))).join(". ");

function trimAmount(text) {
  if (!text.includes(".")) return text;
  const [whole, frac] = text.split(".");
  // Keep enough digits to be useful without printing 18 decimals.
  const keep = whole === "0" ? Math.max(6, frac.search(/[1-9]/) + 4) : 6;
  const cut = frac.slice(0, keep).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

export function formatAmount(raw, token) {
  if (raw == null) return null;
  if (!token || !Number.isInteger(token.decimals)) return String(raw);
  try {
    return trimAmount(formatUnits(BigInt(raw), token.decimals));
  } catch {
    return String(raw);
  }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// Token symbol and decimals: the built-in registry first, then the chain.
async function tokenInfo(address, { chainId, client, cache }) {
  const key = lc(address);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let info = null;
  const known = findToken({ family: "evm", chainId }, key);
  if (known) info = { address: key, symbol: known.symbol, decimals: known.decimals, stable: known.kind === STABLE };
  else if (client?.readContract) {
    try {
      const abi = [
        { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
        { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      ];
      const [decimals, symbol] = await withTimeout(Promise.all([
        client.readContract({ address: key, abi, functionName: "decimals" }),
        client.readContract({ address: key, abi, functionName: "symbol" }),
      ]), 2000);
      const d = Number(decimals);
      if (Number.isInteger(d) && d >= 0 && d <= 36 && typeof symbol === "string" && symbol.trim()) {
        info = { address: key, symbol: symbol.trim().slice(0, 16), decimals: d, stable: false };
      }
    } catch { /* unknown token: amounts stay raw */ }
  }
  if (!info) info = { address: key, symbol: null, decimals: null, stable: false };
  cache.set(key, info);
  return info;
}

const label = (t) => (t?.symbol ? t.symbol : t?.address ? `${t.address.slice(0, 6)}…${t.address.slice(-4)}` : "the token");
const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a));

function usdOf(raw, token) {
  if (!token?.stable || raw == null || !Number.isInteger(token.decimals)) return null;
  const n = Number(formatUnits(BigInt(raw), token.decimals));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function line(kind, raw, token, extra = {}) {
  const item = { kind, token: token ? { address: token.address, symbol: token.symbol, decimals: token.decimals } : null, raw: raw == null ? null : String(raw), amount: formatAmount(raw, token) };
  const usd = usdOf(raw, token);
  if (usd != null) item.usd = usd;
  return { ...item, ...extra };
}

// ------------------------------------------------------------------ preview --

async function buildPreview({ decoded, to, data, value, from, chainId, client, quote, simulation, cache, now }) {
  const effects = [];
  let sentence = null;
  const router = decoded?.router?.name;

  if (!decoded || decoded.action === "native" || (!decoded.action && value > 0n)) {
    if (value > 0n) {
      effects.push(line("send", value, NATIVE, { to }));
      sentence = `Send ${formatAmount(value, NATIVE)} ETH to ${short(to)}.`;
    }
  } else if (decoded.action === "transfer") {
    const token = await tokenInfo(to, { chainId, client, cache });
    effects.push(line("send", decoded.amount, token, { to: decoded.recipient }));
    sentence = `Send ${formatAmount(decoded.amount, token)} ${label(token)} to ${short(decoded.recipient)}.`;
  } else if (decoded.action === "transferFrom") {
    const token = await tokenInfo(to, { chainId, client, cache });
    effects.push(line("move", decoded.amount, token, { from: decoded.from, to: decoded.to }));
    sentence = `Move ${formatAmount(decoded.amount, token)} ${label(token)} from ${short(decoded.from)} to ${short(decoded.to)}.`;
  } else if (decoded.action === "approve") {
    const token = await tokenInfo(to, { chainId, client, cache });
    const unlimited = BigInt(decoded.amount) >= UNLIMITED;
    effects.push(line("allow", unlimited ? null : decoded.amount, token, { spender: decoded.spender, unlimited }));
    sentence = unlimited
      ? `Allow ${short(decoded.spender)} to spend ALL of your ${label(token)}, with no limit, until you revoke it.`
      : `Allow ${short(decoded.spender)} to spend up to ${formatAmount(decoded.amount, token)} ${label(token)}.`;
  } else if (decoded.action === "permit") {
    sentence = "Sign a permit that grants a token allowance; the spender and amount are inside the signed data.";
  } else if (decoded.action === "swap" && decoded.protocol !== "unverified") {
    const path = Array.isArray(decoded.path) ? decoded.path : null;
    const inAddr = decoded.tokenIn ?? (decoded.protocol === "uniswap-v2-eth-in" ? null : path?.[0]);
    const outAddr = decoded.tokenOut ?? path?.[path.length - 1];
    const tokenIn = inAddr ? await tokenInfo(inAddr, { chainId, client, cache }) : NATIVE;
    const tokenOut = outAddr ? await tokenInfo(outAddr, { chainId, client, cache }) : null;
    const amountIn = decoded.amountIn ?? (decoded.protocol === "uniswap-v2-eth-in" ? value.toString() : null);
    if (amountIn != null) effects.push(line("send", amountIn, tokenIn, { to }));
    effects.push(line("receive_at_least", decoded.amountOutMinimum, tokenOut, { to: decoded.recipient }));
    const quotedOut = quote?.output?.amount;
    if (quotedOut != null && /^\d+$/.test(String(quotedOut))) effects.push(line("receive_expected", quotedOut, tokenOut, { source: "quote" }));
    const toSelf = from && lc(decoded.recipient) === lc(from);
    const via = router ? ` on ${router}` : decoded.protocol ? ` via ${decoded.protocol}` : "";
    sentence = `Swap ${amountIn != null ? `${formatAmount(amountIn, tokenIn)} ` : ""}${label(tokenIn)} for at least ${formatAmount(decoded.amountOutMinimum, tokenOut)} ${label(tokenOut)}${via}, `
      + (toSelf ? "paid to your wallet." : `paid to ${short(decoded.recipient)}${from ? " (not the signer)" : ""}.`);
    if (decoded.deadline) {
      const mins = Math.round((decoded.deadline * 1000 - now) / 60000);
      if (mins >= 0 && mins < 24 * 60) sentence += ` It must execute within about ${mins} minute${mins === 1 ? "" : "s"}.`;
    }
  } else if (decoded.action === "swap") {
    sentence = `A swap through ${short(to)} whose terms could not be read.`;
  } else if (decoded.action === "router_call") {
    sentence = `A call to ${decoded.router?.name ?? "a known router"} (method ${decoded.selector}) whose terms could not be read.`;
  } else if (decoded.action === "multicall") {
    sentence = `A batched call (multicall) to ${short(to)}; the individual steps were not read.`;
  } else {
    sentence = `A contract call to ${short(to)} (method ${decoded.selector ?? "unknown"}) that verify402 does not read.`;
  }

  if (value > 0n && decoded && decoded.action !== "native" && decoded.protocol !== "uniswap-v2-eth-in") {
    effects.push(line("send", value, NATIVE, { to }));
  }

  // Network fee, only when the call was simulated for a real signer.
  let fee = null;
  if (from && simulation?.status === "ok" && typeof client?.estimateGas === "function" && typeof client?.getGasPrice === "function") {
    try {
      const [gas, price] = await withTimeout(Promise.all([
        client.estimateGas({ account: from, to, data: data && data !== "0x" ? data : undefined, value }),
        client.getGasPrice(),
      ]), 2500);
      const wei = BigInt(gas) * BigInt(price);
      fee = { gas: String(gas), wei: wei.toString(), eth: formatAmount(wei, NATIVE) };
    } catch { /* fee stays unknown */ }
  }
  return { effects, sentence, fee };
}

// --------------------------------------------------------------------- fixes --

function suggestedMinimum(quote, tokenOut) {
  const out = quote?.output?.amount;
  if (out == null || !/^\d+$/.test(String(out))) return null;
  const raw = (BigInt(out) * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  return { raw: raw.toString(), amount: formatAmount(raw, tokenOut), basis: "quoted output minus 0.5%" };
}

function buildFixes(reasons, { decoded, from, quote, tokens, to }) {
  const fixes = [];
  const add = (code, action, extra = {}) => fixes.push({ for: code, action, ...extra });
  for (const r of reasons) {
    switch (r.code) {
      case "simulation_skipped_no_from":
        add(r.code, "Pass `from` (the wallet that will sign) so the transaction can be simulated before you sign.");
        break;
      case "simulation_revert": {
        const need = tokens.inAmount ? `${tokens.inAmount} ${label(tokens.in)}` : "the input token";
        add(r.code, `As built, this transaction fails. Check that the wallet holds ${need}${decoded?.action === "swap" && tokens.in && !tokens.in.native ? ` and has approved ${short(to)} to spend it` : ""}, then check again. Do not sign a transaction that reverts: you pay gas for nothing.`);
        break;
      }
      case "insufficient_funds":
        add(r.code, "Add enough native token (ETH) to cover the value plus the network fee, then check again.");
        break;
      case "zero_min_out":
      case "minimal_min_out": {
        const s = suggestedMinimum(quote, tokens.out);
        add(r.code, s
          ? `Set the minimum output to at least ${s.amount} ${label(tokens.out)} (${s.basis}) and rebuild the transaction.`
          : "Set the minimum output to the expected output minus your slippage tolerance (0.5–1% is typical), then rebuild. With no minimum, a price move or a sandwich bot can take most of the output.",
        s ? { suggested: { amountOutMinimum: s.raw } } : {});
        break;
      }
      case "swap_deadline_expired":
        add(r.code, "The deadline has passed. Rebuild the transaction with a deadline a few minutes in the future, from a fresh quote.");
        break;
      case "swap_recipient_mismatch":
        add(r.code, `The output goes to ${short(decoded?.recipient)}, not the signer. If that is not intended, set the recipient to ${short(from)}.`, from ? { suggested: { recipient: from } } : {});
        break;
      case "unlimited_approval":
        add(r.code, "Approve only the amount this trade needs instead of an unlimited allowance; an unlimited approval stays open after the trade.");
        break;
      case "approval_unverified_spender":
      case "spender_not_allowed":
        add(r.code, "Confirm the spender is the protocol's official contract (from its docs), then list it in `policy.allowedSpenders`.");
        break;
      case "quote_expired":
        add(r.code, "Ask for a fresh quote and rebuild the transaction from it; prices move.");
        break;
      case "quote_terms_mismatch": {
        const diffs = [];
        const field = (name, txValue, quoteValue) => diffs.push({ field: name, transaction: txValue ?? null, quote: quoteValue ?? null });
        const m = String(r.message);
        if (/spender/.test(m)) field("to / spender", to, quote?.spender);
        if (/tokenIn/.test(m)) field("tokenIn", decoded?.tokenIn, quote?.input?.token?.address ?? quote?.input?.token);
        if (/tokenOut/.test(m)) field("tokenOut", decoded?.tokenOut, quote?.output?.token?.address ?? quote?.output?.token);
        if (/amountIn/.test(m)) field("amountIn", decoded?.amountIn, quote?.input?.amount);
        if (/minimumAmount/.test(m)) field("minimumAmount", decoded?.amountOutMinimum, quote?.output?.minimumAmount);
        add(r.code, "Do not sign. The transaction was changed after it was quoted. Rebuild it from the quote, or get a new quote.", { differences: diffs });
        break;
      }
      case "wide_slippage_floor":
        add(r.code, "The guaranteed minimum is far below the quoted output. Request the quote with a tighter slippage (for example 0.5%).");
        break;
      case "quote_not_bound":
      case "unrecognized_calldata":
      case "router_call_not_decoded":
        add(r.code, "verify402 could not read this transaction's terms. Use a transaction from a router it reads, or confirm the tokens and amounts in the app that built it.");
        break;
      case "target_not_contract":
        add(r.code, "The `to` address is not a contract, so this call does nothing. Check the address.");
        break;
      case "value_with_token_swap":
        add(r.code, "Set `value` to 0 unless the router's docs say this swap takes native ETH.");
        break;
      case "stale_block":
        add(r.code, "The chain data was old. Check again in a moment.");
        break;
      case "risk_over_limit":
        add(r.code, "More money is at risk than the owner allowed. Ask the owner to approve this transaction, make it smaller, or raise policy.maxRiskUsd.");
        break;
      case "risk_unmeasured":
        add(r.code, "verify402 could not price what is at risk, so the owner's limit could not be applied. Ask the owner before signing.");
        break;
      case "burn_recipient":
        add(r.code, "The recipient is a burn address: the tokens would be destroyed. Check the recipient.");
        break;
      default:
        break;
    }
  }
  return fixes;
}

// ----------------------------------------------------------- paid upgrades --

function buildUpgrades({ decoded, tokens, quote, chainId }) {
  const ups = [];
  if (decoded?.action !== "swap" || decoded.protocol === "unverified") return ups;
  if (tokens.out && !tokens.out.symbolKnown) {
    ups.push({ tool: "check_token_safety", route: "/safety", price: PRICE_DEFAULTS.safety,
      why: `${label(tokens.out)} is not a token verify402 knows. Check that it can be sold back before buying it.`,
      input: { chainId, tokenAddress: tokens.out.address } });
  }
  if (quote) {
    ups.push({ tool: "verify_quote_fairness", route: "/quotecheck", price: PRICE_DEFAULTS.quotecheck,
      why: "Compare this quote against the live on-chain price to see whether it is fair." });
  } else if (tokens.in && tokens.out) {
    ups.push({ tool: "get_best_route", route: "/route", price: PRICE_DEFAULTS.route,
      why: "See the best available output for this trade, and set the minimum from it." });
  }
  return ups.slice(0, 2);
}

// ------------------------------------------------------------------- entry --

/**
 * Phase 1: everything that does not depend on the verdict — the wallet
 * preview and the plug-in enrichers. The gate runs this before deciding, so a
 * caller's risk limit can use the dollar figures.
 */
export async function prepareAdvice({ decoded, chainId, from, to, data, value = 0n, quote, simulation, client, now = Date.now() }) {
  const cache = new Map();
  const { effects, sentence, fee } = await buildPreview({ decoded, to, data, value, from, chainId, client, quote, simulation, cache, now });
  const enrichment = {};
  const ctx = { chainId, from, to, value, decoded, quote, client, effects };
  for (const fn of enrichers()) {
    try {
      const extra = await withTimeout(Promise.resolve(fn(ctx)), ENRICHER_TIMEOUT_MS);
      if (extra?.involved) enrichment.involved = [...(enrichment.involved ?? []), ...extra.involved];
      if (extra?.risk) enrichment.risk = { ...(enrichment.risk ?? {}), ...extra.risk };
    } catch { /* an enricher failure never affects the answer */ }
  }
  return { decoded, chainId, from, to, value, quote, cache, effects, sentence, fee, enrichment };
}

/**
 * The dollars a transaction puts at risk: what leaves the wallet (swap input,
 * transfer, native value) or what a spender could take (approval). Returns
 * { usd, basis } or null when it cannot be measured.
 */
export function valueAtRiskUsd(prepared) {
  const risk = prepared?.enrichment?.risk ?? {};
  const effects = prepared?.effects ?? [];
  const allow = effects.find((e) => e.kind === "allow");
  if (allow) {
    if (Number.isFinite(risk.exposureUsd)) return { usd: risk.exposureUsd, basis: "what the spender could take" };
    if (!allow.unlimited && Number.isFinite(allow.usd)) return { usd: allow.usd, basis: "the approved amount" };
    return null;
  }
  const sends = effects.filter((e) => e.kind === "send" || e.kind === "move");
  if (!sends.length) {
    // A call that moves nothing we can read is not measurable unless it is a
    // plain call with no value and no decoded transfer at all.
    return prepared?.decoded && !["unknown", "router_call", "multicall", "permit"].includes(prepared.decoded.action) && prepared.decoded.protocol !== "unverified"
      ? { usd: 0, basis: "nothing leaves the wallet" }
      : null;
  }
  let total = 0;
  for (const e of sends) {
    let usd = null;
    if (Number.isFinite(e.usd)) usd = e.usd;
    else if (e.token && !e.token.address && Number.isFinite(risk.nativeValueUsd)) usd = risk.nativeValueUsd;
    else if (e.token?.address && Number.isFinite(risk.sendUsd) && sends.length === 1) usd = risk.sendUsd;
    if (usd == null) return null;
    total += usd;
  }
  return { usd: Math.round(total * 100) / 100, basis: "what leaves the wallet" };
}

/** Phase 2: wording that depends on the final verdict and reasons. */
export function finishAdvice(prepared, { verdict, reasons }) {
  const { decoded, chainId, from, to, quote, cache, effects, sentence, fee, enrichment } = prepared;
  const swapIn = effects.find((e) => e.kind === "send" && e.token);
  const swapOut = effects.find((e) => e.kind === "receive_at_least");
  const tokens = {
    in: swapIn?.token ? (swapIn.token.address ? cache.get(swapIn.token.address) ?? swapIn.token : NATIVE) : null,
    out: swapOut?.token ? cache.get(swapOut.token.address) ?? swapOut.token : null,
    inAmount: swapIn?.amount ?? null,
  };
  if (tokens.out) tokens.out = { ...tokens.out, symbolKnown: Boolean(findToken({ family: "evm", chainId }, tokens.out.address)) };

  const verdictLine = verdict === "BLOCK"
    ? "Do not sign."
    : verdict === "CAUTION"
      ? `Check before signing. ${msgs(reasons.filter((r) => r.severity === "caution").slice(0, 2))}.`
      : "No problems found in the checks that ran.";
  const explanation = [sentence, verdict === "BLOCK" ? `${verdictLine} ${msgs(reasons.filter((r) => r.severity === "block").slice(0, 2))}.` : verdictLine]
    .filter(Boolean).join(" ");

  const advice = {
    explanation,
    preview: { effects, ...(fee ? { networkFee: fee } : {}) },
    fixes: buildFixes(reasons, { decoded, from, quote, tokens, to }),
    upgrades: buildUpgrades({ decoded, tokens, quote, chainId }),
    ...(enrichment.involved ? { involved: enrichment.involved } : {}),
    ...(enrichment.risk ? { risk: enrichment.risk } : {}),
  };
  advice.note = "Advice explains the transaction and suggests fixes. Apart from policy.maxRiskUsd, it never changes the verdict and is not covered by the receipt. Amounts are the transaction's own terms, not a price prediction.";
  return advice;
}

/** Both phases, for callers that already have a verdict. */
export async function buildAdvice(args) {
  return finishAdvice(await prepareAdvice(args), args);
}
