// 402 directory + watch.
//
// The inspector answers "is this one challenge okay?". The directory answers
// "what is the state of the endpoints people actually pay?". It keeps a small
// seed list, re-inspects each entry on a schedule, and records changes in
// price, payee, network, and verdicts.
//
// Two verdicts, because they answer different questions:
//   protocol — is the challenge well-formed x402? (network-agnostic)
//   sign     — should an agent on this instance's supported networks sign it?
//
// Most live 402s sit on chains this instance cannot verify, so `sign` is often
// BLOCK while `protocol` is PASS. The directory shows both instead of hiding
// that distinction.
//
// History is in memory unless VERIFY402_DIRECTORY_FILE is set. On a free host
// that file is ephemeral, so a restart re-inspects the seeds and starts a new
// history. The directory is a live view, not a ledger.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  inspectUrl,
  resourceUrlOf,
  InspectError,
} from "./inspect.mjs";
import { parseNetwork } from "./preflight.mjs";

export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

// Public endpoints worth watching. Keep this list small: every entry costs one
// outbound request per refresh. Entries are data, not endorsements.
export const SEED_ENTRIES = [
  {
    id: "verify402-verify",
    name: "verify402 · /verify",
    url: "https://verify402.onrender.com/verify",
    method: "POST",
    note: "This service's own paid arbitrage check.",
  },
  {
    id: "naven-ping",
    name: "Naven · x402 test ping",
    url: "https://api.naven.network/x402-test/ping",
    method: "GET",
    note: "Robinhood Chain demo; USDG.",
  },
  {
    id: "grug-missing-header",
    name: "grug402 · missing PAYMENT-REQUIRED",
    url: "https://grug402.dev/api/x402/missing-payment-required",
    method: "GET",
    note: "Intentional edge case: a 402 with no challenge header.",
  },
  {
    id: "grug-raw-json",
    name: "grug402 · raw JSON header",
    url: "https://grug402.dev/api/x402/header-raw-json",
    method: "GET",
    note: "Intentional edge case: the challenge is not base64.",
  },
  {
    id: "grug-legacy-v1",
    name: "grug402 · legacy v1 X-PAYMENT",
    url: "https://grug402.dev/api/x402/legacy-v1-headers",
    method: "GET",
    note: "Intentional edge case: the v1 header, not the v2 challenge.",
  },
];

const block = (code, message) => ({ code, severity: "block", message });
const caution = (code, message) => ({ code, severity: "caution", message });
const unique = (arr) => [...new Set(arr)];

function verdictOf(reasons) {
  if (reasons.some((r) => r.severity === "block")) return "BLOCK";
  if (reasons.some((r) => r.severity === "caution")) return "CAUTION";
  return "PASS";
}

const ZERO_EVM = /^0x0{40}$/i;

// A network-agnostic lint of the challenge itself. It does not know whether
// this instance can settle on the chain; it asks whether the challenge is
// well-formed, internally consistent, and worth a human's attention.
export function protocolHealth({ challenge = null, status = null, now = Date.now() } = {}) {
  const reasons = [];
  const checks = [];

  if (!challenge || !Array.isArray(challenge.accepts) || !challenge.accepts.length) {
    reasons.push(block("no_challenge", "the response carries no usable x402 challenge"));
    return { verdict: "BLOCK", reasons, checks };
  }

  const accepts = challenge.accepts.filter((accept) => accept && typeof accept === "object");
  checks.push("accepts");
  if (accepts.length !== challenge.accepts.length) {
    reasons.push(caution("non_object_accepts", "some accepts entries are not objects"));
  }

  const resource = resourceUrlOf(challenge);
  if (!resource) {
    reasons.push(caution("missing_resource", "the challenge does not name a resource"));
  } else {
    checks.push("resource");
    if (!/^https:\/\//i.test(resource)) {
      reasons.push(caution("non_https_resource", `the resource is ${String(resource).split(":")[0]}, not https`));
    }
  }

  for (const accept of accepts) {
    const net = parseNetwork(accept.network);
    if (!net) {
      reasons.push(caution("unknown_network", `network "${accept.network}" is not a recognized x402 network id`));
    } else {
      checks.push("network");
    }

    if (!accept.scheme) {
      reasons.push(caution("missing_scheme", "an option does not name a scheme"));
    } else if (accept.scheme !== "exact") {
      reasons.push(caution("non_exact_scheme", `scheme "${accept.scheme}" is not exact; this gate only understands exact`));
    }

    if (accept.asset == null || accept.asset === "") {
      reasons.push(block("missing_asset", "an option does not name an asset"));
    }
    if (accept.amount == null || accept.amount === "") {
      reasons.push(block("missing_amount", "an option does not name an amount"));
    } else {
      const amount = Number(accept.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        reasons.push(block("non_positive_amount", `amount "${accept.amount}" is not a positive number`));
      }
    }
    if (!accept.payTo) {
      reasons.push(block("missing_payee", "an option does not name payTo"));
    } else if (ZERO_EVM.test(String(accept.payTo))) {
      reasons.push(block("burn_payee", "an option pays the burn address"));
    }
    if (!accept.maxTimeoutSeconds) {
      reasons.push(caution("missing_timeout", "an option does not name maxTimeoutSeconds"));
    }

    const validBefore = accept.extra?.validBefore ?? challenge.extra?.validBefore;
    if (validBefore) {
      const expiry = Date.parse(String(validBefore));
      if (!Number.isFinite(expiry)) {
        reasons.push(caution("unparseable_expiry", "validBefore is not a date"));
      } else if (expiry < now) {
        reasons.push(block("expired", "the challenge's validBefore is in the past"));
      } else {
        checks.push("expiry");
      }
    }
  }

  // Two payees on the SAME network are suspicious; one payee per rail is normal.
  const payeesByNetwork = new Map();
  for (const accept of accepts) {
    const list = payeesByNetwork.get(accept.network) || new Set();
    if (accept.payTo) list.add(String(accept.payTo).toLowerCase());
    payeesByNetwork.set(accept.network, list);
  }
  if ([...payeesByNetwork.values()].some((set) => set.size > 1)) {
    reasons.push(caution("multiple_payees", "two options on the same network pay different addresses"));
  }

  if (status != null && status !== 402) {
    reasons.push(caution("not_402", `the endpoint answered ${status}, not 402`));
  }

  const seen = new Set();
  const reasonsFinal = [];
  for (const reason of reasons) {
    const key = `${reason.code}:${reason.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      reasonsFinal.push(reason);
    }
  }
  return { verdict: verdictOf(reasonsFinal), reasons: reasonsFinal, checks: unique(checks) };
}

const WATCHED_FIELDS = ["status", "price", "payee", "network", "sign.verdict", "protocol.verdict", "error"];

function getPath(record, path) {
  return path.split(".").reduce((value, key) => value?.[key], record) ?? null;
}

export function diffEntry(previous, next) {
  if (!previous) return [];
  const changes = [];
  for (const field of WATCHED_FIELDS) {
    const from = getPath(previous, field);
    const to = getPath(next, field);
    if (from !== to) changes.push({ at: next.measuredAt, field, from, to });
  }
  return changes;
}

export async function inspectEntry(entry, { now = Date.now(), fetchImpl } = {}) {
  const base = {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    method: entry.method,
    note: entry.note ?? null,
    measuredAt: new Date(now).toISOString(),
  };
  try {
    const result = await inspectUrl(entry.url, { now, method: entry.method, fetchImpl });
    const protocol = protocolHealth({ challenge: result.challenge, status: result.status, now });
    const first = result.options[0];
    return {
      ...base,
      ok: true,
      status: result.status,
      price: first?.accept?.priceUsd ?? null,
      priceBasis: first?.accept?.priceBasis ?? null,
      token: first?.accept?.token ?? null,
      amount: first?.accept?.amount ?? null,
      network: first?.accept?.network ?? null,
      payee: first?.accept?.payTo ?? null,
      resource: result.challenge?.resource ?? null,
      sign: { verdict: result.verdict, reasons: result.reasons },
      protocol,
    };
  } catch (e) {
    const code = e instanceof InspectError ? e.code : "inspect_failed";
    return {
      ...base,
      ok: false,
      status: null,
      error: code,
      errorMessage: e.message,
      price: null,
      amount: null,
      network: null,
      payee: null,
      resource: null,
      sign: { verdict: "BLOCK", reasons: [{ code: "unreachable", severity: "block", message: e.message }] },
      protocol: { verdict: "BLOCK", reasons: [{ code: "no_challenge", severity: "block", message: "the endpoint could not be inspected" }], checks: [] },
    };
  }
}

function publicRecord(record) {
  if (!record) return null;
  return {
    id: record.entry.id,
    name: record.entry.name,
    url: record.entry.url,
    method: record.entry.method,
    note: record.entry.note ?? null,
    current: record.current,
    changes: record.changes.slice(-20).reverse(),
  };
}

export function createDirectory({
  entries = SEED_ENTRIES,
  intervalMs = DEFAULT_INTERVAL_MS,
  filePath = null,
  fetchImpl,
  now = () => Date.now(),
} = {}) {
  const records = new Map();
  const order = entries.map((entry) => entry.id);
  let lastRunAt = null;
  let nextRunAt = null;

  // Restore history when a file is configured. A missing or corrupt file is a
  // fresh start, not an error: the directory is a live view.
  if (filePath) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      for (const entry of entries) {
        const saved = raw?.entries?.[entry.id];
        if (saved?.current) records.set(entry.id, { entry, current: saved.current, changes: Array.isArray(saved.changes) ? saved.changes : [] });
      }
    } catch {
      /* fresh start */
    }
  }

  function save() {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const payload = { version: 1, savedAt: new Date().toISOString(), entries: {} };
      for (const [id, record] of records) payload.entries[id] = { current: record.current, changes: record.changes };
      writeFileSync(filePath, JSON.stringify(payload, null, 2));
    } catch {
      /* persistence is best-effort; the live view still works */
    }
  }

  async function refresh() {
    for (const entry of entries) {
      const next = await inspectEntry(entry, { now: now(), fetchImpl });
      const previous = records.get(entry.id)?.current ?? null;
      const changes = diffEntry(previous, next);
      const history = [...(records.get(entry.id)?.changes ?? []), ...changes].slice(-100);
      records.set(entry.id, { entry, current: next, changes: history });
    }
    save();
    return snapshot();
  }

  function snapshot() {
    return {
      mode: filePath ? "file" : "memory",
      intervalMinutes: Math.max(1, Math.round(intervalMs / 60000)),
      lastRunAt: lastRunAt,
      nextRunAt,
      generatedAt: new Date().toISOString(),
      entries: order.map((id) => publicRecord(records.get(id))).filter(Boolean),
    };
  }

  return {
    entries: order,
    intervalMs,
    refresh,
    snapshot,
    start() {
      nextRunAt = new Date(now() + intervalMs).toISOString();
      const timer = setInterval(() => {
        lastRunAt = new Date().toISOString();
        nextRunAt = new Date(Date.now() + intervalMs).toISOString();
        refresh().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
      return this;
    },
    async runOnce() {
      lastRunAt = new Date().toISOString();
      nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      await refresh();
      return snapshot();
    },
  };
}
