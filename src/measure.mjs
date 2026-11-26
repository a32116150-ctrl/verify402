// Public client for the paid measurement engine.
//
// The real implementation lives in the private service (verify402-engine).
// This module keeps only the free chain/readiness helpers and a thin proxy;
// there is no local venue/quoter computation in the public package.

import { createPublicClient, http, fallback } from "viem";
import * as viemChains from "viem/chains";
import { chain, readinessChain, GATE_CHAINS } from "./config.mjs";
import { requirePaidLicense } from "./license.mjs";
import { remoteEngine } from "./engine-client.mjs";

const clients = new Map();

export function clientFor(chainId) {
  if (clients.has(chainId)) return clients.get(chainId);
  const client = buildClient(chain(chainId));
  clients.set(chainId, client);
  return client;
}

// The free transaction gate also reads gate-only chains (GATE_CHAINS). They get
// their own cache so a gate-only chain can never be handed to a paid route
// through clientFor.
const gateClients = new Map();

export function gateClientFor(chainId) {
  if (!GATE_CHAINS[chainId]) return clientFor(chainId);
  if (gateClients.has(chainId)) return gateClients.get(chainId);
  const client = buildClient(GATE_CHAINS[chainId]);
  gateClients.set(chainId, client);
  return client;
}

function buildClient(c) {
  const offline = process.env.TEST_OFFLINE === "1";
  const offlineUrl = process.env.TEST_OFFLINE_RPC_URL || "http://127.0.0.1:1/offline-rpc";
  const configured = process.env[c.rpcEnv];
  // A single free endpoint can throttle a cloud instance's egress IP, which is
  // how a correct measurement becomes a 90-second "loading" spinner. When no
  // paid endpoint is configured, fail over across independent public ones
  // instead of trusting any single provider.
  //
  // TEST_OFFLINE=1 deliberately uses one closed endpoint and no public
  // fallback. Tests that need chain access declare it and are skipped by the
  // shared suite helper; nothing can silently reach mainnet in offline mode.
  const urls = offline
    ? [offlineUrl]
    : configured
      ? [configured]
      : [c.rpcDefault, ...(c.rpcFallbacks || [])];
  const viemChain = viemChains[c.viemChain];
  const transport = offline
    ? http(offlineUrl, { retryCount: 0, timeout: 1_000 })
    : urls.length === 1
      ? http(urls[0], { retryCount: 2, timeout: 15_000 })
      : fallback(
          urls.map((url) => http(url, { retryCount: 0, timeout: 5_000 })),
          { rank: false },
        );
  return createPublicClient({ chain: viemChain, transport });
}

// Readiness has its own client cache and its own chain map. It must not share
// measurement clients: /ready only needs the latest block, and adding Base
// Sepolia here must not make it a paid-route venue. The outer /ready gate still
// caps the whole check at 3s, so this transport uses no retries.
const readinessClients = new Map();

export function readinessClientFor(chainId) {
  if (readinessClients.has(chainId)) return readinessClients.get(chainId);
  const c = readinessChain(chainId);
  const offline = process.env.TEST_OFFLINE === "1";
  const offlineUrl = process.env.TEST_OFFLINE_RPC_URL || "http://127.0.0.1:1/offline-rpc";
  const configured = process.env.READY_RPC_URL || process.env[c.rpcEnv];
  const url = offline ? offlineUrl : (configured || c.rpcDefault);
  const viemChain = viemChains[c.viemChain];
  if (!viemChain) throw new Error(`readiness chain ${c.name} is not available in this viem build`);
  const client = createPublicClient({
    chain: viemChain,
    transport: http(url, { retryCount: 0, timeout: 3_000 }),
  });
  readinessClients.set(chainId, client);
  return client;
}

// Deep readiness: prove the configured endpoint is on the expected chain, then
// read a block. The chain-ID check catches a mispointed RPC (for example,
// mainnet behind READY_CHAIN_ID=84532) that would otherwise look "ready".
// The timeout covers both calls together, so a slow endpoint cannot hold /ready
// open past the platform's probe deadline.
export async function readinessProbe(chainId, { timeoutMs = 3_000, client } = {}) {
  readinessChain(chainId);
  const rpc = client || readinessClientFor(chainId);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`readiness probe exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async () => {
        const rpcChainId = Number(await rpc.getChainId());
        if (rpcChainId !== Number(chainId)) {
          throw new Error(`readiness RPC reports chain ${rpcChainId}, expected ${chainId}`);
        }
        const blockNumber = Number(await rpc.getBlockNumber());
        return { chainId: Number(chainId), rpcChainId, blockNumber };
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stable, public-safe classification of a provider/contract error. */
export function classifyQuoteError(error) {
  const names = [error?.name, error?.cause?.name, error?.cause?.cause?.name].filter(Boolean).join(" ");
  const msg = String(error?.shortMessage || error?.details || error?.message || error || "");
  if (/decode|returned values|could not decode|cannot decode|abi/i.test(`${names} ${msg}`)) {
    return { kind: "decode", detail: msg };
  }
  if (/CallExecutionError/i.test(names) || /execution reverted|revert|panic/i.test(msg)) {
    return { kind: "revert", detail: msg };
  }
  if (/rate limit|too many requests|429/i.test(msg)) {
    return { kind: "transport", reason: "rate_limited", detail: msg };
  }
  return { kind: "transport", reason: "network", detail: msg };
}

export function quoteOk(amountOut) {
  return { ok: true, amountOut };
}

export function quoteFail(kind, detail = null, reason = null) {
  return { ok: false, kind, detail, reason };
}

export function isHardQuoteFailure(result) {
  return result && result.ok === false && (result.kind === "transport" || result.kind === "decode");
}

/**
 * Paid measurement. Computed only by the private service. If that service is
 * not configured, fail closed with a transport-shaped result when the chain is
 * unreadable, and refuse outright when it is readable.
 */
export async function measureRoundTrip(chainId, opts = {}) {
  requirePaidLicense("verify");
  const remote = await remoteEngine("verify", chainId, opts);
  if (remote !== null) return remote;
  try {
    await clientFor(chainId).getBlockNumber();
  } catch (error) {
    const classified = classifyQuoteError(error);
    return { ok: false, kind: classified.kind, reason: classified.reason, detail: classified.detail, _detail: error };
  }
  const error = new Error("private paid-engine service is not configured");
  error.code = "engine_service_unavailable";
  throw error;
}
