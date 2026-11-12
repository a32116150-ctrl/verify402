import test from "node:test";
import assert from "node:assert/strict";

import { formatUnits, normalizeTransfer, buildExplorerPayload, chainFor } from "../src/explorer.mjs";

const TX = "0x2506afa3087f86cdf64072741be77d30d92613b74143118c5b5b72ca3c5825f7";

function transfer(value, symbol = "USDC", timestamp = "2026-10-26T11:34:23.000000Z") {
  return {
    timestamp,
    transaction_hash: TX,
    total: { value },
    token: { symbol, decimals: 6 },
    from: { hash: "0x74Dc591900aa574CBdfBEf8E3212F1FB3BA16ce8" },
    to: { hash: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb" },
  };
}

test("formatUnits is exact for USDC amounts", () => {
  assert.equal(formatUnits("30000", 6), "0.03");
  assert.equal(formatUnits("120000", 6), "0.12");
  assert.equal(formatUnits("1000000", 6), "1");
  assert.equal(formatUnits("1", 6), "0.000001");
  assert.equal(formatUnits("0", 6), "0");
});

test("formatUnits refuses non-integer input instead of guessing", () => {
  assert.equal(formatUnits("1.5", 6), "0");
  assert.equal(formatUnits(undefined, 6), "0");
});

test("normalizeTransfer links to the chain explorer and keeps the hash", () => {
  const row = normalizeTransfer(transfer("30000"), chainFor("testnet"));
  assert.equal(row.amount, "0.03");
  assert.equal(row.symbol, "USDC");
  assert.equal(row.txHash, TX);
  assert.equal(row.url, `https://sepolia.basescan.org/tx/${TX}`);
});

test("buildExplorerPayload sorts newest first and totals the rows", () => {
  const payload = buildExplorerPayload({
    mode: "testnet",
    payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
    transfers: [
      transfer("30000", "USDC", "2026-10-26T11:32:52.000000Z"),
      transfer("30000", "USDC", "2026-10-18T11:42:02.000000Z"),
      transfer("30000", "USDC", "2026-10-26T11:34:23.000000Z"),
      transfer("30000", "USDC", "2026-10-26T11:34:07.000000Z"),
    ],
    fetchedAt: "2026-11-12T00:00:00.000Z",
  });
  assert.equal(payload.totals.count, 4);
  assert.equal(payload.totals.amount, "0.12");
  assert.equal(payload.settlements[0].timestamp, "2026-10-26T11:34:23.000000Z");
  assert.equal(payload.settlements[3].timestamp, "2026-10-18T11:42:02.000000Z");
});

test("buildExplorerPayload keeps the payments token and reports what it skipped", () => {
  const payload = buildExplorerPayload({
    mode: "testnet",
    payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
    transfers: [transfer("30000", "USDC"), transfer("500", "WETH")],
  });
  assert.equal(payload.settlements.length, 1);
  assert.equal(payload.skipped, 1);
});

test("mainnet is reported as armed only when it is", () => {
  assert.equal(buildExplorerPayload({ mode: "testnet", payTo: "0x0", transfers: [] }).mainnet.armed, false);
  assert.equal(buildExplorerPayload({ mode: "mainnet", payTo: "0x0", transfers: [] }).mainnet.armed, true);
});
