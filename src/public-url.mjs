// Public identity URLs must never be attacker-controlled.
//
// The agent card is an identity document: it publishes the service URL, the
// x402 endpoints, and (once minted) the ERC-8004 registration. Deriving that
// URL from the Host header lets any caller make the card claim an attacker's
// origin. Production therefore pins AGENT_URL; non-production falls back to a
// Host allowlist and rejects anything else.

export const DEFAULT_TRUSTED_HOSTS = [
  "verify402.onrender.com",
  "localhost",
  "127.0.0.1",
  "::1",
];

export function parseAgentUrl(raw) {
  if (raw == null || String(raw).trim() === "") return { ok: true, value: null };
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { ok: false, error: "AGENT_URL must be an absolute http(s) URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "AGENT_URL must use http or https" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "AGENT_URL must not contain credentials" };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "AGENT_URL must not contain a query or fragment" };
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return { ok: true, value: `${url.origin}${path}` };
}

function normalizeHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.username || url.password) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function parseTrustedHosts(raw, { agentUrl = null } = {}) {
  const hosts = new Set(DEFAULT_TRUSTED_HOSTS);
  if (agentUrl) {
    const host = normalizeHost(agentUrl);
    if (host) hosts.add(host);
  }
  for (const part of String(raw || "").split(",")) {
    const host = normalizeHost(part);
    if (host) hosts.add(host);
  }
  return hosts;
}

export function hostnameFromHostHeader(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw || /[\s/\\]/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolve the base URL for the agent card.
 * @returns {{ok: true, base: string} | {ok: false, code: string, message: string}}
 */
export function resolvePublicBaseUrl(req, { agentUrl = null, trustedHosts = new Set(DEFAULT_TRUSTED_HOSTS) } = {}) {
  if (agentUrl) return { ok: true, base: agentUrl };

  const hostHeader = req?.headers?.host;
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname) {
    return {
      ok: false,
      code: "untrusted_host",
      message: "the Host header is missing or malformed; set AGENT_URL or use an allowed host",
    };
  }
  if (!trustedHosts.has(hostname)) {
    return {
      ok: false,
      code: "untrusted_host",
      message: "the Host header is not in the public-host allowlist; set AGENT_URL",
    };
  }
  return { ok: true, base: `${req.protocol || "http"}://${String(hostHeader).trim()}` };
}
