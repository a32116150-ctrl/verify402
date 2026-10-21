// Canonical machine-readable service manifest for verify402.
// Serves /.well-known/verify402.json per Phase 4 requirements.
// Reuses canonical pricing and configuration from server runtime to avoid drift.

import { IDEMPOTENCY_MAX_REPLAYS, IDEMPOTENCY_TTL_MS } from "./recovery.mjs";
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "./preflight.mjs";
import {
  PRICE_DEFAULTS,
  PREFLIGHT_RATE_PER_MIN,
  PREFLIGHT_MAX_IN_FLIGHT,
  HEALTH_OK_KEYS,
  READY_OK_KEYS,
  READY_FAILURE_KEYS,
  SHUTDOWN_TIMEOUT_MS_DEFAULT,
} from "./contract.mjs";

const IDEMPOTENCY_TTL_SECONDS = IDEMPOTENCY_TTL_MS / 1000;

export function buildServiceManifest({
  baseUrl = "https://verify402.onrender.com",
  mode = "mainnet",
  prices = {
    verify: PRICE_DEFAULTS.verify,
    safety: PRICE_DEFAULTS.safety,
    route: PRICE_DEFAULTS.route,
    quotecheck: PRICE_DEFAULTS.quotecheck,
    depth: PRICE_DEFAULTS.depth,
  },
  payTo = {
    evm: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
    svm: "BdcsYodhwWUhLTuL5FJ3m8D4u4wVy8KMw7vAvPVucAbJ",
  },
} = {}) {
  const numPrice = (p) => Number(String(p).replace(/^\$/, ""));
  const atomicUsdc = (p) => String(Math.round(numPrice(p) * 1e6));

  const networks =
    mode === "mainnet"
      ? [
          {
            id: "eip155:8453",
            name: "Base mainnet",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            symbol: "USDC",
            decimals: 6,
            payTo: payTo.evm,
          },
          {
            id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            name: "Solana mainnet",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            symbol: "USDC",
            decimals: 6,
            payTo: payTo.svm,
          },
        ]
      : [
          {
            id: "eip155:84532",
            name: "Base Sepolia",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            symbol: "USDC",
            decimals: 6,
            payTo: payTo.evm,
          },
          {
            id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            name: "Solana devnet",
            asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            symbol: "USDC",
            decimals: 6,
            payTo: payTo.svm,
          },
        ];

  return {
    schemaVersion: "1.0.0",
    name: "verify402",
    title: "verify402 — Machine-Payable Truth Service for AI Agents",
    description:
      "Free fail-closed pre-signing gate plus x402-payable on-chain truth verification: arbitrage reality, token safety, execution book, quote fairness, and trade capacity measured at pinned blocks.",
    version: "1.0.3",
    license: "Apache-2.0",
    canonicalUrl: baseUrl,
    repository: {
      url: "https://github.com/a32116150-ctrl/verify402",
      type: "git",
      subfolder: "mcp-bridge",
    },
    documentation: {
      homepage: `${baseUrl}/`,
      quickstart: `${baseUrl}/start`,
      docs: `${baseUrl}/docs`,
      mcp: `${baseUrl}/mcp`,
      preflight: `${baseUrl}/preflight`,
      proof: `${baseUrl}/proof`,
      live: `${baseUrl}/live`,
      openapi: `${baseUrl}/openapi.json`,
      llmsTxt: `${baseUrl}/llms.txt`,
      sitemap: `${baseUrl}/sitemap.xml`,
      serviceManifest: `${baseUrl}/.well-known/verify402.json`,
      x402Manifest: `${baseUrl}/.well-known/x402`,
      agentCard: `${baseUrl}/.well-known/agent-card.json`,
    },
    integrations: {
      mcp: {
        type: "model-context-protocol",
        transport: "stdio",
        packageIdentifier: "verify402-mcp",
        npmUrl: "https://www.npmjs.com/package/verify402-mcp",
        tarballUrl: "https://github.com/a32116150-ctrl/verify402/releases/download/mcp-v1.0.4/verify402-mcp-1.0.4.tgz",
        registryName: "io.github.a32116150-ctrl/verify402-mcp",
        registryUrl: "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions/1.0.4",
        quickInstallCommand: "npx -y verify402-mcp",
        tools: [
          {
            name: "preflight_gate",
            type: "free",
            description: "Advisory pre-signing check for payments and transactions. Evaluates limits, allowances, recipient and freshness. Returns PASS/CAUTION/BLOCK with HMAC receipt.",
          },
          {
            name: "verify_arbitrage",
            type: "paid",
            priceUsd: numPrice(prices.verify),
            description: "Cross-venue arbitrage check using Uniswap QuoterV2 and venue routers at one pinned block. Most common verdict: no_edge.",
          },
          {
            name: "check_token_safety",
            type: "paid",
            priceUsd: numPrice(prices.safety),
            description: "Pre-trade token gate: TRUST/CAUTION/AVOID with contract facts, liquidity analysis, and a quote-based sellability check. Does not execute a transfer; transfer restrictions are listed in notChecked.",
          },
          {
            name: "get_best_route",
            type: "paid",
            priceUsd: numPrice(prices.route),
            description: "Execution book quoting the pair across every configured venue at one pinned block, best first. Aggregators and unconfigured DEXs are excluded.",
          },
          {
            name: "verify_quote_fairness",
            type: "paid",
            priceUsd: numPrice(prices.quotecheck),
            description: "Audit third-party swap quote against live chain truth: fair / overpaying / too_good_to_be_true.",
          },
          {
            name: "get_trade_depth",
            type: "paid",
            priceUsd: numPrice(prices.depth),
            description: "Position sizing: ladder of trade sizes, measuring impact %, round-trip cost %, and capacityUsd.",
          },
        ],
        environmentVariables: [
          {
            name: "VERIFY402_URL",
            description: "verify402 base URL",
            default: baseUrl,
            isRequired: false,
            isSecret: false,
          },
          {
            name: "EVM_PRIVATE_KEY",
            description: "Private key for a dedicated hot wallet with USDC on Base. Required only for the 5 paid tools; omit for free-only preflight_gate.",
            isRequired: false,
            isSecret: true,
          },
          {
            name: "MAX_PAYMENT_USD",
            description: "Client-side spend cap per single payment (default: 0.25)",
            default: "0.25",
            isRequired: false,
            isSecret: false,
          },
          {
            name: "MAX_DAILY_USD",
            description: "Client-side spend cap per UTC day across restarts",
            isRequired: false,
            isSecret: false,
          },
        ],
      },
      http: {
        type: "rest-json",
        baseUrl,
        openapiUrl: `${baseUrl}/openapi.json`,
      },
    },
    paymentRequirements: {
      scheme: "exact",
      protocol: "x402 v2",
      facilitators: [
        "https://facilitator.payai.network (Base + Solana mainnet, keyless)",
        "Coinbase CDP x402 facilitator (via CDP_API_KEY_ID)",
      ],
      supportedNetworks: networks,
      pricing: {
        verify: { route: "/verify", priceUsd: numPrice(prices.verify), atomicAmountUsdc: atomicUsdc(prices.verify) },
        safety: { route: "/safety", priceUsd: numPrice(prices.safety), atomicAmountUsdc: atomicUsdc(prices.safety) },
        route: { route: "/route", priceUsd: numPrice(prices.route), atomicAmountUsdc: atomicUsdc(prices.route) },
        quotecheck: { route: "/quotecheck", priceUsd: numPrice(prices.quotecheck), atomicAmountUsdc: atomicUsdc(prices.quotecheck) },
        depth: { route: "/depth", priceUsd: numPrice(prices.depth), atomicAmountUsdc: atomicUsdc(prices.depth) },
      },
      settlementHeaders: {
        paymentRequired: "WWW-Authenticate: x402",
        paymentProofHeaders: ["x-payment", "payment-signature"],
      },
    },
    freeEndpoints: [
      { route: "/preflight", method: "POST", summary: "Free pre-signing PASS/CAUTION/BLOCK gate with HMAC receipt" },
      { route: "/preflight/verify", method: "POST", summary: "Validate HMAC receipt authenticity and expiration" },
      { route: "/health", method: "GET", summary: "Liveness and network mode check" },
      { route: "/ready", method: "GET", summary: "Deep readiness: latest block read with a 3s timeout" },
      { route: "/info", method: "GET", summary: "Machine-readable capabilities and pricing" },
      { route: "/findings", method: "GET", summary: "Recent verifiable market observations" },
      { route: "/openapi.json", method: "GET", summary: "OpenAPI 3.1 contract" },
      { route: "/llms.txt", method: "GET", summary: "Plain-text contract for LLMs" },
      { route: "/sitemap.xml", method: "GET", summary: "XML sitemap" },
      { route: "/.well-known/verify402.json", method: "GET", summary: "Canonical service manifest" },
      { route: "/.well-known/x402", method: "GET", summary: "x402 capability discovery manifest" },
      { route: "/.well-known/agent-card.json", method: "GET", summary: "ERC-8004 agent card" },
    ],
    operationalPolicies: {
      rateLimits: {
        preflight: `${PREFLIGHT_RATE_PER_MIN} requests/minute per IP, max concurrency ${PREFLIGHT_MAX_IN_FLIGHT}`,
        paidEndpoints: "Guarded by x402 payment requirements",
      },
      idempotency: {
        header: "x-idempotency-key",
        description: `Replays a settled verdict at zero cost within a ${IDEMPOTENCY_TTL_SECONDS}s window (max ${IDEMPOTENCY_MAX_REPLAYS} replays). The key is the only credential: no payer identity is read from x-payment or payment-signature, and there is no content-hash companion alias. The key is bound to the canonical request body. Use crypto.randomUUID() or at least 32 URL-safe characters with at least 16 distinct characters; weak keys return 400 weak_idempotency_key. The key is a secret: a leaked key allows replay until the TTL/replay cap. Omitting it keeps normal pay-per-call behavior.`,
        conflictStatus: 409,
        weakKeyStatus: 400,
        secret: `Treat the key as a bearer credential. A leaked key allows anyone to replay the settled verdict until the ${IDEMPOTENCY_TTL_SECONDS / 60}-minute window closes or the ${IDEMPOTENCY_MAX_REPLAYS}-replay cap is reached.`,
        doesNotGuarantee: "Recovery is not a durable ledger, does not survive a restart, does not prove payment or refund a failed call, and does not replay after the TTL/cap. If the caller loses the key, recovery is unavailable.",
      },
      endpoints: {
        health: {
          path: "/health",
          method: "GET",
          liveness: true,
          fields: [...HEALTH_OK_KEYS],
        },
        ready: {
          path: "/ready",
          method: "GET",
          deep: true,
          successFields: [...READY_OK_KEYS],
          failureFields: [...READY_FAILURE_KEYS],
        },
      },
      statePersistence: {
        scope: "process-local",
        appliesTo: ["recovery", "/usage"],
        warning: "Recovery records and /usage counters are process-local and live only in this process; they are lost on restart or deploy. A previously settled idempotency key may be charged again, and usage counts reset. State is not shared across instances.",
      },
      requestValidation: {
        chainId: "Required on every paid route and every transaction preflight. Missing => 400 missing_chain; wrong type => 400 invalid_chain; unsupported => 400 unsupported_chain. No silent default.",
        honesty: "Every 200 and typed failure on a paid route includes non-empty checked[] and notChecked[].",
      },
      errors: {
        publicCodes: ["bad_request", "weak_idempotency_key", "missing_chain", "invalid_chain", "unsupported_chain", "rate_limited", "busy", "rpc_unavailable", "rpc_rate_limited", "internal_error"],
        requestId: "Every error response carries requestId and x-request-id; the server log uses the same id.",
        noProviderDetail: "Provider messages, RPC URLs, and API keys are never returned to callers.",
        settlementOnFailure: "x402 settlement is cancelled for any response >=400, so a 503 is not charged.",
      },
      receipts: {
        type: "HMAC-SHA256",
        defaultTtlSeconds: DEFAULT_TTL_SECONDS,
        rangeSeconds: `${MIN_TTL_SECONDS}-${MAX_TTL_SECONDS}`,
      },
      cors: {
        discovery: "GET, HEAD, and OPTIONS on free read-only discovery paths allow Access-Control-Allow-Origin: *.",
        paid: "Paid routes and free writes (/preflight) send no Access-Control-Allow-Origin header. Call them from a server-side client.",
      },
      securityHeaders: {
        xPoweredBy: false,
        xContentTypeOptions: "nosniff",
        referrerPolicy: "strict-origin-when-cross-origin",
        xFrameOptions: "DENY",
        contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      },
      shutdown: {
        signals: ["SIGTERM", "SIGINT"],
        drainTimeoutEnv: "SHUTDOWN_TIMEOUT_MS",
        defaultDrainTimeoutMs: SHUTDOWN_TIMEOUT_MS_DEFAULT,
        forcedExitCode: 1,
      },
    },
    securityBoundaries: {
      failClosed: true,
      signingAuthority: "Client-side only. Verify402 never holds private keys, executes transactions, or initiates token transfers.",
      disclaimers: {
        verdictPass: "PASS indicates only that verified checks passed at the specified pinned block. It is not a counterparty audit or prompt-injection filter. Consult notChecked list.",
        verdictTrust: "TRUST indicates the contract facts, liquidity thresholds, and quote-based sellability check passed. It is not a transfer test or a safety guarantee; see notChecked.",
        noEdge: "Negative arbitrage outcome is the expected truthful result on liquid markets.",
        financialAdvice: "None of the output constitutes financial, trading, or investment advice.",
      },
    },
  };
}
