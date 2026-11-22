// Client for the private paid-engine service.
//
// When VERIFY402_ENGINE_URL and VERIFY402_ENGINE_TOKEN are set, paid engine
// calls are computed by the private deployment and only the result crosses the
// wire. With no URL configured the local implementation is used, which keeps
// local development and the offline suite working. The public package must not
// be deployed as a paid service: the deployable service lives in the private
// repository.
//
// BigInt options and results are encoded as { $$bigint: "..." } so amounts
// never lose precision in JSON.

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? { $$bigint: value.toString() } : value;
}

function bigintRevive(_key, value) {
  if (Array.isArray(value)) return value.map((item) => bigintRevive(null, item));
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$$bigint") return BigInt(value.$$bigint);
    for (const key of keys) value[key] = bigintRevive(null, value[key]);
  }
  return value;
}

/** True when this process is configured to send paid work to the private service. */
export function remoteEngineConfigured() {
  return Boolean(process.env.VERIFY402_ENGINE_URL && process.env.VERIFY402_ENGINE_TOKEN);
}

/**
 * Ask the private service to run a paid engine. Returns null when no private
 * service is configured, so the caller can use its local implementation.
 */
export async function remoteEngine(name, chainId, opts = {}) {
  const base = process.env.VERIFY402_ENGINE_URL;
  const token = process.env.VERIFY402_ENGINE_TOKEN;
  if (!base || !token) return null;

  const url = `${base.replace(/\/+$/, "")}/internal/engine/${encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ chainId, opts }, bigintReplacer),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const wrapped = new Error("private engine service is unreachable");
    wrapped.code = "engine_service_unavailable";
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`private engine service returned ${response.status}`);
    error.code = "engine_service_unavailable";
    error.status = response.status;
    error.detail = detail.slice(0, 200);
    throw error;
  }
  const text = await response.text();
  return JSON.parse(text, bigintRevive);
}
