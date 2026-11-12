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

export function buildExplorerPayload({ mode, payTo, transfers = [], fetchedAt = new Date().toISOString() }) {
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
    totals: { count: usdc.length, amount: total, symbol: "USDC" },
    skipped,
    note:
      "On-chain ERC-20 transfers to the service address. A row exists because the transfer exists at that hash; " +
      "the list is not a claim about unique buyers. Testnet rows are the operator's own tests.",
  };
}

export async function fetchExplorer({ mode, payTo, fetchImpl = fetch, timeoutMs = 8000 }) {
  const chain = chainFor(mode);
  const url = `${chain.blockscout}/api/v2/addresses/${payTo}/token-transfers?type=ERC-20`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`blockscout ${response.status}`);
    const body = await response.json();
    return buildExplorerPayload({ mode, payTo, transfers: body.items || [] });
  } finally {
    clearTimeout(timer);
  }
}
