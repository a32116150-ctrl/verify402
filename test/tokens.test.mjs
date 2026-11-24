import test from "node:test";
import assert from "node:assert/strict";

import { CHAINS } from "../src/config.mjs";
import {
  TOKEN_REGISTRY,
  findToken,
  assumedUsd,
  networkIdOf,
  knownNetworks,
  STABLE,
  VOLATILE,
} from "../src/tokens.mjs";
import { parseNetwork } from "../src/preflight.mjs";

test("every registry address is well formed for its family", () => {
  for (const [id, chain] of Object.entries(TOKEN_REGISTRY)) {
    for (const [address, token] of Object.entries(chain.tokens)) {
      assert.ok([STABLE, VOLATILE].includes(token.kind), `${id} ${token.symbol} has an unknown kind`);
      assert.ok([6, 18].includes(token.decimals), `${id} ${token.symbol} has odd decimals`);
      assert.ok(token.symbol.length >= 2, `${id} has a token with no symbol`);
      if (id.startsWith("eip155:")) {
        assert.match(address, /^0x[0-9a-f]{40}$/, `${id} ${token.symbol} is not a lowercase EVM address`);
      } else {
        assert.match(address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `${id} ${token.symbol} is not a base58 mint`);
      }
    }
  }
});

test("the registry agrees with the USDC addresses already in config", () => {
  for (const [chainId, chain] of Object.entries(CHAINS)) {
    const entry = TOKEN_REGISTRY[`eip155:${chainId}`];
    assert.ok(entry, `eip155:${chainId} is missing from the registry`);
    const usdc = entry.tokens[chain.tokens.USDC.address.toLowerCase()];
    assert.ok(usdc, `eip155:${chainId} USDC is missing from the registry`);
    assert.equal(usdc.symbol, "USDC");
  }
});

test("the testnet rails carry the USDC addresses the gate already used", () => {
  assert.ok(TOKEN_REGISTRY["eip155:84532"].tokens["0x036cbd53842c5426634e7929541ec2318f3dcf7e"]);
  assert.ok(TOKEN_REGISTRY["eip155:11155111"].tokens["0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"]);
});

test("findToken resolves known tokens case-insensitively on EVM", () => {
  const base = parseNetwork("eip155:8453");
  assert.equal(findToken(base, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").symbol, "USDC");
  assert.equal(findToken(base, "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2").symbol, "USDT");
  assert.equal(findToken(base, "0x0000000000000000000000000000000000000000"), null);
});

test("a token address from one chain does not resolve on another", () => {
  const solana = parseNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(findToken(solana, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").symbol, "USDC");
  assert.equal(findToken(solana, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), null);
  const base = parseNetwork("eip155:8453");
  assert.equal(findToken(base, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), null);
});

test("assumedUsd prices dollar stables and refuses volatile ones", () => {
  const base = parseNetwork("eip155:8453");
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const usdt = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
  const weth = "0x4200000000000000000000000000000000000006";
  assert.equal(assumedUsd(base, usdc, 30000), 0.03);
  assert.equal(assumedUsd(base, usdt, 5000), 0.005);
  assert.equal(assumedUsd(base, weth, 1000000000000000000n), null);
  assert.equal(assumedUsd(base, "0x1234567890123456789012345678901234567890", 1000), null);
});

test("networkIdOf maps parsed networks to registry ids", () => {
  assert.equal(networkIdOf(parseNetwork("base")), "eip155:8453");
  assert.equal(networkIdOf(parseNetwork("eip155:84532")), "eip155:84532");
  assert.equal(networkIdOf(parseNetwork("solana-devnet")), "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  assert.equal(networkIdOf(parseNetwork("eip155:4663")), "eip155:4663");
  assert.equal(networkIdOf(null), null);
});

test("knownNetworks lists every chain with its tokens", () => {
  const networks = knownNetworks();
  assert.equal(networks.length, Object.keys(TOKEN_REGISTRY).length);
  const base = networks.find((n) => n.id === "eip155:8453");
  assert.ok(base.tokens.includes("USDC"));
  assert.ok(base.tokens.includes("USDT"));
});
