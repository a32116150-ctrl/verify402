// Upgrade control: can this contract's code be replaced, and by whom?
//
// A contract that can be upgraded runs whatever code its controller installs
// next. For a router or a spender that holds token approvals, that controller
// is the real counterparty. This module reads the standard proxy slots and
// classifies the controller. It reads only public chain state and never
// guesses: anything it cannot read is reported as unknown.
//
// Covered: EIP-1967 proxies (UUPS, transparent, beacon) and the older
// ZeppelinOS slots. Not covered: diamonds (EIP-2535), custom or minimal
// proxies with hardcoded targets, and contracts whose own logic can be swapped
// by other means. Those are listed in notChecked.

const SLOT = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  ozImplementation: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  ozAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
};
const SEL = {
  owner: "0x8da5cb5b",
  admin: "0xf851a440",
  getThreshold: "0xe75235b8",
  getOwners: "0xa0e67e2b",
  getMinDelay: "0xf27a0c92",
  implementation: "0x5c60da1b",
};
const ZERO = `0x${"0".repeat(40)}`;
const DELEGATION_PREFIX = "0xef0100"; // EIP-7702: a key-held wallet with delegated code

export const UPGRADE_CONTROL_NOT_CHECKED = "upgrade control outside EIP-1967 / ZeppelinOS proxies (diamonds, custom proxies)";

const addrOfWord = (hex) => {
  if (typeof hex !== "string" || hex.length < 42) return null;
  const a = `0x${hex.slice(-40)}`.toLowerCase();
  return a === ZERO ? null : a;
};

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(t));
}

async function tryCall(client, to, data) {
  try {
    const r = await client.call({ to, data });
    return r?.data && r.data !== "0x" ? r.data : null;
  } catch {
    return null;
  }
}

/** What kind of account controls upgrades: one key, a multisig, a timelock, or another contract. */
export async function classifyController(client, address, depth = 0) {
  if (!address) return { kind: "none", address: null };
  const code = await client.getCode({ address });
  if (!code || code === "0x") return { kind: "single_key", address };
  if (code.toLowerCase().startsWith(DELEGATION_PREFIX)) {
    return { kind: "single_key", address, delegatedTo: `0x${code.slice(8, 48)}`.toLowerCase(), note: "a key-held wallet with EIP-7702 delegated code" };
  }
  const [threshold, owners, delay] = await Promise.all([
    tryCall(client, address, SEL.getThreshold),
    tryCall(client, address, SEL.getOwners),
    tryCall(client, address, SEL.getMinDelay),
  ]);
  if (threshold && owners) {
    const t = Number(BigInt(threshold));
    const n = owners.length >= 130 ? Number(BigInt(`0x${owners.slice(66, 130)}`)) : null;
    return { kind: t <= 1 ? "multisig_one_signer" : "multisig", address, threshold: t, signers: n };
  }
  if (delay) return { kind: "timelock", address, minDelaySeconds: Number(BigInt(delay)) };
  // A ProxyAdmin-style contract: follow its owner one level.
  if (depth === 0) {
    const owner = addrOfWord(await tryCall(client, address, SEL.owner));
    if (owner) return { kind: "contract", address, owner: await classifyController(client, owner, depth + 1) };
  }
  return { kind: "contract", address };
}

/** The effective controller kind, following a ProxyAdmin to its owner. */
export function effectiveKind(controller) {
  if (!controller) return "unknown";
  if (controller.kind === "contract" && controller.owner) return controller.owner.kind;
  return controller.kind;
}

/**
 * Read who can replace the code at `address`. Returns one of:
 *   { address, upgradeable: false }
 *   { address, upgradeable: true, pattern, implementation, controller }
 *   { address, upgradeable: null, error }   (could not read; never a guess)
 */
export async function readUpgradeControl(client, address, { timeoutMs = 4000 } = {}) {
  const a = String(address).toLowerCase();
  try {
    return await withTimeout((async () => {
      const [impl, admin, beacon, ozImpl, ozAdmin] = await Promise.all(
        [SLOT.implementation, SLOT.admin, SLOT.beacon, SLOT.ozImplementation, SLOT.ozAdmin]
          .map((slot) => client.getStorageAt({ address: a, slot })),
      );
      const implementation = addrOfWord(impl) ?? addrOfWord(ozImpl);
      const adminAddr = addrOfWord(admin) ?? addrOfWord(ozAdmin);
      const beaconAddr = addrOfWord(beacon);

      if (beaconAddr) {
        const beaconImpl = addrOfWord(await tryCall(client, beaconAddr, SEL.implementation));
        const owner = addrOfWord(await tryCall(client, beaconAddr, SEL.owner));
        return { address: a, upgradeable: true, pattern: "beacon", beacon: beaconAddr, implementation: beaconImpl,
          controller: owner ? await classifyController(client, owner) : { kind: "unknown", address: null } };
      }
      if (!implementation) return { address: a, upgradeable: false };
      if (adminAddr) {
        return { address: a, upgradeable: true, pattern: "transparent", implementation, controller: await classifyController(client, adminAddr) };
      }
      // UUPS: the implementation authorises upgrades, usually through owner().
      const owner = await tryCall(client, a, SEL.owner);
      if (owner) {
        const ownerAddr = addrOfWord(owner);
        return { address: a, upgradeable: true, pattern: "uups", implementation,
          controller: ownerAddr ? await classifyController(client, ownerAddr) : { kind: "renounced", address: null } };
      }
      return { address: a, upgradeable: true, pattern: "uups", implementation, controller: { kind: "unknown", address: null } };
    })(), timeoutMs);
  } catch (e) {
    return { address: a, upgradeable: null, error: e?.shortMessage || e?.message || String(e) };
  }
}

const short = (x) => (typeof x === "string" && x.length > 12 ? `${x.slice(0, 6)}…${x.slice(-4)}` : String(x));

/** One plain sentence for a reading, or null when there is nothing to say. */
export function describeUpgradeControl(r, role = "contract") {
  if (!r || r.upgradeable !== true) return null;
  const c = r.controller ?? {};
  const kind = effectiveKind(c);
  const who = c.kind === "contract" && c.owner ? c.owner : c;
  const head = `The ${role} ${short(r.address)} can have its code replaced`;
  switch (kind) {
    case "single_key": return `${head} at any time by a single key (${short(who.address)}).`;
    case "multisig_one_signer": return `${head} by a multisig that needs only 1 signature (${short(who.address)}), in effect a single key.`;
    case "multisig": return `${head} by a ${who.threshold}-of-${who.signers ?? "?"} multisig (${short(who.address)}).`;
    case "timelock": return `${head} after a ${who.minDelaySeconds}s timelock (${short(who.address)}).`;
    case "renounced": return `${short(r.address)} is a proxy whose owner was renounced; upgrades look disabled, but the implementation's own rules were not read.`;
    case "contract": return `${head} by the contract ${short(who.address)}; what controls that contract was not read.`;
    default: return `${head}; who controls upgrades could not be determined.`;
  }
}

/** True when the effective controller is one key (including a 1-signer multisig). */
export function isSingleKey(r) {
  if (!r || r.upgradeable !== true) return false;
  const k = effectiveKind(r.controller);
  return k === "single_key" || k === "multisig_one_signer";
}
