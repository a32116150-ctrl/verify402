// OpenAPI 3.1 contract for verify402.
// Built from the canonical price strings the x402 middleware uses so metadata
// and runtime challenges never drift apart.
//
// Complies with official OpenAPI 3.1 specification (https://spec.openapis.org/oas/v3.1.0.html).

const OUTPUT_SCHEMA = {
  type: "object",
  required: ["ok", "checked", "notChecked", "evidence_bundle"],
  properties: {
    ok: { type: "boolean", description: "True if measurement succeeded on-chain." },
    verdict: { type: "string", description: "Core verdict, e.g. 'no_edge', 'TRUST', 'CAUTION', 'AVOID', 'fair'." },
    quote_status: { type: "string", enum: ["ok", "partial", "no_pool", "failed"], description: "Typed quote outcome. 'failed' is returned with HTTP 503; transport/decode failures never become a market verdict." },
    unavailable_reason: { type: "string", nullable: true, description: "Why part/all of the book was unavailable: no_pool, revert, some_venues_no_pool, transport, decode." },
    chainId: { type: "integer", description: "EVM chain ID where block was pinned." },
    chainName: { type: "string", description: "Canonical chain name (e.g. 'ethereum', 'base')." },
    blockNumber: { type: "integer", description: "Pinned block number at which all pool states and prices were sampled." },
    checked: { type: "array", items: { type: "string" }, minItems: 1, description: "What this response actually measured." },
    notChecked: { type: "array", items: { type: "string" }, minItems: 1, description: "What this response deliberately did not measure. Read this before acting." },
    evidence_bundle: {
      type: "object",
      required: ["requestHash", "responseHash", "pinnedBlock"],
      properties: {
        requestHash: { type: "string", description: "SHA-256 of canonical sorted JSON { route, body }." },
        responseHash: { type: "string", description: "SHA-256 of canonical sorted JSON { route, payload }." },
        pinnedBlock: { type: "integer", description: "Pinned block number for deterministic reproduction." },
        timestamp: { type: "string", format: "date-time", description: "ISO UTC timestamp of measurement." },
      },
      additionalProperties: true,
    },
    recovery: {
      type: "object",
      description: "Present when a request re-measured after an earlier settlement expired.",
      properties: {
        remeasured: { type: "boolean" },
        previousResponseHash: { type: "string" },
        expiredAt: { type: "string" },
        note: { type: "string" },
      },
      additionalProperties: true,
    },
    elapsedMs: { type: "number", description: "Total server processing time in milliseconds." },
  },
  additionalProperties: true,
};

const ERROR_SCHEMA = {
  type: "object",
  required: ["error", "message", "requestId"],
  properties: {
    error: { type: "string", description: "Stable public code: bad_request, missing_chain, invalid_chain, unsupported_chain, rate_limited, busy, rpc_unavailable, rpc_rate_limited, internal_error." },
    code: { type: "string", description: "Machine-readable sub-code (for example invalid_size)." },
    message: { type: "string", description: "Public-safe message. Never contains a provider error, RPC URL, or API key." },
    requestId: { type: "string", description: "Correlates this response with the server-side log line. Also returned as x-request-id." },
    checked: { type: "array", items: { type: "string" }, minItems: 1 },
    notChecked: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  additionalProperties: true,
};

const PAYMENT_REQUIRED_SCHEMA = {
  type: "object",
  required: ["accepts"],
  properties: {
    x402Version: { type: "integer", example: 2 },
    error: { type: "string", example: "Payment Required" },
    accepts: {
      type: "array",
      items: {
        type: "object",
        required: ["scheme", "network", "asset", "amount", "payTo"],
        properties: {
          scheme: { type: "string", example: "exact" },
          price: { type: "string", example: "$0.05" },
          network: { type: "string", example: "eip155:8453" },
          asset: { type: "string", description: "Token contract address or mint (USDC canonical)." },
          amount: { type: "string", description: "Amount in atomic token units (e.g. 50000 = 0.05 USDC, 6 decimals)." },
          payTo: { type: "string", description: "Recipient address for the payment." },
          maxTimeoutSeconds: { type: "integer", example: 60 },
        },
      },
    },
    extensions: {
      type: "object",
      description: "x402 Bazaar discovery metadata declaring input schema and example responses.",
      additionalProperties: true,
    },
  },
};

const IDEMPOTENCY_HEADER = {
  name: "x-idempotency-key",
  in: "header",
  required: false,
  description:
    "Optional secret idempotency key. A settled verdict is cached under this key and can be replayed up to 3 times within 600s at zero charge. This key is the ONLY replay credential: no payer identity is read from x-payment or payment-signature. Changing the request body with the same key returns 409 Conflict.",
  schema: { type: "string" },
};

const PAYMENT_PROOF_HEADER = {
  name: "x-payment",
  in: "header",
  required: false,
  description:
    "Base64-encoded x402 payment authorization proof submitted on retry after receiving a 402 challenge. Can alternatively be passed via payment-signature.",
  schema: { type: "string" },
};

function paidOperation({ price, operationId, summary, tag, inputSchema, outputSchema = OUTPUT_SCHEMA, guidance, exampleRequest }) {
  return {
    tags: [tag],
    operationId,
    summary,
    description: [
      guidance || "",
      "\n**Payment flow (x402 exact):**",
      "1. Make POST request without payment.",
      "2. Receive 402 Payment Required with challenge parameters (`accepts` array).",
      "3. Client signs payment authorization for USDC on Base (`eip155:8453`) or Solana.",
      "4. Retry original request with proof in `x-payment` or `payment-signature` header.",
      "5. Receive 200 OK with reproducible `evidence_bundle`.",
      "\n**Idempotency & Replay:** Supply `x-idempotency-key` on the first call. A settled verdict can be replayed up to 3 times within 600s at zero charge. The key is the only replay credential; no payer identity is derived from an unverified payment header.",
      "\n**Safety boundary:** Truth checks measure chain state at one pinned block. They do not predict future blocks, guarantee arbitrage execution, or endorse tokens as risk-free.",
    ].join("\n"),
    security: [],
    "x-payment-info": {
      price: { mode: "fixed", currency: "USD", amount: price },
      protocols: [{ x402: {} }],
    },
    parameters: [IDEMPOTENCY_HEADER, PAYMENT_PROOF_HEADER],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: inputSchema,
          ...(exampleRequest ? { example: exampleRequest } : {}),
        },
      },
    },
    responses: {
      200: {
        description: "Successful verdict with reproducible evidence and canonical hashes.",
        content: { "application/json": { schema: outputSchema } },
      },
      400: {
        description: "Bad Request: Malformed payload, missing/invalid/unsupported chainId (400 missing_chain), or non-existent token address. The response includes requestId and both checked/notChecked.",
        content: { "application/json": { schema: ERROR_SCHEMA } },
      },
      402: {
        description: "Payment Required: x402 payment challenge with network, asset, atomic amount, and recipient.",
        headers: {
          "WWW-Authenticate": {
            description: "x402 challenge header",
            schema: { type: "string", example: "x402" },
          },
        },
        content: { "application/json": { schema: PAYMENT_REQUIRED_SCHEMA } },
      },
      409: {
        description: "Conflict: Reused idempotency key with conflicting request parameters or concurrent in-flight operation.",
        content: { "application/json": { schema: ERROR_SCHEMA } },
      },
      429: {
        description: "Too Many Requests: Rate limit exceeded.",
        content: { "application/json": { schema: ERROR_SCHEMA } },
      },
      503: {
        description: "Service Unavailable: transport/decode failure, RPC rate limit, or facilitator unavailability. No verdict is issued. The x402 middleware cancels settlement for any response >=400, so a 503 is not charged. The body never contains the provider message, RPC URL, or API key.",
        content: { "application/json": { schema: ERROR_SCHEMA } },
      },
    },
  };
}

const chainId = {
  type: "integer",
  description: "Required EVM chain id: 1 Ethereum mainnet, 42161 Arbitrum One, 8453 Base mainnet, 84532 Base Sepolia (testnet mode). There is no silent default; missing => 400 missing_chain.",
};

export function buildOpenapi(prices) {
  const usd = (p) => String(p).replace(/^\$/, "");

  return {
    openapi: "3.1.0",
    info: {
      title: "verify402",
      version: "1.0.3",
      description:
        "Machine-payable truth service for AI agents: free pre-signing preflight safety gate plus paid, evidence-backed on-chain truth checks paid per call via x402 in USDC on Base or Solana.",
      "x-guidance":
        "Call POST /preflight for free before signing any payment request or raw transaction. It answers PASS/CAUTION/BLOCK with typed reasons, checked/notChecked lists, and a 90-second HMAC receipt. For market truth questions, use the paid POST routes (/verify, /safety, /route, /quotecheck, /depth). Paid routes use x402 exact settlement (0.03-0.10 USDC) and return an evidence_bundle with pinnedBlock, requestHash, and responseHash for cryptographic auditability. The 402 challenge is authoritative for prices.",
      contact: {
        name: "verify402 Maintainers",
        url: "https://github.com/a32116150-ctrl/verify402",
        email: "a32116150@gmail.com",
      },
      license: {
        name: "Apache-2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0.html",
      },
    },
    servers: [
      {
        url: "https://verify402.onrender.com",
        description: "Production server (Base mainnet / Solana mainnet)",
      },
    ],
    tags: [
      { name: "Gate", description: "Free pre-signing heuristic and simulation checks." },
      { name: "Truth", description: "Paid on-chain truth checks settled over x402." },
      { name: "Discovery", description: "Machine-readable service manifests, indexes, and health checks." },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["Discovery"],
          operationId: "getHealth",
          summary: "Liveness and network configuration check",
          description: "Returns server operational health, active mode (mainnet/testnet), and supported settlement networks. Free, no authentication.",
          responses: {
            200: {
              description: "Service is healthy and reachable.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["status", "mode", "networks"],
                    properties: {
                      status: { type: "string", example: "ok" },
                      mode: { type: "string", enum: ["mainnet", "testnet"], example: "mainnet" },
                      networks: { type: "string", example: "Base mainnet / Solana mainnet" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/info": {
        get: {
          tags: ["Discovery"],
          operationId: "getInfo",
          summary: "Service capabilities, pricing, and chain IDs",
          description: "Returns summary of available endpoints, current prices, and supported chain IDs as machine-readable JSON. Free.",
          responses: {
            200: {
              description: "Service information.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string", example: "verify402" },
                      endpoints: { type: "object", additionalProperties: true },
                      chains: { type: "array", items: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/usage": {
        get: {
          tags: ["Discovery"],
          operationId: "getUsage",
          summary: "Anonymous free-gate call counts",
          description: "Process-local counts of free preflight calls by client, kind, verdict, and status. No IP addresses, request bodies, intents, or wallets are stored. A call is not a unique agent; paid settlements are the identity-backed usage signal. Resets on restart or deploy.",
          responses: {
            200: {
              description: "Free-gate call counts since this process started.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      spec: { type: "string", example: "verify402/usage@1" },
                      scope: { type: "string" },
                      since: { type: "string", format: "date-time", nullable: true },
                      lastAt: { type: "string", format: "date-time", nullable: true },
                      total: { type: "integer", minimum: 0 },
                      byVerdict: { type: "object", additionalProperties: { type: "integer" } },
                      byKind: { type: "object", additionalProperties: { type: "integer" } },
                      byClient: { type: "object", additionalProperties: { type: "integer" } },
                      byStatus: { type: "object", additionalProperties: { type: "integer" } },
                      note: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/findings": {
        get: {
          tags: ["Discovery"],
          operationId: "getFindings",
          summary: "Recent verifiable market observations",
          description: "Returns recent published verdicts and evidence collected by the engine. Free.",
          responses: {
            200: {
              description: "Recent market observations.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      count: { type: "integer" },
                      findings: { type: "array", items: { type: "object", additionalProperties: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/.well-known/verify402.json": {
        get: {
          tags: ["Discovery"],
          operationId: "getServiceManifest",
          summary: "Canonical machine-readable service manifest",
          description: "Versioned service manifest describing Verify402 tools, MCP packages, pricing, networks, rate limits, and security boundaries.",
          responses: {
            200: {
              description: "Service manifest.",
              content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
            },
          },
        },
      },
      "/.well-known/x402": {
        get: {
          tags: ["Discovery"],
          operationId: "getX402Manifest",
          summary: "x402 capability discovery manifest",
          description: "x402 resource server manifest per draft-hawkins-x402-dns-discovery-02.",
          responses: {
            200: {
              description: "x402 capability manifest.",
              content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
            },
          },
        },
      },
      "/llms.txt": {
        get: {
          tags: ["Discovery"],
          operationId: "getLlmsTxt",
          summary: "Plain-text contract for LLMs and agent crawlers",
          description: "Structured plain-text summary of Verify402 tools, pricing, endpoints, and honest boundaries per llmstxt.org.",
          responses: {
            200: {
              description: "Plain text documentation.",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/sitemap.xml": {
        get: {
          tags: ["Discovery"],
          operationId: "getSitemap",
          summary: "XML sitemap of public pages",
          description: "Standard XML sitemap index of all public web documentation pages for search crawlers.",
          responses: {
            200: {
              description: "XML sitemap.",
              content: { "application/xml": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/preflight": {
        post: {
          tags: ["Gate"],
          operationId: "preflightGate",
          summary: "Free PASS / CAUTION / BLOCK before signing a payment or transaction",
          security: [],
          description: [
            "Accepts an x402 payment challenge (kind=payment) or raw transaction calldata (kind=transaction).",
            "Evaluates structural validity, recipient allowlists, spend caps, approval limits, revert simulation, and block freshness.",
            "Returns PASS / CAUTION / BLOCK with typed reasons, checked/notChecked lists, pinned block number, and an HMAC receipt (valid for 90s).",
            "\n**Security disclaimer:** A PASS indicates that the specific checks in `checked` passed. It is not an audit, does not screen sanctions, does not audit the counterparty, does not scan tool descriptions or responses for prompt injection, and does not guarantee the intent is safe. Always inspect `notChecked`.",
            "\n**Rate limits:** 60 requests/minute per IP, max concurrency of 5.",
          ].join("\n"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["kind"],
                  properties: {
                    kind: { type: "string", enum: ["payment", "transaction"], description: "Whether evaluating an x402 payment challenge or a raw chain transaction." },
                    payment: {
                      type: "object",
                      description: "Payment challenge object (required when kind=payment).",
                      properties: {
                        scheme: { type: "string", example: "exact" },
                        network: { type: "string", example: "eip155:8453", description: "CAIP-2 network string." },
                        asset: { type: "string", description: "Asset contract address or mint." },
                        amount: { type: "string", description: "Atomic units (e.g. 10000 = 0.01 USDC, 6 decimals)." },
                        payTo: { type: "string", description: "Recipient address." },
                        resource: { type: "string", description: "Resource URL being paid for." },
                        maxTimeoutSeconds: { type: "integer", default: 60 },
                      },
                      required: ["network", "asset", "amount", "payTo"],
                      additionalProperties: true,
                    },
                    chainId,
                    to: { type: "string", description: "Target contract address (required when kind=transaction)." },
                    data: { type: "string", description: "0x-prefixed calldata (required when kind=transaction)." },
                    value: { type: "string", default: "0", description: "Native value in wei as decimal string." },
                    from: { type: "string", description: "Signer address. Recommended: enables balance delta and simulation checks." },
                    policy: {
                      type: "object",
                      description: "Caller-defined policy constraints enforced during preflight.",
                      properties: {
                        maxAmountUsd: { type: "number", description: "Maximum allowed payment amount in USD." },
                        forbidUnlimitedApproval: { type: "boolean", description: "If true, approve(..., 2^256-1) yields BLOCK instead of CAUTION." },
                        allowedNetworks: { type: "array", items: { type: "string" } },
                        allowedPayTo: { type: "array", items: { type: "string" } },
                        allowedTo: { type: "array", items: { type: "string" } },
                      },
                      additionalProperties: true,
                    },
                    ttlSeconds: { type: "integer", default: 90, minimum: 15, maximum: 300, description: "Receipt lifetime in seconds." },
                  },
                  additionalProperties: true,
                },
                example: {
                  kind: "payment",
                  payment: {
                    scheme: "exact",
                    network: "eip155:8453",
                    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                    amount: "10000",
                    payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
                    resource: "https://verify402.onrender.com/verify",
                  },
                  policy: { maxAmountUsd: 0.25 },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Preflight evaluation result.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["verdict", "sign_allowed", "requires_ack", "checked", "notChecked"],
                    properties: {
                      verdict: { type: "string", enum: ["PASS", "CAUTION", "BLOCK"], description: "Overall recommendation." },
                      sign_allowed: { type: "boolean", description: "False if verdict is BLOCK; true if PASS or CAUTION." },
                      requires_ack: { type: "boolean", description: "True if verdict is CAUTION; human/operator confirmation recommended." },
                      structural_only: { type: "boolean", description: "Payment intents only: true when no payer `from` or no proof was supplied, or the rail is testnet/Solana. A PASS then means the request shape was validated, not that funds or settlement were checked." },
                      structural_only_reasons: { type: "array", items: { type: "string" }, description: "Why the payment preflight is structural-only." },
                      reasons: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["code", "severity", "message"],
                          properties: {
                            code: { type: "string" },
                            severity: { type: "string", enum: ["caution", "block"] },
                            message: { type: "string" },
                          },
                        },
                      },
                      checked: { type: "array", items: { type: "string" }, description: "Specific checks that were executed." },
                      notChecked: { type: "array", items: { type: "string" }, description: "Limitations and checks that were skipped." },
                      block: {
                        type: "object",
                        properties: {
                          number: { type: "integer" },
                          ageSeconds: { type: "number" },
                        },
                      },
                      receipt: {
                        type: "object",
                        description: "Short-lived HMAC receipt bound to intent and block.",
                        properties: {
                          id: { type: "string" },
                          expiresAt: { type: "string" },
                          signature: { type: "string" },
                        },
                      },
                    },
                    additionalProperties: true,
                  },
                },
              },
            },
            400: {
              description: "Invalid intent format or malformed policy. Transaction intents require an integer chainId: 400 missing_chain / invalid_chain / unsupported_chain.",
              content: { "application/json": { schema: ERROR_SCHEMA } },
            },
            429: {
              description: "Preflight rate limit exceeded (60 req/min).",
              content: { "application/json": { schema: ERROR_SCHEMA } },
            },
            503: {
              description: "EVM RPC provider failure. Gate fails closed without issuing a receipt.",
              content: { "application/json": { schema: ERROR_SCHEMA } },
            },
          },
        },
      },
      "/preflight/verify": {
        post: {
          tags: ["Gate"],
          operationId: "preflightVerify",
          summary: "Verify authenticity and validity of a preflight receipt",
          security: [],
          description: "Recomputes HMAC signature and checks expiration. Call this in an execution module before submitting a signed transaction.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["receipt"],
                  properties: {
                    receipt: {
                      type: "object",
                      description: "Receipt object returned by POST /preflight.",
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Receipt verification verdict.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["valid"],
                    properties: {
                      valid: { type: "boolean", description: "True if signature matches and receipt has not expired." },
                      reason: { type: ["string", "null"], description: "Failure code if invalid (e.g. 'expired', 'bad_signature')." },
                      verdict: { type: "string" },
                      expiresAt: { type: "string" },
                    },
                  },
                },
              },
            },
            400: {
              description: "Missing or malformed receipt payload.",
              content: { "application/json": { schema: ERROR_SCHEMA } },
            },
          },
        },
      },
      "/verify": {
        post: paidOperation({
          price: usd(prices.verify),
          operationId: "verifyArbitrage",
          summary: "Is this cross-venue arbitrage real right now?",
          tag: "Truth",
          guidance:
            "Measures a round trip across configured venues at one pinned block using Uniswap QuoterV2 and venue routers, nets gas and flash loan fees, and returns a verdict. transport/decode failures return HTTP 503 with no verdict and no settlement; only no_pool/revert may make a leg unavailable. The honest answer is usually 'no_edge'.",
          inputSchema: {
            type: "object",
            required: ["chainId", "target"],
            properties: {
              chainId,
              base: { type: "string", default: "USDC", description: "Base currency token symbol or address." },
              target: { type: "string", minLength: 1, description: "Target token symbol or 0x address (e.g. WETH)." },
              size: { type: "number", exclusiveMinimum: 0, default: 1000, description: "Trade size in base token units." },
              minNet: { type: "number", default: 0, description: "Minimum net profit in base token units to declare an edge." },
            },
            additionalProperties: true,
          },
          exampleRequest: { chainId: 1, target: "WETH", base: "USDC", size: 10000 },
        }),
      },
      "/safety": {
        post: paidOperation({
          price: usd(prices.safety),
          operationId: "checkTokenSafety",
          summary: "Pre-trade token gate: TRUST / CAUTION / AVOID (quote-based sellability)",
          tag: "Truth",
          guidance:
            "Gathers live contract facts, liquidity and scam indicators, and performs a quote-based sellability check: a USD-sized sell is quoted through the configured venues' own routers, direct and WETH-routed. It does NOT execute or simulate a transfer, so transfer tax, blacklist, pause, and max-tx restrictions are listed in notChecked, not tested. Unconfigured venues are also named in notChecked.",
          inputSchema: {
            type: "object",
            required: ["chainId", "tokenAddress"],
            properties: {
              chainId,
              tokenAddress: { type: "string", minLength: 1, description: "ERC-20 token address or known symbol." },
              intendedUsd: { type: "number", exclusiveMinimum: 0, default: 500, description: "Size of intended purchase in USD." },
              offeredPriceUsd: { type: ["number", "null"], description: "Optional offered price to check for phantom price anomalies." },
              baseSymbol: { type: "string", default: "USDC" },
            },
            additionalProperties: true,
          },
          exampleRequest: { chainId: 1, tokenAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", intendedUsd: 500 },
        }),
      },
      "/route": {
        post: paidOperation({
          price: usd(prices.route),
          operationId: "getBestRoute",
          summary: "Every configured venue quoting this pair at one pinned block, best first",
          tag: "Truth",
          guidance:
            "Direct and WETH-routed quotes at one pinned block, ranked best to worst. Unbiased evidence of what configured venues would actually pay. Aggregators and unconfigured DEXs are not included; execution is not simulated.",
          inputSchema: {
            type: "object",
            required: ["chainId", "tokenIn", "tokenOut", "amountIn"],
            properties: {
              chainId,
              tokenIn: { type: "string", minLength: 1, description: "Source token symbol or 0x address." },
              tokenOut: { type: "string", minLength: 1, description: "Destination token symbol or 0x address." },
              amountIn: { type: "string", minLength: 1, description: "Atomic amount in raw units of tokenIn (e.g. 1000000 = 1 USDC)." },
            },
            additionalProperties: true,
          },
          exampleRequest: { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000000" },
        }),
      },
      "/quotecheck": {
        post: paidOperation({
          price: usd(prices.quotecheck),
          operationId: "verifyQuoteFairness",
          summary: "Audit someone else's quote: fair / overpaying / too_good_to_be_true",
          tag: "Truth",
          guidance:
            "Compares a third-party quote against the full configured venue book at one pinned block before signing. A transport/decode failure returns HTTP 503, never 'unknown'.",
          inputSchema: {
            type: "object",
            required: ["chainId", "tokenIn", "tokenOut", "amountIn", "quotedOut"],
            properties: {
              chainId,
              tokenIn: { type: "string", minLength: 1, description: "Source token symbol or address." },
              tokenOut: { type: "string", minLength: 1, description: "Destination token symbol or address." },
              amountIn: { type: "string", minLength: 1, description: "Atomic units of tokenIn." },
              quotedOut: { type: "string", minLength: 1, description: "Quoted output amount in atomic units of tokenOut." },
              venueClaimed: { type: ["string", "null"] },
            },
            additionalProperties: true,
          },
          exampleRequest: { chainId: 1, tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000000", quotedOut: "326000000000000000" },
        }),
      },
      "/depth": {
        post: paidOperation({
          price: usd(prices.depth),
          operationId: "getTradeDepth",
          summary: "Largest size that still clears your cost tolerance",
          tag: "Truth",
          guidance:
            "Position sizing: quotes entry and exit at multiple USD sizes, reporting impact %, round-trip cost %, and max fillable capacityUsd. transport/decode failures return HTTP 503 with no depth verdict.",
          inputSchema: {
            type: "object",
            required: ["chainId", "tokenAddress"],
            properties: {
              chainId,
              tokenAddress: { type: "string", minLength: 1, description: "ERC-20 token address or known symbol." },
              baseSymbol: { type: "string", default: "USDC" },
              maxRoundTripPct: { type: "number", exclusiveMinimum: 0, maximum: 100, default: 1.0, description: "Maximum acceptable round-trip cost %." },
              sizesUsd: { type: "array", items: { type: "number", exclusiveMinimum: 0 }, description: "Ladder of trade sizes in USD to evaluate." },
            },
            additionalProperties: true,
          },
          exampleRequest: { chainId: 1, tokenAddress: "WETH", baseSymbol: "USDC", sizesUsd: [100, 1000, 10000, 100000] },
        }),
      },
    },
  };
}
