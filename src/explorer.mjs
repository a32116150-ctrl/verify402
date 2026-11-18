// Live settlement list for /activity.
//
// The service keeps no durable settlement ledger (the free instance has no
// disk), so the honest source of "what did this service actually receive" is
// the chain itself. We read ERC-20 transfers to the payTo address from a public
// Blockscout instance and normalize them. Nothing is inferred: a row exists
// because a transfer exists at that hash.

const CHAINS = {
  testnet: {
    name: "Base Sepolia",
    network: "eip155:84532",
    blockscout: "https://base-sepolia.blockscout.com",
    explorer: "https://sepolia.basescan.org",
  },
  mainnet: {
    name: "Base",
    network: "eip155:8453",
    blockscout: "https://base.blockscout.com",
    explorer: "https://basescan.org",
  },
};

export function chainFor(mode) {
  return CHAINS[mode] || CHAINS.testnet;
}

// Blockscout (the primary indexer) sits behind a Cloudflare challenge on Base
// mainnet, so the server cannot read it. The fallback reads the same facts from
// the chain directly: ERC-20 Transfer logs to the payee, scanned over a recent
// window. A row still exists because the transfer exists at that hash.
const USDC_BY_MODE = {
  testnet: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  mainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const DEFAULT_EXPLORER_RPC = {
  testnet: "https://base-sepolia-rpc.publicnode.com",
  mainnet: "https://base-rpc.publicnode.com",
};
const SCAN_WINDOW_BLOCKS = 250_000; // ~5.8 days on Base
const SCAN_CHUNK_BLOCKS = 50_000; // public RPCs cap eth_getLogs ranges

function toHex(n) {
  return `0x${Number(n).toString(16)}`;
}

async function rpcCall(url, method, params, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`rpc ${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message || "error"}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchExplorerFromRpc({
  mode,
  payTo,
  results = [],
  measuredAt = null,
  baseUrl = "",
  fetchImpl = fetch,
  timeoutMs = 8000,
  rpcUrl,
}) {
  const url = rpcUrl || DEFAULT_EXPLORER_RPC[mode] || DEFAULT_EXPLORER_RPC.mainnet;
  const token = USDC_BY_MODE[mode] || USDC_BY_MODE.mainnet;
  const latestHex = await rpcCall(url, "eth_blockNumber", [], fetchImpl, timeoutMs);
  const latest = Number(BigInt(latestHex));
  const paddedTo = `0x${String(payTo).toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

  const logs = [];
  for (let end = latest; end > latest - SCAN_WINDOW_BLOCKS; end -= SCAN_CHUNK_BLOCKS) {
    const start = Math.max(latest - SCAN_WINDOW_BLOCKS, end - SCAN_CHUNK_BLOCKS + 1);
    const chunk = await rpcCall(
      url,
      "eth_getLogs",
      [{ address: token, fromBlock: toHex(start), toBlock: toHex(end), topics: [TRANSFER_TOPIC, null, paddedTo] }],
      fetchImpl,
      timeoutMs,
    );
    if (Array.isArray(chunk)) logs.push(...chunk);
  }

  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber))];
  const timestampByBlock = new Map();
  for (const blockNumber of blockNumbers) {
    const block = await rpcCall(url, "eth_getBlockByNumber", [blockNumber, false], fetchImpl, timeoutMs);
    if (block?.timestamp) timestampByBlock.set(blockNumber, Number(BigInt(block.timestamp)) * 1000);
  }

  const transfers = logs.map((log) => ({
    transaction_hash: log.transactionHash,
    timestamp: timestampByBlock.has(log.blockNumber)
      ? new Date(timestampByBlock.get(log.blockNumber)).toISOString()
      : null,
    from: { hash: `0x${String(log.topics?.[1] || "").slice(26)}` },
    to: { hash: `0x${String(log.topics?.[2] || "").slice(26)}` },
    token: { symbol: "USDC", decimals: 6 },
    total: { value: BigInt(log.data).toString() },
  }));

  return buildExplorerPayload({ mode, payTo, transfers, results, measuredAt, baseUrl });
}


// Fixed-point formatting without floating point. 30000 at 6 decimals is 0.03.
export function formatUnits(raw, decimals) {
  const value = String(raw ?? "0").trim();
  if (!/^\d+$/.test(value)) return "0";
  const places = Math.max(0, Math.min(36, Number(decimals) || 0));
  const base = 10n ** BigInt(places);
  const units = BigInt(value);
  const whole = units / base;
  const fraction = (units % base).toString().padStart(places, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function normalizeTransfer(transfer, chain) {
  const token = transfer?.token || {};
  const decimals = Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : 6;
  const hash = transfer?.transaction_hash || "";
  return {
    timestamp: transfer?.timestamp || null,
    txHash: hash,
    url: hash ? `${chain.explorer}/tx/${hash}` : null,
    from: transfer?.from?.hash || null,
    to: transfer?.to?.hash || null,
    amount: formatUnits(transfer?.total?.value, decimals),
    symbol: token.symbol || "USDC",
    decimals,
  };
}

export function buildVerdictRows(results = [], { baseUrl = "", measuredAt = null } = {}) {
  return results
    .filter((row) => row && row.target)
    .map((row) => ({
      id: String(row.target),
      pair: `${row.target}/USDC`,
      verdict: row.verdict || "unavailable",
      grossBps: Number.isFinite(row.grossBps) ? row.grossBps : null,
      netBps: Number.isFinite(row.netBps) ? row.netBps : null,
      blockNumber: row.blockNumber ?? null,
      blockHash: row.blockHash ?? null,
      measuredAt,
      url: `${baseUrl || ""}/findings`,
    }))
    .sort((a, b) => a.pair.localeCompare(b.pair));
}

export function buildExplorerPayload({
  mode,
  payTo,
  transfers = [],
  results = [],
  measuredAt = null,
  baseUrl = "",
  fetchedAt = new Date().toISOString(),
}) {
  const chain = chainFor(mode);
  const usdc = [];
  let skipped = 0;
  for (const transfer of transfers) {
    const symbol = (transfer?.token?.symbol || "").toUpperCase();
    if (symbol && symbol !== "USDC") {
      skipped += 1;
      continue;
    }
    usdc.push(normalizeTransfer(transfer, chain));
  }
  usdc.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));

  let rawTotal = 0n;
  for (const row of usdc) {
    const [whole, fraction = ""] = row.amount.split(".");
    const places = row.decimals;
    rawTotal += BigInt(whole) * 10n ** BigInt(places) + BigInt((fraction + "0".repeat(places)).slice(0, places) || "0");
  }
  const total = usdc.length ? formatUnits(rawTotal, usdc[0].decimals) : "0";

  return {
    spec: "verify402/explorer@1",
    mode,
    network: chain.network,
    chain: chain.name,
    address: payTo,
    explorer: chain.explorer,
    mainnet: { armed: mode === "mainnet" },
    fetchedAt,
    settlements: usdc,
    verdicts: buildVerdictRows(results, { baseUrl, measuredAt }),
    verdictsMeasuredAt: measuredAt,
    totals: { count: usdc.length, amount: total, symbol: "USDC" },
    skipped,
    note:
      "On-chain ERC-20 transfers to the service address. A row exists because the transfer exists at that hash; " +
      "the list is not a claim about unique buyers. " +
      (mode === "mainnet"
        ? "Mainnet rows are the operator's own settlements so far."
        : "Testnet rows are the operator's own tests."),
  };
}

export async function fetchExplorer({ mode, payTo, results = [], measuredAt = null, baseUrl = "", fetchImpl = fetch, timeoutMs = 8000, rpcUrl }) {
  const chain = chainFor(mode);
  const url = `${chain.blockscout}/api/v2/addresses/${payTo}/token-transfers?type=ERC-20`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`blockscout ${response.status}`);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // A Cloudflare interstitial is HTML with HTTP 200; treat it as a failure
      // so the chain fallback runs instead of returning a silent empty list.
      throw new Error("blockscout returned non-JSON (edge challenge)");
    }
    return buildExplorerPayload({ mode, payTo, transfers: body.items || [], results, measuredAt, baseUrl });
  } catch (error) {
    if (rpcUrl === false) throw error;
    return fetchExplorerFromRpc({ mode, payTo, results, measuredAt, baseUrl, fetchImpl, timeoutMs, rpcUrl });
  } finally {
    clearTimeout(timer);
  }
}
