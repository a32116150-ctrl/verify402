// Upgrade control: who can replace a contract's code. Fake chain state only.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { readUpgradeControl, describeUpgradeControl, isSingleKey } from "../src/upgrade-control.mjs";
import { preflight } from "../src/preflight.mjs";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const KEY = "0x00000000000000000000000000000000000000cc";
const SAFE = "0x00000000000000000000000000000000000000dd";
const LOCK = "0x00000000000000000000000000000000000000ee";
const PADMIN = "0x00000000000000000000000000000000000000ff";
const TOKEN = "0x0000000000000000000000000000000000000a11";
const NOW = 1_800_000_000_000;
const word = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;
const num = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;

// A tiny fake chain: storage per address, code per address, and call answers.
function chain({ storage = {}, code = {}, calls = {} } = {}) {
  return {
    async getStorageAt({ address, slot }) { return storage[`${address.toLowerCase()}:${slot}`] ?? num(0); },
    async getCode({ address }) { return code[address.toLowerCase()] ?? "0x"; },
    async call({ to, data }) {
      const v = calls[`${to.toLowerCase()}:${data}`];
      if (v === undefined) throw new Error("execution reverted");
      return { data: v };
    },
    async getBlock() { return { number: 1n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(NOW / 1000) }; },
  };
}
const uups = (owner, extra = {}) => chain({
  storage: { [`${PROXY}:${IMPL_SLOT}`]: word(IMPL) },
  code: { [PROXY]: "0x6000", ...extra.code },
  calls: { [`${PROXY}:0x8da5cb5b`]: word(owner), ...extra.calls },
});

test("not a proxy: not upgradeable", async () => {
  const r = await readUpgradeControl(chain({ code: { [PROXY]: "0x6000" } }), PROXY);
  assert.equal(r.upgradeable, false);
  assert.equal(describeUpgradeControl(r), null);
});

test("UUPS owned by a plain wallet: single key", async () => {
  const r = await readUpgradeControl(uups(KEY), PROXY);
  assert.equal(r.pattern, "uups");
  assert.equal(r.implementation, IMPL);
  assert.equal(r.controller.kind, "single_key");
  assert.ok(isSingleKey(r));
  assert.match(describeUpgradeControl(r, "spender"), /^The spender 0x0000…00aa can have its code replaced at any time by a single key \(0x0000…00cc\)\.$/);
});

test("UUPS owned by an EIP-7702 wallet: still a single key", async () => {
  const r = await readUpgradeControl(uups(KEY, { code: { [KEY]: `0xef0100${"12".repeat(20)}` } }), PROXY);
  assert.equal(r.controller.kind, "single_key");
  assert.equal(r.controller.delegatedTo, `0x${"12".repeat(20)}`);
});

test("UUPS owned by a 2-of-3 Safe: multisig, not a single key", async () => {
  const owners = `0x${num(32).slice(2)}${num(3).slice(2)}${word(KEY).slice(2).repeat(3)}`;
  const r = await readUpgradeControl(uups(SAFE, { code: { [SAFE]: "0x6000" }, calls: { [`${SAFE}:0xe75235b8`]: num(2), [`${SAFE}:0xa0e67e2b`]: owners } }), PROXY);
  assert.deepEqual([r.controller.kind, r.controller.threshold, r.controller.signers], ["multisig", 2, 3]);
  assert.equal(isSingleKey(r), false);
  assert.match(describeUpgradeControl(r), /2-of-3 multisig/);
});

test("a 1-signer Safe counts as a single key", async () => {
  const owners = `0x${num(32).slice(2)}${num(1).slice(2)}${word(KEY).slice(2)}`;
  const r = await readUpgradeControl(uups(SAFE, { code: { [SAFE]: "0x6000" }, calls: { [`${SAFE}:0xe75235b8`]: num(1), [`${SAFE}:0xa0e67e2b`]: owners } }), PROXY);
  assert.equal(r.controller.kind, "multisig_one_signer");
  assert.ok(isSingleKey(r));
});

test("timelock controller", async () => {
  const r = await readUpgradeControl(uups(LOCK, { code: { [LOCK]: "0x6000" }, calls: { [`${LOCK}:0xf27a0c92`]: num(172800) } }), PROXY);
  assert.deepEqual([r.controller.kind, r.controller.minDelaySeconds], ["timelock", 172800]);
  assert.match(describeUpgradeControl(r), /after a 172800s timelock/);
});

test("transparent proxy: the ProxyAdmin is followed to its owner", async () => {
  const c = chain({
    storage: { [`${PROXY}:${IMPL_SLOT}`]: word(IMPL), [`${PROXY}:${ADMIN_SLOT}`]: word(PADMIN) },
    code: { [PROXY]: "0x6000", [PADMIN]: "0x6000" },
    calls: { [`${PADMIN}:0x8da5cb5b`]: word(KEY) },
  });
  const r = await readUpgradeControl(c, PROXY);
  assert.equal(r.pattern, "transparent");
  assert.equal(r.controller.kind, "contract");
  assert.equal(r.controller.owner.kind, "single_key");
  assert.ok(isSingleKey(r));
});

test("unreadable chain: reported, never guessed", async () => {
  const c = { async getStorageAt() { throw new Error("rpc down"); } };
  const r = await readUpgradeControl(c, PROXY);
  assert.equal(r.upgradeable, null);
  assert.match(r.error, /rpc down/);
  assert.equal(isSingleKey(r), false);
});

// ------------------------------------------------------------ in the gate --

const approve = (spender) => encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [spender, 1000n] });
function gateChain() {
  // TOKEN is itself a single-key proxy; PROXY (the spender) is a single-key UUPS proxy.
  const c = uups(KEY, {
    code: { [TOKEN]: "0x6000" },
    calls: { [`${TOKEN}:0x8da5cb5b`]: word(KEY), [`${TOKEN}:0x313ce567`]: num(6), [`${TOKEN}:0x95d89b41`]: "0x" },
  });
  const base = c.getStorageAt;
  c.getStorageAt = async (a) => (a.address.toLowerCase() === TOKEN && a.slot === IMPL_SLOT ? word(IMPL) : base(a));
  c.readContract = async ({ functionName }) => (functionName === "decimals" ? 6 : "TKN");
  return c;
}
const run = (policy) => preflight({ kind: "transaction", transaction: { chainId: 8453, to: TOKEN, data: approve(PROXY), value: "0" }, ...(policy ? { policy } : {}) },
  { clientFactory: () => gateChain(), now: NOW });

test("gate: informational by default, verdict unchanged", async () => {
  const r = await run();
  assert.ok(r.checked.includes("upgrade_control"));
  assert.ok(!r.reasons.some((x) => x.code === "upgradeable_single_key"));
  const roles = Object.fromEntries(r.upgradeControl.map((u) => [u.role, u]));
  assert.equal(roles.token.controller.kind, "single_key", "the token's issuer key is recorded");
  assert.equal(roles.spender.controller.kind, "single_key");
  assert.deepEqual(r.advice.control, ["The spender 0x0000…00aa can have its code replaced at any time by a single key (0x0000…00cc)."],
    "advice names the spender only, not the token being approved");
});

test("gate: policy.upgradeControl caution / block raises a reason for the spender only", async () => {
  const c = await run({ upgradeControl: "caution" });
  const hits = c.reasons.filter((x) => x.code === "upgradeable_single_key");
  assert.equal(hits.length, 1, "one reason: the spender, not the token");
  assert.equal(hits[0].severity, "caution");
  const b = await run({ upgradeControl: "block" });
  assert.equal(b.verdict, "BLOCK");
  assert.ok(b.reasons.some((x) => x.code === "upgradeable_single_key" && x.severity === "block"));
});

test("gate: invalid policy.upgradeControl is a 400", async () => {
  await assert.rejects(() => run({ upgradeControl: "yes" }), (e) => e.status === 400 && e.code === "invalid_policy");
});
