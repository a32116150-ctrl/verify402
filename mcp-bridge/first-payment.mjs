// first-payment.mjs — the "does the whole pipe actually move money?" script.
//
// Usage (from the mcp-bridge directory):
//   node first-payment.mjs
//
// Reads from .env (NEVER paste these into any chat):
//   EVM_PRIVATE_KEY   wallet key of the BUYER. It must hold USDC on the network
//                     this payer is allowed to use (Base Sepolia testnet by
//                     default; Base mainnet only after an explicit
//                     VERIFY402_NETWORKS=eip155:8453 opt-in).
//   VERIFY402_URL     default https://verify402.onrender.com
//   VERIFY402_NETWORKS  comma-separated allowlist; default eip155:84532
//   VERIFY402_PAY_TO  expected payee; default the verify402 payee
//   MAX_PAYMENT_USD   spend cap, default 0.03
//
// What it does: buys the answer to ONE /route question ($0.03), paying the
// exact-x402 price from the wallet above to the seller's payTo address,
// settled on-chain by the facilitator.
//
// Safety: this payer is independent of scripts/smoke.mjs. Before any
// signature exists it requires the whole 402 challenge to use only allowlisted
// EVM networks, the configured payee, canonical USDC for that network, the
// expected /route resource, and an amount within MAX_PAYMENT_USD. A mixed
// challenge that also offers Base mainnet is refused as a whole.
//
// A non-zero exit tells the smoke test that the paid call did not produce a
// decodable, successful PAYMENT-RESPONSE receipt. Exit code 0 alone is not
// treated as proof of settlement by callers that also look for the marker.

import axios from "axios";
import { createExactEvmScheme, decodePaymentResponseHeader, wrapAxiosWithPayment, x402Client } from "./x402-client.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import {
  createPaymentGuard,
  createPaymentPolicy,
  DEFAULT_PAY_TO,
  DEMO_NETWORK,
} from "./payment-policy.mjs";
import { CLIENT_HEADERS } from "./client-id.mjs";

export const FIRST_PAYMENT_ROUTE = "/route";
export const FIRST_PAYMENT_MAX_USD = 0.03;
export const DEFAULT_SERVER_URL = "https://verify402.onrender.com";
export const SETTLEMENT_OK_MARKER = "VERIFY402_SETTLEMENT_OK";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolve the payer configuration. Missing optional values use the documented
 * demo defaults; an explicitly empty network/payee value is a misconfiguration
 * and throws instead of silently falling back to something wider.
 */
export function resolvePayerConfig(env = process.env) {
  const serverUrl = String(env.VERIFY402_URL || DEFAULT_SERVER_URL).trim().replace(/\/+$/, "");
  if (!serverUrl) throw new Error("VERIFY402_URL must not be empty");

  const maxAmountUsd = Number(env.MAX_PAYMENT_USD || FIRST_PAYMENT_MAX_USD);
  if (!Number.isFinite(maxAmountUsd) || maxAmountUsd <= 0) {
    throw new Error("MAX_PAYMENT_USD must be a positive number");
  }

  if (!env.EVM_PRIVATE_KEY) {
    throw new Error(
      "EVM_PRIVATE_KEY required in .env — the BUYER's wallet. Never paste it anywhere else.",
    );
  }

  const networks = env.VERIFY402_NETWORKS === undefined ? DEMO_NETWORK : env.VERIFY402_NETWORKS;
  const payTo = env.VERIFY402_PAY_TO === undefined ? DEFAULT_PAY_TO : env.VERIFY402_PAY_TO;
  const policy = createPaymentPolicy({
    networks,
    payTo,
    resourcePrefix: env.VERIFY402_RESOURCE_PREFIX || serverUrl,
    paidRoutes: [FIRST_PAYMENT_ROUTE],
  });

  return {
    serverUrl,
    maxAmountUsd,
    privateKey: env.EVM_PRIVATE_KEY,
    policy,
    expectedResource: `${serverUrl}${FIRST_PAYMENT_ROUTE}`,
  };
}

/**
 * Build the pre-signature guard for this payer. It delegates to the shared
 * createPaymentGuard() so the standalone payer, the installed MCP bridge, and
 * smoke preflight all enforce exactly the same rules.
 */
export function createPayerGuard(config) {
  return createPaymentGuard(config.policy, {
    expectedResource: config.expectedResource,
    maxAmountUsd: config.maxAmountUsd,
  });
}

/** Build the x402 client. Only allowlisted networks are ever registered. */
export function createPayerClient(config, { onSelected } = {}) {
  const account = privateKeyToAccount(config.privateKey);
  const client = x402Client.fromConfig({
    schemes: [],
    spendControls: { maxAmountPerPayment: `$${config.maxAmountUsd}` },
    policies: [(version, requirements) => config.policy.filter(version, requirements)],
  });
  for (const network of config.policy.allowedNetworks) {
    client.register(network, createExactEvmScheme(account));
  }
  client.onBeforePaymentCreation(createPayerGuard(config));
  if (typeof onSelected === "function") {
    client.onBeforePaymentCreation((context) => {
      onSelected(context?.selectedRequirements ?? null);
      return undefined;
    });
  }
  return client;
}

/**
 * Verify a decoded x402 settlement receipt.
 *
 * The supported receipt (SettleResponse from the x402 facilitator) proves, at
 * minimum, that settlement succeeded, the settling network, and the settlement
 * transaction hash. It only sometimes includes `payer` and `amount`; when it does, they are
 * checked against the expected payer and the selected requirement's amount. It
 * does not itself carry an asset or payee field, so those are proven by the
 * signed authorization the guard validated, not by this object.
 */
export function validateSettlementReceipt(receipt, {
  expectedNetwork,
  expectedPayer,
  expectedAmountAtomic,
} = {}) {
  const fail = (reason) => ({ ok: false, reason });

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return fail("no settlement receipt");
  }
  if (receipt.success !== true) {
    return fail(
      `settlement did not succeed${receipt.errorReason ? `: ${receipt.errorReason}` : ""}`,
    );
  }
  if (typeof receipt.transaction !== "string" || !EVM_TX_HASH_RE.test(receipt.transaction)) {
    return fail("settlement receipt has no valid transaction hash");
  }
  if (typeof receipt.network !== "string" || !receipt.network.trim()) {
    return fail("settlement receipt has no network");
  }
  if (expectedNetwork !== undefined && receipt.network !== expectedNetwork) {
    return fail(`settlement network ${receipt.network} is not the expected ${expectedNetwork}`);
  }

  if (receipt.payer !== undefined) {
    if (typeof receipt.payer !== "string" || !EVM_ADDRESS_RE.test(receipt.payer)) {
      return fail("settlement receipt payer is malformed");
    }
    if (expectedPayer !== undefined && receipt.payer.toLowerCase() !== expectedPayer.toLowerCase()) {
      return fail(`settlement payer ${receipt.payer} is not the paying wallet`);
    }
  }

  if (receipt.amount !== undefined) {
    if (typeof receipt.amount !== "string" || !/^\d+$/.test(receipt.amount)) {
      return fail("settlement receipt amount is malformed");
    }
    if (expectedAmountAtomic !== undefined && BigInt(receipt.amount) !== BigInt(expectedAmountAtomic)) {
      return fail(`settlement amount ${receipt.amount} is not the expected ${expectedAmountAtomic}`);
    }
  }

  return {
    ok: true,
    proves: {
      network: receipt.network,
      transaction: receipt.transaction,
      payer: receipt.payer === undefined ? "not-reported" : "checked",
      amount: receipt.amount === undefined ? "not-reported" : "checked",
    },
  };
}

/**
 * Require genuine settlement evidence from the paid response.
 *
 * A 2xx status alone is not proof that money moved: the facilitator may have
 * refused the settlement. The only accepted proof is a decodable
 * PAYMENT-RESPONSE header whose receipt reports a successful settlement on
 * the expected network, with a transaction hash (and, when the receipt carries
 * them, a matching payer and amount).
 *
 * Returns `{ ok: true, receipt, verdict }` or `{ ok: false, reason }`. The
 * caller must fail with a non-zero exit when `ok` is false.
 */
export function verifySettlementEvidence({ rawHeader, decodeReceipt, expected = {} } = {}) {
  if (!rawHeader) {
    return { ok: false, reason: "the paid response carried no PAYMENT-RESPONSE header" };
  }
  let receipt = null;
  try {
    receipt = decodeReceipt(String(rawHeader));
  } catch (error) {
    return {
      ok: false,
      reason: `the PAYMENT-RESPONSE header did not decode (${error?.message ?? error})`,
    };
  }
  const verdict = validateSettlementReceipt(receipt, expected);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }
  return { ok: true, receipt, verdict };
}

export async function main() {
  // Load .env only when this file is executed as a script. Importing it from a
  // test must not read the operator's .env file.
  await import("dotenv/config");

  const config = resolvePayerConfig(process.env);
  const account = privateKeyToAccount(config.privateKey);
  let selectedRequirement = null;
  const client = createPayerClient(config, {
    onSelected: (requirement) => {
      selectedRequirement = requirement;
    },
  });
  const paid = wrapAxiosWithPayment(
    axios.create({ timeout: 180_000, maxRedirects: 0, headers: CLIENT_HEADERS }),
    client,
  );

  console.log(
    `asking ${config.serverUrl}${FIRST_PAYMENT_ROUTE} — ` +
      `"what would the chain pay for $1 of USDC→WETH?"\n`,
  );
  console.log(
    `paid policy: networks=${config.policy.allowedNetworks.join(",")} ` +
      `payee=${config.policy.allowedPayTo} cap=$${config.maxAmountUsd}\n`,
  );

  const res = await paid.post(`${config.serverUrl}${FIRST_PAYMENT_ROUTE}`, {
    chainId: 1,
    tokenIn: "USDC",
    tokenOut: "WETH",
    amountIn: "1000000",
  });

  const body = res.data ?? {};
  console.log("status:", res.status);
  console.log("best route:", body.best?.venue ?? JSON.stringify(body).slice(0, 160));

  const rawHeader = res.headers?.["payment-response"] ?? res.headers?.["x-payment-response"];
  const evidence = verifySettlementEvidence({
    rawHeader,
    decodeReceipt: decodePaymentResponseHeader,
    expected: {
      expectedNetwork: selectedRequirement?.network ?? config.policy.allowedNetworks[0],
      expectedPayer: account.address,
      expectedAmountAtomic: selectedRequirement?.amount,
    },
  });

  if (!evidence.ok) {
    console.error(`\npayment settlement was not verified: ${evidence.reason}`);
    process.exit(1);
  }

  const receipt = evidence.receipt;
  const verdict = evidence.verdict;

  console.log("\n=== SETTLEMENT RECEIPT (verified) ===");
  console.log(JSON.stringify(receipt, null, 2));
  if (verdict.proves.amount === "not-reported") {
    console.log("note: this receipt does not report an amount; the signed authorization caps the amount.");
  }
  if (verdict.proves.payer === "not-reported") {
    console.log("note: this receipt does not report a payer address.");
  }
  console.log(
    `${SETTLEMENT_OK_MARKER} network=${receipt.network} transaction=${receipt.transaction}`,
  );
  console.log("\nNow verify on the explorer: the buyer wallet is debited and the seller wallet is credited by the settled amount.");
  process.exit(0);
}

// True only when this file is the process entry point. The smoke test spawns
// this script directly; importing it from a test must not run the payer.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
