// All-time settlement counts, read from the chain.
//
// A row exists because an ERC-20 transfer to the service address exists at
// that hash. This module counts those rows; it does not infer a unique buyer,
// and it does not call a bot a customer.
//
// Mainnet: Base's Blockscout sits behind a Cloudflare challenge, so the server
// keeps a small persisted index and extends it with eth_getLogs from the launch
// block. The first scan is bounded (about 34 requests at 25k blocks each); every
// later scan only reads new blocks.
//
// Testnet: the free host has no disk and the payee's history is short, so the
// public Blockscout API is the source. It is not behind the mainnet challenge.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logWarn } from "./log.mjs";

const SPEC = "verify402/settlement-index@1";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_TESTNET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TESTNET_BLOCKSCOUT = "https://base-sepolia.blockscout.com";
const DEFAULT_START_BLOCK = 59_000_000; // Base mainnet, before the first transfer
const CHUNK_BLOCKS = 25_000; // public RPCs silently truncate larger ranges
const REORG_DEPTH = 50;
const TIMEOUT_MS = 8_000;

// Wallets the operator controls. Kept here as a default so a fresh deploy can
// tell "operator calls" from "someone else paid" without extra configuration.
// Override with OPERATOR_ADDRESSES=a,b (comma separated).
export const DEFAULT_OPERATOR_ADDRESSES = Object.freeze([
  "0x9a48474B06554c25258B4bc3Def5A637cBF5AD4b", // mainnet payer
  "0x74Dc591900aa574CBdfBEf8E3212F1FB3BA16ce8", // testnet payer
]);

function toHex(n) {
  return `0x${Number(n).toString(16)}`;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function paddedAddress(value) {
  return `0x${lower(value).replace(/^0x/, "").padStart(64, "0")}`;
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

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`blockscout HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function formatUsdc(raw) {
  const value = BigInt(String(raw ?? "0"));
  const base = 1_000_000n;
  const whole = value / base;
  const fraction = (value % base).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

// ---------------------------------------------------------------- summary ----
export function summarizeSettlements(rows, operatorAddresses = DEFAULT_OPERATOR_ADDRESSES) {
  const operators = new Set((operatorAddresses || []).map(lower).filter(Boolean));
  const payerCounts = new Map();
  let raw = 0n;
  let firstAt = null;
  let lastAt = null;

  for (const row of rows || []) {
    raw += BigInt(String(row.amountRaw ?? "0"));
    const from = lower(row.from);
    if (from) payerCounts.set(from, (payerCounts.get(from) || 0) + 1);
    if (row.timestamp) {
      if (!firstAt || row.timestamp < firstAt) firstAt = row.timestamp;
      if (!lastAt || row.timestamp > lastAt) lastAt = row.timestamp;
    }
  }

  let operatorCalls = 0;
  let outsideCalls = 0;
  let outsidePayers = 0;
  let repeatOutsidePayers = 0;
  for (const [payer, count] of payerCounts) {
    if (operators.has(payer)) {
      operatorCalls += count;
    } else {
      outsideCalls += count;
      outsidePayers += 1;
      if (count >= 2) repeatOutsidePayers += 1;
    }
  }

  return {
    paidCalls: (rows || []).length,
    usdc: formatUsdc(raw),
    operatorCalls,
    outsideCalls,
    outsideUsdc: formatUsdc(rows.reduce(
      (total, row) => (operators.has(lower(row.from)) ? total : total + BigInt(String(row.amountRaw ?? "0"))),
      0n,
    )),
    outsidePayers,
    repeatOutsidePayers,
    uniquePayers: payerCounts.size,
    firstAt,
    lastAt,
  };
}

// ------------------------------------------------------------ mainnet index ----
export function createSettlementIndex({
  payTo,
  rpcUrl = "https://base-rpc.publicnode.com",
  filePath = null,
  startBlock = DEFAULT_START_BLOCK,
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  if (!payTo) throw new Error("createSettlementIndex requires payTo");
  const payee = String(payTo);
  const payeeLower = lower(payee);
  const tokenTopic = paddedAddress(payee);

  let rows = [];
  let seen = new Set();
  let lastBlock = Math.max(0, Number(startBlock) - 1);
  let loaded = false;
  let refreshing = null;
  let lastRefreshAt = 0;

  function load() {
    if (!filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed?.spec !== SPEC || lower(parsed.payTo) !== payeeLower) return;
      const loadedRows = Array.isArray(parsed.rows) ? parsed.rows : [];
      rows = loadedRows.filter((row) => row && row.txHash && row.amountRaw);
      seen = new Set(rows.map((row) => `${row.txHash}:${row.logIndex ?? "0"}`));
      lastBlock = Math.max(lastBlock, Number(parsed.lastBlock) || lastBlock);
    } catch (error) {
      if (error?.code !== "ENOENT") logWarn("[settlements] could not read the index; rescanning", error);
    }
  }

  function save() {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const payload = {
        spec: SPEC,
        payTo: payee,
        lastBlock,
        rows,
        savedAt: new Date().toISOString(),
      };
      const temporary = `${filePath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(payload)}\n`, "utf8");
      renameSync(temporary, filePath);
    } catch (error) {
      logWarn("[settlements] could not save the index", error);
    }
  }

  async function scan(fromBlock, toBlock) {
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += CHUNK_BLOCKS) {
      const end = Math.min(start + CHUNK_BLOCKS - 1, toBlock);
      const chunk = await rpcCall(
        rpcUrl,
        "eth_getLogs",
        [{ address: USDC_MAINNET, fromBlock: toHex(start), toBlock: toHex(end), topics: [TRANSFER_TOPIC, null, tokenTopic] }],
        fetchImpl,
        timeoutMs,
      );
      if (Array.isArray(chunk)) logs.push(...chunk);
    }
    return logs;
  }

  async function stamp(blockNumbers) {
    for (const blockNumber of blockNumbers) {
      try {
        const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", [toHex(blockNumber), false], fetchImpl, timeoutMs);
        if (!block?.timestamp) continue;
        const timestamp = new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();
        for (const row of rows) {
          if (row.blockNumber === blockNumber && !row.timestamp) row.timestamp = timestamp;
        }
      } catch {
        // A missing timestamp is better than a made-up one.
      }
    }
  }

  async function run() {
    if (!loaded) {
      load();
      loaded = true;
    }
    const latestHex = await rpcCall(rpcUrl, "eth_blockNumber", [], fetchImpl, timeoutMs);
    const latest = Number(BigInt(latestHex));
    const from = Math.max(
      Number(startBlock),
      lastBlock + 1 - (lastBlock >= Number(startBlock) ? REORG_DEPTH : 0),
    );
    if (from <= latest) {
      const logs = await scan(from, latest);
      const newBlocks = new Set();
      for (const log of logs) {
        const key = `${log.transactionHash}:${log.logIndex ?? "0"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const blockNumber = Number(BigInt(log.blockNumber));
        rows.push({
          txHash: log.transactionHash,
          logIndex: String(log.logIndex ?? "0"),
          blockNumber,
          from: `0x${String(log.topics?.[1] || "").slice(26)}`,
          amountRaw: BigInt(log.data).toString(),
          timestamp: null,
        });
        newBlocks.add(blockNumber);
      }
      lastBlock = latest;
      if (newBlocks.size) await stamp(newBlocks);
      save();
    }
    lastRefreshAt = Date.now();
    return snapshot();
  }

  function snapshot() {
    return {
      payTo: payee,
      lastBlock,
      lastRefreshAt,
      rows: [...rows].sort((a, b) => {
        const byTime = String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
        return byTime || (b.blockNumber - a.blockNumber);
      }),
    };
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = run().finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    refresh,
    snapshot,
    lastRefreshAt: () => lastRefreshAt,
    filePath,
  };
}

// -------------------------------------------------------------- testnet api ----
export async function fetchTestnetStats({
  payTo,
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
  operatorAddresses = DEFAULT_OPERATOR_ADDRESSES,
} = {}) {
  if (!payTo) throw new Error("fetchTestnetStats requires payTo");
  const base = `${TESTNET_BLOCKSCOUT}/api/v2/addresses/${payTo}/token-transfers?type=ERC-20`;
  let url = base;
  const items = [];
  for (let page = 0; url && page < 20; page += 1) {
    const body = await fetchJson(url, fetchImpl, timeoutMs);
    items.push(...(Array.isArray(body?.items) ? body.items : []));
    const next = body?.next_page_params;
    if (!next) break;
    const query = new URLSearchParams(Object.entries(next).map(([key, value]) => [key, String(value)]));
    url = `${base}&${query.toString()}`;
  }

  const rows = items
    .filter((transfer) => {
      const symbol = String(transfer?.token?.symbol || "").toUpperCase();
      const address = lower(transfer?.token?.address_hash || transfer?.token?.address || "");
      const to = lower(transfer?.to?.hash);
      return (symbol === "USDC" || address === lower(USDC_TESTNET)) && (!to || to === lower(payTo));
    })
    .map((transfer) => ({
      txHash: transfer.transaction_hash,
      blockNumber: Number(transfer.block_number) || null,
      from: lower(transfer.from?.hash),
      amountRaw: String(transfer.total?.value ?? "0"),
      timestamp: transfer.timestamp || null,
    }));

  return {
    chain: "Base Sepolia",
    network: "eip155:84532",
    source: "blockscout",
    ...summarizeSettlements(rows, operatorAddresses),
  };
}
