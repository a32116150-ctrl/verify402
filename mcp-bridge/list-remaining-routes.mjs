// list-remaining-routes.mjs — one paid call per paid route, to submit each
// route to the CDP Bazaar.
//
// Why this exists: the Bazaar catalogs one resource per settlement. A single
// paid call on /route listed /route only; the other four routes stay invisible
// until each is settled once. This script buys each remaining route once, with
// the same guard, policy and settlement-evidence check as first-payment.mjs.
//
// Cost: testnet USDC only ($0.05 + $0.10 + $0.05 + $0.05 by default prices).
// Safety: MAX_PAYMENT_USD caps every individual payment; a mixed challenge that
// offers a network outside the allowlist is refused as a whole.

import "dotenv/config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import axios from "axios";
import { privateKeyToAccount } from "viem/accounts";

import {
  createExactEvmScheme,
  decodePaymentResponseHeader,
  wrapAxiosWithPayment,
  x402Client,
} from "./x402-client.mjs";
import { createPaymentGuard, createPaymentPolicy, DEFAULT_PAY_TO, DEMO_NETWORK } from "./payment-policy.mjs";
import { verifySettlementEvidence } from "./first-payment.mjs";
import { CLIENT_HEADERS } from "./client-id.mjs";

// Inputs are the documented examples from the bazaar metadata, so the call is
// also a live check that the discoverable example still works.
export const ROUTES = [
  {
    path: "/verify",
    label: "is this arbitrage real?",
    body: { chainId: 1, target: "WETH", base: "USDC", size: 100000 },
  },
  {
    path: "/safety",
    label: "is this token safe to buy?",
    body: { chainId: 1, tokenAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", intendedUsd: 500 },
  },
  {
    path: "/quotecheck",
    label: "is this quote fair?",
    body: {
      chainId: 1,
      tokenIn: "USDC",
      tokenOut: "WETH",
      amountIn: "1000000000",
      quotedOut: "326259300000000000",
      venueClaimed: "some-router.example",
    },
  },
  {
    path: "/depth",
    label: "how much can I actually sell?",
    body: { chainId: 1, tokenAddress: "WETH", baseSymbol: "USDC", sizesUsd: [100, 1000, 10000, 100000] },
  },
];

function config(env = process.env) {
  if (!env.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY required in .env — the BUYER's wallet");
  const serverUrl = String(env.VERIFY402_URL || "https://verify402.onrender.com").trim().replace(/\/+$/, "");
  const maxAmountUsd = Number(env.MAX_PAYMENT_USD || 0.25);
  const networks = env.VERIFY402_NETWORKS === undefined ? DEMO_NETWORK : env.VERIFY402_NETWORKS;
  const payTo = env.VERIFY402_PAY_TO === undefined ? DEFAULT_PAY_TO : env.VERIFY402_PAY_TO;
  const policy = createPaymentPolicy({
    networks,
    payTo,
    resourcePrefix: serverUrl,
    paidRoutes: ROUTES.map((r) => r.path),
  });
  return { serverUrl, maxAmountUsd, privateKey: env.EVM_PRIVATE_KEY, policy };
}

async function main() {
  const cfg = config();
  const account = privateKeyToAccount(cfg.privateKey);
  const client = x402Client.fromConfig({
    policies: [(version, requirements) => cfg.policy.filter(version, requirements)],
  });
  for (const network of cfg.policy.allowedNetworks) {
    client.register(network, createExactEvmScheme(account));
  }

  let expectedResource = null;
  let selected = null;
  client.onBeforePaymentCreation(createPaymentGuard(cfg.policy, {
    expectedResource: () => expectedResource,
    maxAmountUsd: cfg.maxAmountUsd,
  }));
  client.onBeforePaymentCreation((context) => {
    selected = context?.selectedRequirements ?? null;
    return undefined;
  });

  const paid = wrapAxiosWithPayment(
    axios.create({ timeout: 180_000, maxRedirects: 0, headers: CLIENT_HEADERS }),
    client,
  );

  console.log(`payer ${account.address} → ${cfg.serverUrl}`);
  console.log(`networks=${cfg.policy.allowedNetworks.join(",")} payee=${cfg.policy.allowedPayTo} capPerCall=$${cfg.maxAmountUsd}\n`);

  // ROUTE_FILTER=/safety retries one route without re-buying the others.
  const filter = String(process.env.ROUTE_FILTER || "").trim();
  const todo = filter ? ROUTES.filter((r) => r.path === filter) : ROUTES;
  if (!todo.length) throw new Error(`ROUTE_FILTER=${filter} matches no known route`);

  const results = [];
  for (const route of todo) {
    expectedResource = `${cfg.serverUrl}${route.path}`;
    selected = null;
    process.stdout.write(`${route.path.padEnd(12)} ${route.label} … `);
    try {
      const res = await paid.post(expectedResource, route.body);
      const raw = res.headers?.["payment-response"] ?? res.headers?.["x-payment-response"];
      const evidence = verifySettlementEvidence({
        rawHeader: raw,
        decodeReceipt: decodePaymentResponseHeader,
        expected: {
          expectedNetwork: selected?.network,
          expectedPayer: account.address,
          expectedAmountAtomic: selected?.amount,
        },
      });
      if (!evidence.ok) {
        console.log(`FAILED (${evidence.reason})`);
        results.push({ path: route.path, ok: false, reason: evidence.reason });
        continue;
      }
      console.log(`${res.status} · settled ${evidence.receipt.network} · ${evidence.receipt.transaction}`);
      results.push({ path: route.path, ok: true, tx: evidence.receipt.transaction, network: evidence.receipt.network });
    } catch (e) {
      console.log(`FAILED (${e?.message || e})`);
      results.push({ path: route.path, ok: false, reason: String(e?.message || e) });
    }
  }

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  console.log(`\nsettled ${ok.length}/${results.length}`);
  if (bad.length) {
    for (const r of bad) console.log(`  not settled: ${r.path} — ${r.reason}`);
    process.exit(1);
  }
}

// Only run when executed directly; importing this file must not spend money.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
