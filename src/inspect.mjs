// x402 payment inspector.
//
// A free, no-wallet way to ask the pre-signing gate about a real 402: paste an
// endpoint URL and the service fetches the challenge once, then runs the same
// payment preflight an agent would run before signing. Nothing here signs,
// funds, or settles; the URL fetch is read-only and never forwards credentials.
//
// The fetch is the only new attack surface, so it is pinned: http(s) only, DNS
// resolved first, every resolved address must be public, no redirects, no
// userinfo, 6s timeout, 64 KB cap. The connection uses the validated address
// (custom lookup), so a second DNS answer cannot rebind it to localhost.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";

import { preflight, parseNetwork } from "./preflight.mjs";
import { findToken, STABLE } from "./tokens.mjs";

export class InspectError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "InspectError";
    this.status = status;
    this.code = code;
  }
}

const block = (code, message) => ({ code, severity: "block", message });
const caution = (code, message) => ({ code, severity: "caution", message });

function verdictOf(reasons) {
  if (reasons.some((r) => r.severity === "block")) return "BLOCK";
  if (reasons.some((r) => r.severity === "caution")) return "CAUTION";
  return "PASS";
}

export function isPublicIp(ip) {
  if (typeof ip !== "string") return false;
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return false;

  if (value.includes(":")) {
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (value === "::" || value === "::1") return false;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff")) return false;
    return true;
  }

  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

const defaultResolve = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export async function resolvePublicUrl(raw, { resolveHost = defaultResolve } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new InspectError(400, "invalid_url", "the endpoint must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new InspectError(400, "invalid_url", "the endpoint must be an absolute http(s) URL");
  }
  if (url.username || url.password) {
    throw new InspectError(400, "invalid_url", "credentials in the URL are not accepted");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new InspectError(400, "blocked_host", "the inspector does not fetch loopback or private hosts");
  }

  let rows;
  try {
    rows = await resolveHost(host);
  } catch {
    throw new InspectError(400, "unresolvable_host", `could not resolve ${host}`);
  }
  if (!Array.isArray(rows) || !rows.length) {
    throw new InspectError(400, "unresolvable_host", `could not resolve ${host}`);
  }
  if (rows.some((row) => !isPublicIp(row.address))) {
    throw new InspectError(400, "blocked_host", "the endpoint resolves to a private or reserved address");
  }
  return { url, address: rows[0].address, family: rows[0].family };
}

export function safeFetchText(raw, {
  timeoutMs = 6000,
  maxBytes = 64 * 1024,
  resolveHost = defaultResolve,
  method = "GET",
  body = null,
} = {}) {
  return resolvePublicUrl(raw, { resolveHost }).then(({ url, address, family }) => new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const verb = String(method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const payload = verb === "POST" ? Buffer.from(body == null ? "{}" : String(body), "utf8") : null;
    const headers = { accept: "application/json", "user-agent": "verify402-inspector/1.0" };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: verb,
      headers,
      lookup: (_hostname, options, callback) => {
        // Node may ask for every address (happy-eyeballs); answer with the one
        // address that passed validation either way.
        if (options && options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      servername: url.protocol === "https:" ? url.hostname : undefined,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(new InspectError(422, "redirect_refused", `the endpoint answered ${res.statusCode}; redirects are not followed`));
        return;
      }
      let total = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          reject(new InspectError(422, "response_too_large", `the endpoint sent more than ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        url: url.href,
      }));
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new InspectError(504, "fetch_timeout", "the endpoint did not answer in time"));
    });
    req.on("error", (e) => reject(e instanceof InspectError ? e : new InspectError(502, "fetch_failed", `could not fetch the endpoint: ${e.message}`)));
    req.end(payload || undefined);
  }));
}

// A body is only a challenge if it has an accepts array, either at the top
// level or under the v1 wrappers. Returns null instead of throwing so the
// caller can decide whether a missing body challenge is an error (header
// absent) or just prose next to a valid header (normal for HTML 402s).
function bodyChallenge(body) {
  if (!body) return null;
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { invalid: true };
  }
  if (Array.isArray(json?.accepts)) return json;
  if (Array.isArray(json?.paymentRequired?.accepts)) return json.paymentRequired;
  if (Array.isArray(json?.challenge?.accepts)) return json.challenge;
  return null;
}

// Chain spellings used by x402 v1 sellers, normalized to CAIP-2. An unknown
// spelling passes through unchanged — it still matches itself, but it cannot
// be conjured equal to a different spelling.
const CHAIN_ALIASES = new Map(Object.entries({
  "ethereum": "eip155:1",
  "sepolia": "eip155:11155111",
  "ethereum-sepolia": "eip155:11155111",
  "goerli": "eip155:5",
  "base": "eip155:8453",
  "base-sepolia": "eip155:84532",
  "arbitrum": "eip155:42161",
  "arbitrum-sepolia": "eip155:421614",
  "polygon": "eip155:137",
  "matic": "eip155:137",
  "polygon-amoy": "eip155:80002",
  "bsc": "eip155:56",
  "binance": "eip155:56",
  "bnb": "eip155:56",
  "avalanche": "eip155:43114",
  "optimism": "eip155:10",
  "optimism-sepolia": "eip155:11155420",
  "solana": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "solana-testnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
}));

function normalizeChain(name) {
  const k = String(name ?? "").toLowerCase().trim().replace(/[_\s]+/g, "-");
  return CHAIN_ALIASES.get(k) ?? k;
}

const low = (v) => (v == null ? null : String(v).toLowerCase());

// One accept entry normalized to the six fields that decide who pays what —
// scheme, chain, asset, raw amount, recipient, timeout. v1 dialect aliases
// are unfolded so x402 dialect differences don't shadow payment equivalence.
function canonicalAccept(a) {
  const t = a ?? {};
  const amount = t.amount ?? t.maxAmountRequired ?? t.maxPrice ?? t.maxAmount ?? null;
  const timeout = t.maxTimeoutSeconds ?? t.timeout ?? null;
  return JSON.stringify({
    scheme: t.scheme == null ? null : String(t.scheme).toLowerCase(),
    network: normalizeChain(t.network),
    asset: low(t.asset),
    amount: amount == null ? null : String(amount),
    payTo: low(t.payTo ?? t.to ?? t.recipient),
    timeout: timeout == null ? null : String(timeout),
  });
}

// Two challenges carry the same demand when their accepts (the term sheet a
// compliant client signs) normalize equal. The wrapper — the declared
// `resource`, the body's prose, its error keys — is not part of the contract
// and does not participate. `x402Version` is not part of the contract either:
// a v1 body and a v2 header advertising the same terms say the same thing.
function canonicalChallenge(challenge) {
  return JSON.stringify({
    accepts: (challenge?.accepts ?? []).map(canonicalAccept).sort(),
  });
}

export function extractChallenge({ header, body } = {}) {
  let fromHeader = null;
  if (header) {
    try {
      fromHeader = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
    } catch {
      throw new InspectError(422, "invalid_challenge", "the PAYMENT-REQUIRED header is not base64 JSON");
    }
  }
  const fromBody = bodyChallenge(body);
  if (fromBody?.invalid) {
    if (!fromHeader) throw new InspectError(422, "invalid_challenge", "the response body is not JSON");
  } else if (fromHeader && fromBody) {
    // Both are well-formed challenges but they disagree. A compliant x402
    // client pays the header; a human or a model usually reads the body. That
    // split is exactly what a swapped-payee attack needs, so refuse instead of
    // silently preferring one.
    if (canonicalChallenge(fromHeader) !== canonicalChallenge(fromBody)) {
      throw new InspectError(
        422,
        "challenge_mismatch",
        "the PAYMENT-REQUIRED header and the response body carry different payment challenges; a compliant client pays the header while a reader sees the body",
      );
    }
    return fromHeader;
  }
  if (fromHeader) return fromHeader;
  if (fromBody) return fromBody;
  if (!header && !body) {
    throw new InspectError(422, "no_challenge", "the response carried neither a PAYMENT-REQUIRED header nor a challenge body");
  }
  throw new InspectError(422, "no_challenge", "the response is not an x402 payment challenge (no accepts)");
}

// x402 v2 may name the resource as a string (v1 style) or as an object with a
// `url` field. Both mean the same thing to the gate.
export function resourceUrlOf(challenge) {
  const resource = challenge?.resource;
  if (typeof resource === "string") return resource;
  if (resource && typeof resource.url === "string") return resource.url;
  return null;
}

export function acceptToPayment(accept, resource = null) {
  return {
    scheme: accept?.scheme,
    network: accept?.network,
    asset: accept?.asset,
    amount: accept?.amount == null ? null : String(accept.amount),
    payTo: accept?.payTo,
    resource: resource || accept?.resource || null,
    maxTimeoutSeconds: accept?.maxTimeoutSeconds,
    extra: accept?.extra,
  };
}

export function summarizeAccept(accept, resource = null) {
  const payment = acceptToPayment(accept, resource);
  const net = parseNetwork(payment.network);
  const token = findToken(net, payment.asset);
  let priceUsd = null;
  let priceBasis = null;
  if (token && token.kind === STABLE) {
    const raw = Number(payment.amount);
    if (Number.isFinite(raw)) {
      priceUsd = raw / 10 ** token.decimals;
      // USDC is the canonical asset; every other stable is priced on an
      // assumed $1 parity, which the UI must say out loud.
      priceBasis = token.symbol === "USDC" ? "canonical" : "assumed $1 parity";
    }
  }
  return {
    scheme: payment.scheme ?? null,
    network: payment.network ?? null,
    asset: payment.asset ?? null,
    token: token?.symbol ?? null,
    amount: payment.amount,
    priceUsd,
    priceBasis,
    payTo: payment.payTo ?? null,
    resource: payment.resource,
    maxTimeoutSeconds: payment.maxTimeoutSeconds ?? null,
  };
}

export async function inspectPaymentChallenge({ challenge, targetUrl = null, now = Date.now() } = {}) {
  const accepts = Array.isArray(challenge?.accepts)
    ? challenge.accepts.filter((accept) => accept && typeof accept === "object")
    : [];
  if (!accepts.length) {
    throw new InspectError(422, "no_accepts", "the 402 challenge carries no payment options");
  }

  const resource = resourceUrlOf(challenge);
  const policy = targetUrl && resource ? { expectedResource: resource } : null;
  const options = [];
  for (const accept of accepts.slice(0, 4)) {
    const body = { payment: acceptToPayment(accept, resource) };
    if (policy) body.policy = policy;
    const result = await preflight(body, { now });
    options.push({
      accept: summarizeAccept(accept, resource),
      verdict: result.verdict,
      summary: result.summary,
      reasons: result.reasons,
      checked: result.checked,
      notChecked: result.notChecked,
      structural_only: result.structural_only,
      receipt: result.receipt,
    });
  }

  const inspectReasons = [];
  if (!resource) {
    inspectReasons.push(caution("challenge_resource_missing", "the challenge carries no resource URL, so the price is not bound to an endpoint"));
  } else if (targetUrl) {
    try {
      const target = new URL(targetUrl);
      const named = new URL(resource);
      if (target.host !== named.host) {
        inspectReasons.push(caution("resource_host_mismatch", `the endpoint is ${target.host} but the challenge names ${named.host}; pay only if that is the seller's real host`));
      }
    } catch {
      /* the preflight already flags an unparseable resource */
    }
  }

  // A multi-rail challenge (EVM + Solana) legitimately names one payee per
  // rail. Only two payees on the SAME network are suspicious.
  const payeesByNetwork = new Map();
  for (const accept of accepts) {
    const list = payeesByNetwork.get(accept.network) || new Set();
    const payee = String(accept.payTo || "").toLowerCase();
    if (payee) list.add(payee);
    payeesByNetwork.set(accept.network, list);
  }
  if ([...payeesByNetwork.values()].some((set) => set.size > 1)) {
    inspectReasons.push(caution("multiple_payees", "two options on the same network pay different addresses; pick one your policy allows"));
  }

  const verdict = verdictOf([...inspectReasons, ...options[0].reasons]);

  return {
    ok: true,
    spec: "verify402/inspect@1",
    target: targetUrl,
    challenge: {
      x402Version: challenge.x402Version ?? null,
      resource,
      acceptCount: accepts.length,
      accepts: options.map((option) => option.accept),
    },
    verdict,
    sign_allowed: verdict !== "BLOCK",
    requires_ack: verdict === "CAUTION",
    summary: options[0].summary,
    reasons: [...inspectReasons, ...options[0].reasons],
    checked: options[0].checked,
    notChecked: options[0].notChecked,
    structural_only: options[0].structural_only,
    options,
    receipt: options[0].receipt,
    note:
      "The inspector fetched the challenge once and ran the same structural payment preflight an agent runs before signing. " +
      "It did not sign, pay, or settle anything. The 402 is not proof that the seller controls the named payee.",
  };
}

export async function inspectUrl(rawUrl, { now = Date.now(), fetchImpl = safeFetchText, method = "GET" } = {}) {
  // A 402 challenge is normally issued before the handler runs, so an empty
  // POST body is enough to read a paywalled POST route.
  const response = await fetchImpl(rawUrl, { method });
  const challenge = extractChallenge({
    // v2 uses PAYMENT-REQUIRED; v1 used X-PAYMENT. Accept both, but only the
    // v2 header is advertised as supported.
    header: response.headers?.["payment-required"]
      ?? response.headers?.["x-payment-required"]
      ?? response.headers?.["x-payment"],
    body: response.body,
  });
  const result = await inspectPaymentChallenge({ challenge, targetUrl: rawUrl, now });
  const reasons = [...result.reasons];
  if (response.status !== 402) {
    reasons.unshift(caution("not_402", `the endpoint answered ${response.status}, not 402; this may not be a paywall`));
  }
  const verdict = verdictOf(reasons);
  return { ...result, status: response.status, verdict, sign_allowed: verdict !== "BLOCK", requires_ack: verdict === "CAUTION", reasons };
}
