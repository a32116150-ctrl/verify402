// Minimal x402 v2 payer implemented in this package, on viem.
//
// Why this exists: the published bridge used @x402/axios + @x402/evm. Both
// pull a nested zod 3.x copy that is covered by GHSA-mrhx-c7xc-m3w5 (a
// memory-exhaustion DoS) and there is no patched 3.x. npm ignores `overrides`
// from dependencies, so the audit banner could not be fixed downstream. This
// module keeps the exact wire format (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
// PAYMENT-RESPONSE, x402 v2, scheme "exact", EIP-3009 authorization) with no
// @x402 dependency at all.
//
// The API intentionally mirrors the narrow slice of the SDK the bridge used:
//   x402Client.fromConfig({ policies })
//   client.register(network, scheme)         // one exact scheme per network
//   client.onBeforePaymentCreation(hook)     // fail-closed guard
//   client.createPaymentPayload(challenge)   // select -> guard -> sign
//   wrapAxiosWithPayment(axiosInstance, client)
//
// Selection, policy, and the pre-signature guard stay in payment-policy.mjs,
// so every payer (installed bridge, standalone first-payment script, smoke
// test) makes the same decision. This file only moves bytes on the wire and
// signs the EIP-712 authorization.

import { randomBytes } from "node:crypto";
import { getAddress } from "viem";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeBase64Json(header, label) {
  const raw = String(header ?? "");
  if (!BASE64_RE.test(raw)) throw new Error(`Invalid ${label} header`);
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error(`Invalid ${label} header`);
  }
}

export function encodePaymentRequiredHeader(paymentRequired) {
  return encodeBase64Json(paymentRequired);
}

export function decodePaymentRequiredHeader(header) {
  return decodeBase64Json(header, "payment required");
}

export function encodePaymentSignatureHeader(paymentPayload) {
  return encodeBase64Json(paymentPayload);
}

export function decodePaymentSignatureHeader(header) {
  return decodeBase64Json(header, "payment signature");
}

export function encodePaymentResponseHeader(paymentResponse) {
  const buyerFacing = { ...paymentResponse };
  delete buyerFacing.extensionResponses;
  return encodeBase64Json(buyerFacing);
}

export function decodePaymentResponseHeader(header) {
  return decodeBase64Json(header, "payment response");
}

// EIP-712 struct signed for an EIP-3009 transferWithAuthorization.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function chainIdFromNetwork(network) {
  const match = /^eip155:(\d+)$/.exec(String(network ?? ""));
  if (!match) throw new Error(`Not an eip155 network: ${String(network)}`);
  return Number(match[1]);
}

/**
 * The "exact" EVM scheme for one signer. createPaymentPayload() builds an
 * EIP-3009 authorization capped by the requirement's maxTimeoutSeconds and
 * signs it with the wallet's EIP-712 domain for the challenge's asset.
 *
 * Nothing here decides whether a payment is allowed: by the time this runs,
 * validatePaymentChallenge() and the tool-bound guard have already passed.
 */
export function createExactEvmScheme(account) {
  if (!account?.address || typeof account.signTypedData !== "function") {
    throw new Error("createExactEvmScheme requires a viem account");
  }
  return {
    scheme: "exact",
    // Kept for API parity with the SDK's default-asset hint. Spend enforcement
    // lives in payment-policy.mjs, not here.
    findDefaultAsset: (_asset, network) => {
      const address = /^eip155:84532$/.test(String(network))
        ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
        : /^eip155:8453$/.test(String(network))
          ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          : null;
      return address ? { asset: address, decimals: 6, symbol: "USDC" } : null;
    },

    async createPaymentPayload(x402Version, requirement) {
      const name = requirement?.extra?.name;
      const version = requirement?.extra?.version;
      if (!name || !version) {
        throw new Error(
          `EIP-712 domain parameters (name, version) are required in payment requirements for asset ${requirement?.asset}`,
        );
      }
      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from: account.address,
        to: getAddress(requirement.payTo),
        value: requirement.amount,
        // x402 v2 opens the window immediately; the cap is the deadline.
        validAfter: "0",
        validBefore: String(now + requirement.maxTimeoutSeconds),
        nonce: `0x${randomBytes(32).toString("hex")}`,
      };
      const signature = await account.signTypedData({
        domain: {
          name,
          version,
          chainId: chainIdFromNetwork(requirement.network),
          verifyingContract: getAddress(requirement.asset),
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: getAddress(authorization.from),
          to: getAddress(authorization.to),
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
      });
      return {
        x402Version,
        payload: { authorization, signature },
      };
    },
  };
}

/**
 * x402 v2 client: selects one requirement for the registered network/scheme,
 * runs every registered policy and pre-signature hook, then signs.
 *
 * Selection is deliberately boring: the first requirement that has a
 * registered signer, then the policies narrow it. The guard in
 * payment-policy.mjs re-validates the whole challenge afterwards.
 */
class X402Client {
  constructor({ policies = [] } = {}) {
    this.policies = Array.isArray(policies) ? policies : [];
    this.beforeHooks = [];
    this.schemes = new Map(); // network -> scheme (x402 v2 only)
  }

  static fromConfig(config = {}) {
    return new X402Client(config);
  }

  register(network, scheme, x402Version = 2) {
    if (x402Version !== 2) {
      throw new Error(`register: unsupported x402 version ${x402Version}`);
    }
    this.schemes.set(String(network), scheme);
    return this;
  }

  onBeforePaymentCreation(hook) {
    if (typeof hook !== "function") throw new Error("onBeforePaymentCreation requires a function");
    this.beforeHooks.push(hook);
    return this;
  }

  selectPaymentRequirements(x402Version, requirements) {
    if (x402Version !== 2) {
      throw new Error(`No client registered for x402 version: ${x402Version}`);
    }
    if (!Array.isArray(requirements) || requirements.length === 0) {
      throw new Error("402 challenge has no accepts[]");
    }
    let filtered = requirements.filter((requirement) => {
      const scheme = this.schemes.get(String(requirement?.network));
      return Boolean(scheme) && scheme.scheme === requirement?.scheme;
    });
    if (filtered.length === 0) {
      throw new Error(
        "No network/scheme registered for x402 version: 2 which comply with the payment requirements",
      );
    }
    for (const policy of this.policies) {
      filtered = policy(x402Version, filtered);
      if (!Array.isArray(filtered) || filtered.length === 0) {
        throw new Error("All payment requirements were filtered out by policies for x402 version: 2");
      }
    }
    return filtered[0];
  }

  async createPaymentPayload(paymentRequired) {
    if (paymentRequired?.x402Version !== 2) {
      throw new Error(`No client registered for x402 version: ${paymentRequired?.x402Version}`);
    }
    const accepted = this.selectPaymentRequirements(2, paymentRequired.accepts);
    const context = { paymentRequired, selectedRequirements: accepted };
    for (const hook of this.beforeHooks) {
      const result = await hook(context);
      if (result && "abort" in result && result.abort) {
        throw new Error(`Payment creation aborted: ${result.reason}`);
      }
    }
    const scheme = this.schemes.get(String(accepted.network));
    const partial = await scheme.createPaymentPayload(2, accepted);
    return {
      x402Version: 2,
      payload: partial.payload,
      resource: paymentRequired.resource,
      accepted,
    };
  }
}

export const x402Client = { fromConfig: (config) => X402Client.fromConfig(config) };

function headerReader(headers) {
  return (name) => {
    if (!headers) return undefined;
    if (typeof headers.get === "function") {
      const value = headers.get(name);
      if (typeof value === "string") return value;
    }
    const direct = headers[name] ?? headers[name.toLowerCase()];
    return typeof direct === "string" ? direct : undefined;
  };
}

function readPaymentRequired(response) {
  const getHeader = headerReader(response?.headers);
  const header = getHeader(PAYMENT_REQUIRED_HEADER);
  if (header) return decodePaymentRequiredHeader(header);
  const body = response?.data;
  if (body && typeof body === "object" && body.x402Version === 1) return body;
  throw new Error("Invalid payment required response");
}

function cloneHeaders(headers) {
  const source = typeof headers?.toJSON === "function" ? headers.toJSON() : (headers ?? {});
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || typeof value === "function") continue;
    out[key] = String(value);
  }
  return out;
}

// A 402 on the paid retry is a server answer, not a transport failure: let the
// caller read it (same as the x402 SDK wrapper).
function paidRetryConfig(config) {
  const originalValidateStatus = config.validateStatus;
  return {
    ...config,
    headers: cloneHeaders(config.headers),
    validateStatus: (status) =>
      status === 402
        ? true
        : originalValidateStatus
          ? originalValidateStatus(status)
          : status >= 200 && status < 300,
  };
}

/**
 * Axios wrapper: on a 402, parse PAYMENT-REQUIRED, ask the client for a signed
 * payload (policies + guard run there), and retry once with PAYMENT-SIGNATURE.
 * The payment request is never retried twice, and a retry that is still 402 is
 * returned to the caller instead of looping.
 */
export function wrapAxiosWithPayment(axiosInstance, client) {
  axiosInstance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const response = error?.response;
      if (!response || response.status !== 402) return Promise.reject(error);

      const originalConfig = error.config;
      if (!originalConfig || !originalConfig.headers) {
        return Promise.reject(new Error("Missing axios request configuration"));
      }
      if (originalConfig.__is402Retry) return Promise.reject(error);

      let paymentRequired;
      try {
        paymentRequired = readPaymentRequired(response);
      } catch (parseError) {
        return Promise.reject(
          new Error(
            `Failed to parse payment requirements: ${
              parseError instanceof Error ? parseError.message : "Unknown error"
            }`,
          ),
        );
      }

      let paymentPayload;
      try {
        paymentPayload = await client.createPaymentPayload(paymentRequired);
      } catch (paymentError) {
        return Promise.reject(
          new Error(
            `Failed to create payment payload: ${
              paymentError instanceof Error ? paymentError.message : "Unknown error"
            }`,
          ),
        );
      }

      const paidConfig = paidRetryConfig(originalConfig);
      paidConfig.__is402Retry = true;
      paidConfig.headers[PAYMENT_SIGNATURE_HEADER] = encodePaymentSignatureHeader(paymentPayload);
      paidConfig.headers["Access-Control-Expose-Headers"] = "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE";
      return axiosInstance.request(paidConfig);
    },
  );
  return axiosInstance;
}
