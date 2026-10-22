// Payment policy for the paid x402 client.
//
// The bridge is a payer, not a blank cheque for any remote 402. Before a
// signature exists, the policy requires:
//
//   - the network to be explicitly allowlisted (the public demo default is
//     Base Sepolia testnet, eip155:84532);
//   - payTo to be the verify402 payee (default the EVM payTo);
//   - the 402 resource to be on the configured server and a known paid route.
//
// The amount cap and the canonical-USDC allowlist are enforced both by
// x402Client's spendControls and by validatePaymentChallenge(), which runs
// before the signing hook in first-payment.mjs and index.mjs. Redirects are
// refused by the axios clients in index.mjs and first-payment.mjs.
//
// Mainnet is available only through an explicit VERIFY402_NETWORKS value. The
// demo default must never silently select Base mainnet.
//
// Free-only mode never imports or constructs this policy.

export const DEMO_NETWORK = "eip155:84532";
export const MAINNET_NETWORK = "eip155:8453";
export const DEFAULT_NETWORKS = [DEMO_NETWORK];
export const DEFAULT_PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
export const DEFAULT_PAID_ROUTES = ["/verify", "/safety", "/route", "/quotecheck", "/depth"];

// Hard upper bound for a single EIP-3009 authorization. The SDK signs
// `validBefore = now + maxTimeoutSeconds`; an unbounded value hands the payee a
// long-lived transferable authorization. 300 seconds is the documented cap and
// matches the live verify402 challenge.
export const MAX_TIMEOUT_SECONDS = 300;

// The canonical USDC contract for each network this bridge knows how to pay.
// A 402 that names a different asset on one of these networks is a different
// payment, not a cheaper one, so the guard refuses it.
export const DEMO_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const NETWORK_USDC = {
  [DEMO_NETWORK]: DEMO_USDC,
  [MAINNET_NETWORK]: MAINNET_USDC,
};

// EIP-712 domain parameters for the canonical USDC contract on each supported
// network. These are signing-relevant: a server that supplies a different
// `extra.name`/`extra.version` asks the wallet to sign a different token
// domain. Values mirror the installed @x402/evm default-asset table.
export const NETWORK_USDC_DOMAIN = {
  [DEMO_NETWORK]: { name: "USDC", version: "2" },
  [MAINNET_NETWORK]: { name: "USD Coin", version: "2" },
};

// The only networks the bridge will ever register a signer for. VERIFY402_NETWORKS
// is constrained to this map; an arbitrary eip155:<chainId> is refused rather
// than inferred from an asset the SDK happens to recognise.
export const SUPPORTED_PAYMENT_NETWORKS = new Set(Object.keys(NETWORK_USDC));

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CAIP2_RE = /^[a-z0-9][a-z0-9-]*:[A-Za-z0-9._:-]+$/;
const SUPPORTED_NETWORK_NAMESPACES = new Set(["eip155", "solana"]);

// `extra` fields that do not change how a payload is signed. Everything else on
// an EVM requirement is a signing-mode extension and is refused until it is
// explicitly validated here.
const EVM_EXTRA_ALLOWED_KEYS = new Set(["name", "version", "assetTransferMethod", "paymentFlow"]);

/**
 * Convert a USD amount to six-decimal atomic units. Returns null when the
 * value is not a positive finite number, so callers fail closed instead of
 * rounding a bad cap into zero or Infinity.
 */
export function usdToAtomic(value) {
  const parsed = typeof value === "string" ? Number(value.replace(/^\$/, "").trim()) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return BigInt(Math.round(parsed * 1e6));
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

// Exact resource identity: origin + path are compared with no trailing-slash
// normalisation, so `/route/` is not `/route`.
function resourceKey(url) {
  return `${url.origin}${url.pathname}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate `maxTimeoutSeconds` as a positive integer no greater than the
 * documented cap. Strings, floats, NaN, infinities, zero and negatives are all
 * refused before any arithmetic happens.
 */
function validateTimeoutSeconds(value) {
  if (typeof value !== "number") return "maxTimeoutSeconds must be a number";
  if (!Number.isInteger(value)) return "maxTimeoutSeconds must be an integer";
  if (value <= 0) return "maxTimeoutSeconds must be positive";
  if (value > MAX_TIMEOUT_SECONDS) {
    return `maxTimeoutSeconds ${value} exceeds the ${MAX_TIMEOUT_SECONDS}s maximum`;
  }
  return null;
}

/**
 * Validate the EIP-712 domain and transfer mode of an EVM requirement. The
 * installed SDK selects EIP-3009 unless `extra.assetTransferMethod === "permit2"`,
 * so permit2 (and any unvalidated extension key) is refused here.
 */
function validateEvmExtra(requirement, index, expectedDomainByNetwork) {
  const prefix = `402 accepts[${index}]`;
  const extra = requirement.extra;
  if (!isPlainObject(extra)) return `${prefix} has no valid extra`;
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009") {
    return `${prefix} transfer method ${String(extra.assetTransferMethod)} is not supported`;
  }
  if (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") {
    return `${prefix} paymentFlow ${String(extra.paymentFlow)} is not supported`;
  }
  for (const key of Object.keys(extra)) {
    if (!EVM_EXTRA_ALLOWED_KEYS.has(key)) {
      return `${prefix} extra.${key} is not a supported signing extension`;
    }
  }
  if (typeof extra.name !== "string" || !extra.name.trim()) {
    return `${prefix} EIP-712 domain name is missing`;
  }
  if (typeof extra.version !== "string" || !extra.version.trim()) {
    return `${prefix} EIP-712 domain version is missing`;
  }
  const expectedDomain = expectedDomainByNetwork?.[requirement.network];
  if (expectedDomain) {
    if (extra.name !== expectedDomain.name || extra.version !== expectedDomain.version) {
      return `${prefix} EIP-712 domain ${extra.name}/${extra.version} is not the canonical USDC domain for ${requirement.network}`;
    }
  }
  return null;
}

/**
 * Validate a complete x402 v2 challenge before a payer is allowed to sign.
 *
 * This is deliberately stricter than "pick an acceptable requirement": every
 * offered requirement is checked, and every EVM option must be on an
 * allowlisted network, name the configured payee, use the canonical USDC asset
 * and EIP-712 domain for that network, pin EIP-3009, and stay under the
 * per-payment cap. A mixed challenge that also offers Base mainnet is refused
 * as a whole, not silently filtered down to the testnet option.
 *
 * Returns `{ ok: true, requirement }` for the selected EVM requirement, or
 * `{ ok: false, reason }`. Missing or malformed fields are failures.
 */
export function validatePaymentChallenge(challenge, {
  allowedNetworks = DEFAULT_NETWORKS,
  allowedPayTo = DEFAULT_PAY_TO,
  expectedResource,
  maxAmountUsd,
  expectedAssetByNetwork = NETWORK_USDC,
  expectedDomainByNetwork = NETWORK_USDC_DOMAIN,
} = {}) {
  const fail = (reason) => ({ ok: false, reason });

  if (!isPlainObject(challenge)) {
    return fail("402 challenge is not an object");
  }
  if (challenge.x402Version !== 2) {
    return fail("402 challenge is not x402 v2");
  }
  if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
    return fail("402 challenge has no accepts[]");
  }

  const resource = normalizeUrl(challenge.resource?.url ?? challenge.resource);
  if (!resource) {
    return fail("402 challenge has no valid resource URL");
  }
  if (resource.search || resource.hash) {
    return fail("402 resource must not contain a query or fragment");
  }
  if (expectedResource !== undefined) {
    const expected = normalizeUrl(expectedResource);
    if (!expected) return fail("expected resource is not a valid http(s) URL");
    if (resourceKey(resource) !== resourceKey(expected)) {
      return fail(`402 resource ${resource.href} is not the expected ${expected.href}`);
    }
  }

  const networks = new Set(allowedNetworks);
  const expectedPayTo = String(allowedPayTo ?? "").trim().toLowerCase();
  if (!EVM_ADDRESS_RE.test(expectedPayTo)) {
    return fail("no valid expected payee is configured");
  }

  const maxAtomic = maxAmountUsd === undefined ? null : usdToAtomic(maxAmountUsd);
  if (maxAmountUsd !== undefined && maxAtomic === null) {
    return fail("configured maximum payment amount is not a positive USD value");
  }

  let selected = null;
  for (const [index, requirement] of challenge.accepts.entries()) {
    const prefix = `402 accepts[${index}]`;

    if (!isPlainObject(requirement)) {
      return fail(`${prefix} is not an object`);
    }

    const network = requirement.network;
    if (typeof network !== "string" || !CAIP2_RE.test(network)) {
      return fail(`${prefix} has no valid network`);
    }
    const namespace = network.split(":")[0];
    if (!SUPPORTED_NETWORK_NAMESPACES.has(namespace)) {
      return fail(`${prefix} network ${network} is unsupported`);
    }

    const scheme = requirement.scheme;
    if (scheme !== "exact") {
      return fail(`${prefix} scheme ${String(scheme)} is not exact`);
    }

    const timeoutError = validateTimeoutSeconds(requirement.maxTimeoutSeconds);
    if (timeoutError) {
      return fail(`${prefix} ${timeoutError}`);
    }

    const amount = requirement.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      return fail(`${prefix} has no valid amount`);
    }

    const asset = requirement.asset;
    if (typeof asset !== "string" || !asset.trim()) {
      return fail(`${prefix} has no asset`);
    }

    if (namespace !== "eip155") continue;

    if (!networks.has(network)) {
      return fail(`${prefix} network ${network} is not an allowed EVM network`);
    }
    if (!EVM_ADDRESS_RE.test(asset)) {
      return fail(`${prefix} asset is not an EVM token address`);
    }

    const expectedAsset = expectedAssetByNetwork?.[network];
    if (!expectedAsset) {
      return fail(`no canonical USDC asset is configured for ${network}`);
    }
    if (asset.toLowerCase() !== expectedAsset.toLowerCase()) {
      return fail(`${prefix} asset ${asset} is not the canonical USDC for ${network}`);
    }

    const payTo = String(requirement.payTo ?? "").trim();
    if (!EVM_ADDRESS_RE.test(payTo)) {
      return fail(`${prefix} has no valid payee`);
    }
    if (payTo.toLowerCase() !== expectedPayTo) {
      return fail(`${prefix} payee ${payTo} is not the configured payee`);
    }

    const extraError = validateEvmExtra(requirement, index, expectedDomainByNetwork);
    if (extraError) return fail(extraError);

    if (maxAtomic !== null && BigInt(amount) > maxAtomic) {
      return fail(`${prefix} amount ${amount} exceeds the ${maxAmountUsd} USD cap`);
    }

    if (!selected) selected = requirement;
  }

  if (!selected) {
    return fail("402 challenge offers no allowed EVM payment requirement");
  }
  return { ok: true, requirement: selected };
}

function parseNetworks(raw) {
  const values = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const networks = values.map((value) => String(value).trim()).filter(Boolean);
  if (networks.length === 0) {
    throw new Error("VERIFY402_NETWORKS must list at least one eip155:<chainId> network");
  }
  for (const network of networks) {
    if (!/^eip155:\d+$/.test(network)) {
      throw new Error(`VERIFY402_NETWORKS: ${network} is not an eip155:<chainId> network`);
    }
    if (!SUPPORTED_PAYMENT_NETWORKS.has(network)) {
      throw new Error(
        `VERIFY402_NETWORKS: ${network} is not a supported payment network ` +
          `(supported: ${[...SUPPORTED_PAYMENT_NETWORKS].join(", ")})`,
      );
    }
  }
  return [...new Set(networks)];
}

function normalizePayTo(raw) {
  const value = String(raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("VERIFY402_PAY_TO must be a 20-byte 0x EVM address");
  }
  return value.toLowerCase();
}

function normalizePrefix(raw) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VERIFY402_RESOURCE_PREFIX is not a URL: ${value || "(empty)"}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`VERIFY402_RESOURCE_PREFIX must be http(s): ${value}`);
  }
  return {
    value,
    origin: url.origin,
    pathPrefix: url.pathname.replace(/\/+$/, ""),
  };
}

/**
 * Build the paid-call policy. Throws on invalid configuration so a paid-mode
 * start fails closed instead of silently accepting a wider policy.
 */
export function createPaymentPolicy({
  networks = DEFAULT_NETWORKS,
  payTo = DEFAULT_PAY_TO,
  resourcePrefix,
  paidRoutes = DEFAULT_PAID_ROUTES,
} = {}) {
  const allowedNetworks = parseNetworks(networks);
  const allowed = new Set(allowedNetworks);
  const allowedPayTo = normalizePayTo(payTo);
  const prefix = normalizePrefix(resourcePrefix);
  const routes = new Set(paidRoutes.map(String));

  return {
    allowedNetworks,
    allowedPayTo,
    resourcePrefix: prefix.value,
    paidRoutes: [...routes],

    /**
     * x402Client policy: runs after spend controls and before the selector.
     * Returning an empty array would also fail, but a typed error is easier to
     * debug and is surfaced to the caller as a refused payment.
     */
    filter(_x402Version, requirements) {
      const passing = requirements.filter((requirement) => {
        const network = String(requirement?.network ?? "");
        const requirementPayTo = String(requirement?.payTo ?? "").toLowerCase();
        return allowed.has(network) && requirementPayTo === allowedPayTo;
      });
      if (passing.length === 0) {
        throw new Error(
          `402 offered no payment on an allowed network/payee ` +
            `(allowed networks: ${allowedNetworks.join(", ")}; payee: ${allowedPayTo})`,
        );
      }
      return passing;
    },

    /**
     * x402Client onBeforePaymentCreation hook: runs after selection and before
     * the scheme creates a signature. Returning `{ abort: true }` fails closed.
     *
     * This is the resource/route layer of the policy. The full challenge and
     * the selected requirement are validated by createPaymentGuard(), which
     * wraps this method for both payers.
     */
    checkBeforeSign(context) {
      const rawResource = context?.paymentRequired?.resource;
      const resourceUrl = typeof rawResource === "string" ? rawResource : rawResource?.url;
      if (!resourceUrl) {
        return { abort: true, reason: "402 has no resource URL" };
      }

      let url;
      try {
        url = new URL(String(resourceUrl));
      } catch {
        return { abort: true, reason: `402 resource is not a URL: ${String(resourceUrl)}` };
      }

      if (url.search || url.hash) {
        return { abort: true, reason: "402 resource must not contain a query or fragment" };
      }

      if (url.origin !== prefix.origin) {
        return {
          abort: true,
          reason: `402 resource origin ${url.origin} is not the configured ${prefix.origin}`,
        };
      }

      const pathOk =
        prefix.pathPrefix === "" ||
        url.pathname === prefix.pathPrefix ||
        url.pathname.startsWith(`${prefix.pathPrefix}/`);
      if (!pathOk) {
        return {
          abort: true,
          reason: `402 resource ${url.href} is outside ${prefix.value}`,
        };
      }

      if (!routes.has(url.pathname)) {
        return {
          abort: true,
          reason: `402 resource path ${url.pathname} is not a paid verify402 route`,
        };
      }

      const requirement = context?.selectedRequirements;
      if (!requirement || typeof requirement !== "object") {
        return { abort: true, reason: "402 selected no payment requirement" };
      }
      if (
        !allowed.has(String(requirement.network)) ||
        String(requirement.payTo ?? "").toLowerCase() !== allowedPayTo
      ) {
        return {
          abort: true,
          reason: "selected payment requirement changed after selection",
        };
      }

      return;
    },
  };
}

/**
 * Build the pre-signature guard shared by every payer. It validates the whole
 * 402 challenge, proves the SDK's selected requirement is the exact object that
 * was validated, re-validates that object, and then applies the resource/route
 * layer in policy.checkBeforeSign().
 *
 * `expectedResource` may be a fixed string (the standalone payer and the smoke
 * preflight, which know their one resource) or a resolver returning the
 * resource bound to the current invocation (the MCP bridge, where each paid
 * tool names its own route). A resolver that returns nothing aborts: the guard
 * never signs a challenge that is not tied to locally known tool configuration.
 *
 * Returns a hook `(context) => { abort: true, reason } | undefined` suitable
 * for x402Client.onBeforePaymentCreation().
 */
export function createPaymentGuard(policy, {
  expectedResource,
  maxAmountUsd,
  expectedAssetByNetwork = NETWORK_USDC,
  expectedDomainByNetwork = NETWORK_USDC_DOMAIN,
} = {}) {
  if (!policy || !Array.isArray(policy.allowedNetworks)) {
    throw new Error("createPaymentGuard requires a payment policy");
  }
  if (
    expectedResource !== undefined &&
    typeof expectedResource !== "string" &&
    typeof expectedResource !== "function"
  ) {
    throw new Error("expectedResource must be a string or a resolver function");
  }

  const isResolver = typeof expectedResource === "function";
  const resolveExpectedResource = (context) => {
    const value = isResolver ? expectedResource(context) : expectedResource;
    if (typeof value === "string" && value !== "") return value;
    return null;
  };

  const baseOptions = {
    allowedNetworks: policy.allowedNetworks,
    allowedPayTo: policy.allowedPayTo,
    maxAmountUsd,
    expectedAssetByNetwork,
    expectedDomainByNetwork,
  };

  return function guard(context) {
    const challenge = context?.paymentRequired;
    const resolvedExpectedResource = resolveExpectedResource(context);
    if (isResolver && resolvedExpectedResource === null) {
      return { abort: true, reason: "no expected payment resource is bound to this call" };
    }
    if (!isResolver && expectedResource !== undefined && resolvedExpectedResource === null) {
      return { abort: true, reason: "no expected payment resource for this payment" };
    }
    const options = resolvedExpectedResource === null
      ? baseOptions
      : { ...baseOptions, expectedResource: resolvedExpectedResource };

    const validation = validatePaymentChallenge(challenge, options);
    if (!validation.ok) return { abort: true, reason: validation.reason };

    const selected = context?.selectedRequirements;
    if (!selected || typeof selected !== "object") {
      return { abort: true, reason: "402 selected no payment requirement" };
    }

    const selectedValidation = validatePaymentChallenge(
      { ...challenge, accepts: [selected] },
      options,
    );
    if (!selectedValidation.ok) return { abort: true, reason: selectedValidation.reason };
    if (selectedValidation.requirement !== selected) {
      return { abort: true, reason: "selected payment requirement changed after validation" };
    }

    // Reference identity: the SDK selector returns an element of
    // paymentRequired.accepts, so a clone/substitution is refused here.
    if (!Array.isArray(challenge.accepts) || !challenge.accepts.includes(selected)) {
      return { abort: true, reason: "selected payment requirement is not from the 402 challenge" };
    }

    if (typeof policy.checkBeforeSign === "function") {
      const resourceCheck = policy.checkBeforeSign(context);
      if (resourceCheck?.abort) return resourceCheck;
    }

    return;
  };
}

/**
 * Build the paid-call policy from the bridge's documented environment.
 *
 * The default is deliberately Base Sepolia testnet. Base mainnet is selected
 * only when VERIFY402_NETWORKS explicitly names eip155:8453. An explicitly
 * empty network list or payee throws, so a typo cannot widen the policy.
 */
export function createPaymentPolicyFromEnv({
  resourcePrefix,
  paidRoutes = DEFAULT_PAID_ROUTES,
  env = process.env,
} = {}) {
  return createPaymentPolicy({
    networks: env.VERIFY402_NETWORKS === undefined ? DEFAULT_NETWORKS : env.VERIFY402_NETWORKS,
    payTo: env.VERIFY402_PAY_TO === undefined ? DEFAULT_PAY_TO : env.VERIFY402_PAY_TO,
    resourcePrefix:
      env.VERIFY402_RESOURCE_PREFIX === undefined ? resourcePrefix : env.VERIFY402_RESOURCE_PREFIX,
    paidRoutes,
  });
}
