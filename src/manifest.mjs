// Canonical machine-readable service manifest for verify402.
// Serves /.well-known/verify402.json per Phase 4 requirements.
// Reuses canonical pricing and configuration from server runtime to avoid drift.

import { IDEMPOTENCY_MAX_REPLAYS, IDEMPOTENCY_TTL_MS } from "./recovery.mjs";
import { statePersistence, recoveryDoesNotGuarantee } from "./recovery-persistence.mjs";
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "./preflight.mjs";
import { knownNetworks } from "./tokens.mjs";
import { PUBLISHED_VERSION, RELEASE_STATUS, RELEASE_VERSION } from "./version.mjs";
import {
  DEMO_NETWORK,
  MAINNET_NETWORK,
  TESTNET_USDC,
  MAINNET_USDC,
  TESTNET_SVM,
  MAINNET_SVM,
} from "./payment-mode.mjs";
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
  baseUrl = "https://vex402.online",
  mode = "testnet",
  prices = {
    verify: PRICE_DEFAULTS.verify,
    safety: PRICE_DEFAULTS.safety,
    route: PRICE_DEFAULTS.route,
    quotecheck: PRICE_DEFAULTS.quotecheck,
    depth: PRICE_DEFAULTS.depth,
    assure: PRICE_DEFAULTS.assure,
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
            id: MAINNET_NETWORK,
            name: "Base mainnet",
            asset: MAINNET_USDC,
            symbol: "USDC",
            decimals: 6,
            payTo: payTo.evm,
          },
          {
            id: MAINNET_SVM,
            name: "Solana mainnet",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            symbol: "USDC",
            decimals: 6,
            payTo: payTo.svm,
          },
        ]
      : [
          {
            id: DEMO_NETWORK,
            name: "Base Sepolia",
            asset: TESTNET_USDC,
            symbol: "USDC",
            decimals: 6,
            payTo: payTo.evm,
          },
          {
            id: TESTNET_SVM,
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
      "Token safety check for AI agents before they swap: quote-based sellability, round-trip cost, TRUST / CAUTION / AVOID. $0.02 per call, free pre-signing gate included. Supporting paid checks cover arbitrage reality, execution book, quote fairness and trade capacity at pinned blocks.",
    version: RELEASE_VERSION,
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
        // The published version comes from src/version.mjs; these fields describe
        // the artifact a user can install today. The MCP Registry entry
        // is a separate release step and is not claimed here.
        releaseStatus: RELEASE_STATUS,
        publishedVersion: PUBLISHED_VERSION,
        tarballUrl: `https://registry.npmjs.org/verify402-mcp/-/verify402-mcp-${PUBLISHED_VERSION}.tgz`,
        registryName: "io.github.a32116150-ctrl/verify402-mcp",
        // The version list resolves before and after the manual registry publish;
        // a version-specific URL would 404 until that human step completes.
        registryUrl: "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.a32116150-ctrl%2Fverify402-mcp/versions",
        quickInstallCommand: `npx -y verify402-mcp@${PUBLISHED_VERSION}`,
        tools: [
          {
            name: "preflight_gate",
            type: "free",
            description: "Advisory pre-signing check for payments and transactions. Evaluates limits, allowances, recipient and freshness. Returns PASS/CAUTION/BLOCK with HMAC receipt; transactions also get plain-language advice, fixes, and an optional dollar risk limit (policy.maxRiskUsd).",
          },
          {
            name: "inspect_402",
            type: "free",
            description: "Reads an x402 402 challenge before an agent pays it: price, token, network, payee, bound resource, and a PASS/CAUTION/BLOCK verdict with typed reasons. Read-only fetch; never signs.",
          },
          {
            name: "directory_402",
            type: "free",
            description: "Lists the watched public x402 endpoints with their price, network, payee, protocol verdict, sign verdict, and recorded changes.",
          },
          {
            name: "verify_arbitrage",
            type: "paid",
            priceUsd: numPrice(prices.verify),
            description: "Support check: measures a cross-venue arbitrage round trip at one pinned block using Uniswap QuoterV2 and venue routers. Most common verdict: no_edge.",
          },
          {
            name: "check_token_safety",
            type: "paid",
            priceUsd: numPrice(prices.safety),
            description: "Token safety check for AI agents before they swap: quote-based sellability, round-trip cost, TRUST / CAUTION / AVOID. $0.02 per call, free pre-signing gate included; it does not execute a transfer, so transfer restrictions and unconfigured venues stay in notChecked, not a honeypot proof.",
          },
          {
            name: "get_best_route",
            type: "paid",
            priceUsd: numPrice(prices.route),
            description: "Support check: execution book quoting the pair across configured venues at one pinned block, best first. Aggregators and unconfigured DEXs are excluded.",
          },
          {
            name: "verify_quote_fairness",
            type: "paid",
            priceUsd: numPrice(prices.quotecheck),
            description: "Support check: audits a third-party swap quote against the live venue book: fair / overpaying / too_good_to_be_true.",
          },
          {
            name: "get_trade_depth",
            type: "paid",
            priceUsd: numPrice(prices.depth),
            description: "Support check: ladder of trade sizes measuring impact %, round-trip cost % and capacityUsd.",
          },
          {
            name: "get_assurance",
            type: "paid",
            priceUsd: numPrice(prices.assure ?? PRICE_DEFAULTS.assure),
            description: "Support bundle: runs the supplied paid checks at one pinned block and returns one evidence bundle with a recomputable sha256. Accepted only when the supplied checks cost at least $0.10 separately (parts total $0.12), so the bundle is cheaper than buying them one by one.",
          },
          {
            name: "watch_contract",
            type: "paid",
            priceUsd: numPrice(prices.watch ?? PRICE_DEFAULTS.watch),
            description: "Watch one contract for 30 days: code, proxy implementation, upgrade controller, owner() and paused() re-read about hourly; any change is POSTed to your https webhook as a signed event. Needs MAX_PAYMENT_USD >= 0.50 in the bridge.",
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
            description: mode === "mainnet"
              ? "Private key for a dedicated hot wallet. Required only to call the six paid tools; without it they refuse with a clear error (the free tools still work). This instance is configured for Base mainnet USDC; mainnet operation requires separate readiness verification."
              : `Private key for a dedicated hot wallet. Required only to call the six paid tools; without it they refuse with a clear error (the free tools still work). This local testnet sandbox (${DEMO_NETWORK}) is not a public endpoint — the public testnet demo was retired on 2026-11-19; the only public endpoint is the mainnet service at https://vex402.online (${MAINNET_NETWORK}, real USDC). Fund only what you are willing to spend.`,
            isRequired: false,
            isSecret: true,
          },
          {
            name: "VERIFY402_NETWORKS",
            description: `Comma-separated EVM payment networks the bridge may pay. Default is Base Sepolia testnet (${DEMO_NETWORK}); set ${MAINNET_NETWORK} explicitly for Base mainnet. The supported network-to-canonical-asset map is constrained to Base Sepolia and Base mainnet.`,
            isRequired: false,
            isSecret: false,
            default: DEMO_NETWORK,
            // The published package defaults to Base Sepolia testnet.
            // Base mainnet remains an explicit opt-in, not the demo default.
            publishedPackageDefault: DEMO_NETWORK,
            demoValue: mode === "mainnet" ? MAINNET_NETWORK : DEMO_NETWORK,
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
      mode,
      scheme: "exact",
      protocol: "x402 v2",
      facilitators: mode === "mainnet"
        ? [
            "https://facilitator.payai.network (Base + Solana mainnet, keyless)",
            "Coinbase CDP x402 facilitator (via CDP_API_KEY_ID)",
          ]
        : [
            "Configured testnet facilitator; the live 402 challenge is authoritative",
          ],
      supportedNetworks: networks,
      // The gate recognizes these tokens per network when it reads a 402
      // challenge. Recognizing an address is not the same as trusting it.
      recognizedPaymentAssets: knownNetworks().map((network) => ({
        network: network.id,
        name: network.name,
        tokens: network.tokens,
      })),
      pricing: {
        verify: { route: "/verify", priceUsd: numPrice(prices.verify), atomicAmountUsdc: atomicUsdc(prices.verify) },
        safety: { route: "/safety", priceUsd: numPrice(prices.safety), atomicAmountUsdc: atomicUsdc(prices.safety) },
        route: { route: "/route", priceUsd: numPrice(prices.route), atomicAmountUsdc: atomicUsdc(prices.route) },
        quotecheck: { route: "/quotecheck", priceUsd: numPrice(prices.quotecheck), atomicAmountUsdc: atomicUsdc(prices.quotecheck) },
        depth: { route: "/depth", priceUsd: numPrice(prices.depth), atomicAmountUsdc: atomicUsdc(prices.depth) },
        assure: { route: "/assure", priceUsd: numPrice(prices.assure ?? PRICE_DEFAULTS.assure), atomicAmountUsdc: atomicUsdc(prices.assure ?? PRICE_DEFAULTS.assure) },
        watch: { route: "/watch", priceUsd: numPrice(prices.watch ?? PRICE_DEFAULTS.watch), atomicAmountUsdc: atomicUsdc(prices.watch ?? PRICE_DEFAULTS.watch), coversDays: 30 },
      },
      settlementHeaders: {
        paymentRequired: "WWW-Authenticate: x402",
        paymentProofHeaders: ["x-payment", "payment-signature"],
      },
    },
    freeEndpoints: [
      { route: "/preflight", method: "POST", summary: "Free pre-signing PASS/CAUTION/BLOCK gate with HMAC receipt" },
      { route: "/preflight/verify", method: "POST", summary: "Validate HMAC, expiry, and optional intent/request bindings" },
      { route: "/health", method: "GET", summary: "Liveness and network mode check" },
      { route: "/ready", method: "GET", summary: "Deep readiness: verify eth_chainId, then read the latest block within 3s" },
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
        doesNotGuarantee: recoveryDoesNotGuarantee(),
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
      statePersistence: statePersistence(),
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
        binding: "Signed intentHash and requestHash. requestHash is additive within verify402/preflight-receipt@1; older receipts stay signature-valid but are unbound. Receipt-only verification returns intentBound:false and requestBound:false.",
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
        contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://mcprush.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
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
