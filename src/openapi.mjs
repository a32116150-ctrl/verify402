// OpenAPI 3.1 contract for verify402, built from the same price strings the
// x402 middleware uses. x402scan and other discovery services read
// /openapi.json; the live 402 challenge is still authoritative for price.
//
// `x-payment-info.price.amount` is decimal USD (0.05), while the runtime
// accepts[].amount is token atomic units (50000 for USDC, 6 decimals).

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    verdict: { type: "string" },
    chainId: { type: "integer" },
    blockNumber: { type: "integer" },
    evidence_bundle: { type: "object", additionalProperties: true },
    cache: { type: "object", additionalProperties: true },
    elapsedMs: { type: "number" },
  },
  additionalProperties: true,
};

function paidOperation({ price, operationId, summary, tag, inputSchema, outputSchema = OUTPUT_SCHEMA, guidance }) {
  return {
    tags: [tag],
    operationId,
    summary,
    ...(guidance ? { description: guidance } : {}),
    // No API key: the x402 payment is the only gate. Declared explicitly so
    // discovery derives auth hint "paid" instead of guessing.
    security: [],
    "x-payment-info": {
      price: { mode: "fixed", currency: "USD", amount: price },
      protocols: [{ x402: {} }],
    },
    requestBody: {
      required: true,
      content: { "application/json": { schema: inputSchema } },
    },
    responses: {
      200: {
        description: "Verdict with reproducible evidence.",
        content: { "application/json": { schema: outputSchema } },
      },
      402: { description: "Payment Required" },
    },
  };
}

const chainId = {
  type: "integer",
  description: "EVM chain id. 1 Ethereum, 42161 Arbitrum, 8453 Base, 84532 Base Sepolia (testnet mode).",
  default: 1,
};

export function buildOpenapi(prices) {
  const usd = (p) => String(p).replace(/^\$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: "verify402",
      version: "1.0.0",
      description:
        "Per-call truth checks for trading agents: a free pre-signing gate plus paid, evidence-backed verdicts measured at one pinned block.",
      "x-guidance":
        "Start with the free POST /preflight before signing any payment or chain transaction; it returns PASS/CAUTION/BLOCK with typed reasons and a 90-second signed receipt. When the question is market truth instead of signing safety, use the paid POST routes: /verify (is this cross-venue arbitrage real), /safety (token gate), /route (execution book), /quotecheck (audit someone else's quote), /depth (size ladder). Every paid call is x402 exact, USDC on Base, and returns an evidence_bundle with requestHash, responseHash and pinnedBlock so the result is reproducible. The most common honest verdict is no_edge; that negative result is the product. The live 402 challenge is authoritative for price and payee.",
      contact: { email: "a32116150@gmail.com" },
    },
    "x-agentcash-guidance": {
      llmsTxtUrl: "https://verify402.onrender.com/llms.txt",
    },
    servers: [{ url: "https://verify402.onrender.com" }],
    tags: [
      { name: "Gate", description: "Free pre-signing checks." },
      { name: "Truth", description: "Paid, evidence-backed trading checks over x402." },
    ],
    paths: {
      "/preflight": {
        post: {
          tags: ["Gate"],
          operationId: "preflightGate",
          summary: "Free PASS / CAUTION / BLOCK before signing a payment or transaction",
          security: [],
          description:
            "Accept a payment request (kind=payment) or a raw chain transaction (kind=transaction). Returns a verdict, typed reasons, checked/notChecked, a pinned block, and a short-lived HMAC receipt.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["payment", "transaction"] },
                    payment: {
                      type: "object",
                      properties: {
                        scheme: { type: "string" },
                        network: { type: "string", example: "eip155:8453" },
                        asset: { type: "string" },
                        amount: { type: "string", description: "Atomic units, e.g. 10000 = 0.01 USDC." },
                        payTo: { type: "string" },
                        resource: { type: "string" },
                        maxTimeoutSeconds: { type: "integer" },
                      },
                      additionalProperties: true,
                    },
                    chainId: chainId,
                    to: { type: "string" },
                    data: { type: "string", description: "0x calldata for kind=transaction." },
                    value: { type: "string" },
                    from: { type: "string", description: "Optional payer address; enables balance-delta simulation." },
                    policy: {
                      type: "object",
                      properties: {
                        maxAmountUsd: { type: "number" },
                        forbidUnlimitedApproval: { type: "boolean" },
                      },
                      additionalProperties: true,
                    },
                  },
                  required: ["kind"],
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            200: {
              description: "Verdict. A PASS is not a guarantee: read notChecked.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      verdict: { type: "string", enum: ["PASS", "CAUTION", "BLOCK"] },
                      sign_allowed: { type: "boolean" },
                      requires_ack: { type: "boolean" },
                      reasons: { type: "array", items: { type: "object", additionalProperties: true } },
                      checked: { type: "array", items: { type: "string" } },
                      notChecked: { type: "array", items: { type: "string" } },
                      block: { type: "object", additionalProperties: true },
                      receipt: { type: "object", additionalProperties: true },
                    },
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
      "/preflight/verify": {
        post: {
          tags: ["Gate"],
          operationId: "preflightVerify",
          summary: "Verify a preflight receipt",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { receipt: { type: "object", additionalProperties: true } },
                  required: ["receipt"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Receipt validity. Tampered or expired receipts return valid=false.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      valid: { type: "boolean" },
                      reason: { type: ["string", "null"] },
                      verdict: { type: "string" },
                      expiresAt: { type: "string" },
                    },
                    additionalProperties: true,
                  },
                },
              },
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
            "Measures a round trip across venues at one pinned block using Uniswap QuoterV2 and each venue's own router, nets flash-loan premium and gas, and returns a verdict with full evidence. Most common honest answer: no_edge.",
          inputSchema: {
            type: "object",
            properties: {
              chainId,
              base: { type: "string", default: "USDC" },
              target: { type: "string", minLength: 1, description: "Target token symbol or address, e.g. WETH." },
              size: { type: "number", exclusiveMinimum: 0, default: 1000, description: "Trade size in base-token units." },
              minNet: { type: "number", default: 0, description: "Minimum net profit in base-token units to call it PROFIT." },
            },
            required: ["target"],
            additionalProperties: true,
          },
        }),
      },
      "/safety": {
        post: paidOperation({
          price: usd(prices.safety),
          operationId: "checkTokenSafety",
          summary: "Pre-trade token gate: TRUST / CAUTION / AVOID",
          tag: "Truth",
          guidance:
            "Live contract facts, market and scam signals, and a USD-sized sell probe against every venue. The honeypot question is answered by quoting the exit.",
          inputSchema: {
            type: "object",
            properties: {
              chainId,
              tokenAddress: { type: "string", minLength: 1, description: "ERC-20 address or known symbol." },
              intendedUsd: { type: "number", exclusiveMinimum: 0, default: 500 },
              offeredPriceUsd: { type: ["number", "null"], description: "Optional price someone offered you." },
              baseSymbol: { type: "string", default: "USDC" },
            },
            required: ["tokenAddress"],
            additionalProperties: true,
          },
        }),
      },
      "/route": {
        post: paidOperation({
          price: usd(prices.route),
          operationId: "getBestRoute",
          summary: "Every venue quoting this pair at one pinned block, best first",
          tag: "Truth",
          guidance:
            "Direct and WETH-routed quotes at one pinned block, best first. Verdict-free evidence of what the chain would actually pay.",
          inputSchema: {
            type: "object",
            properties: {
              chainId,
              tokenIn: { type: "string", minLength: 1, description: "Known symbol or 0x address." },
              tokenOut: { type: "string", minLength: 1, description: "Known symbol or 0x address." },
              amountIn: { type: "string", minLength: 1, description: "Positive integer string in RAW units of tokenIn." },
            },
            required: ["tokenIn", "tokenOut", "amountIn"],
            additionalProperties: true,
          },
        }),
      },
      "/quotecheck": {
        post: paidOperation({
          price: usd(prices.quotecheck),
          operationId: "verifyQuoteFairness",
          summary: "Audit someone else's quote: fair / overpaying / too_good_to_be_true / unknown",
          tag: "Truth",
          guidance:
            "Compare a quote you were offered against the full venue book at one pinned block. Ask before signing a swap whose number you did not produce.",
          inputSchema: {
            type: "object",
            properties: {
              chainId,
              tokenIn: { type: "string", minLength: 1 },
              tokenOut: { type: "string", minLength: 1 },
              amountIn: { type: "string", minLength: 1, description: "RAW units of tokenIn." },
              quotedOut: { type: "string", minLength: 1, description: "The output amount you were quoted, RAW units." },
              venueClaimed: { type: ["string", "null"] },
              chainIn: { type: ["string", "null"] },
            },
            required: ["tokenIn", "tokenOut", "amountIn", "quotedOut"],
            additionalProperties: true,
          },
        }),
      },
      "/depth": {
        post: paidOperation({
          price: usd(prices.depth),
          operationId: "getTradeDepth",
          summary: "Largest size that still clears your cost tolerance",
          tag: "Truth",
          guidance:
            "Per-size entry and exit quotes, impact %, round-trip cost %, and capacityUsd. What a real block gives YOUR size, not the headline pool liquidity.",
          inputSchema: {
            type: "object",
            properties: {
              chainId,
              tokenAddress: { type: "string", minLength: 1, description: "ERC-20 address or known symbol." },
              baseSymbol: { type: "string", default: "USDC" },
              maxRoundTripPct: { type: "number", exclusiveMinimum: 0, maximum: 100, default: 1.0 },
              sizesUsd: { type: "array", items: { type: "number", exclusiveMinimum: 0 } },
            },
            required: ["tokenAddress"],
            additionalProperties: true,
          },
        }),
      },
    },
  };
}
