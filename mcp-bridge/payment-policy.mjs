// Payment policy for the paid x402 client.
//
// The bridge is a payer, not a blank cheque for any remote 402. Before a
// signature exists, the policy requires:
//
//   - the network to be explicitly allowlisted (default Base mainnet);
//   - payTo to be the verify402 payee (default the EVM payTo);
//   - the 402 resource to be on the configured server and a known paid route.
//
// The amount cap and the default-asset (USDC) allowlist are enforced by
// x402Client's spendControls, which run before this policy. Redirects are
// refused by the axios client in index.mjs.
//
// Free-only mode never imports or constructs this policy.

export const DEFAULT_NETWORKS = ["eip155:8453"];
export const DEFAULT_PAY_TO = "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb";
export const DEFAULT_PAID_ROUTES = ["/verify", "/safety", "/route", "/quotecheck", "/depth"];

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
      if (!requirement) {
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
