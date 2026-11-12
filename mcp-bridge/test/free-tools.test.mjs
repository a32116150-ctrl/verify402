// The free tools must be free, always registered, and never payable.
//
// These checks read the bridge source and the public surfaces rather than
// booting the stdio transport: the guarantee under test is that the free tools
// exist, are registered before the paid block, and are never bound to a paid
// route (which is what would let a 402 challenge redirect one of them).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PAID_TOOL_ROUTES } from "../index.mjs";
import { buildServiceManifest } from "../../src/manifest.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");

const FREE_TOOLS = ["preflight_gate", "inspect_402", "directory_402"];

test("every free tool is registered before the paid block", () => {
  const paidBlock = source.indexOf("if (paidApi) {");
  assert.ok(paidBlock > 0, "the paid block must exist");
  for (const tool of FREE_TOOLS) {
    const at = source.indexOf(`server.tool(\n    "${tool}"`);
    assert.ok(at > 0, `${tool} must be registered with server.tool`);
    assert.ok(at < paidBlock, `${tool} must be registered without a wallet`);
  }
});

test("no free tool is bound to a paid route", () => {
  for (const tool of FREE_TOOLS) {
    assert.equal(Object.hasOwn(PAID_TOOL_ROUTES, tool), false, `${tool} must not be payable`);
  }
});

test("the free tools call the free endpoints", () => {
  assert.match(source, /freeApi\.post\("\/inspect"/);
  assert.match(source, /freeApi\.get\("\/directory\.json"/);
});

test("the manifest advertises the free tools as free", () => {
  const manifest = buildServiceManifest({ mode: "testnet" });
  const tools = manifest.integrations.mcp.tools;
  for (const tool of FREE_TOOLS) {
    const entry = tools.find((t) => t.name === tool);
    assert.ok(entry, `${tool} must be advertised in the manifest`);
    assert.equal(entry.type, "free", `${tool} must be advertised as free`);
  }
});

test("the public MCP page lists the free tools", () => {
  const page = readFileSync(new URL("../../src/site/mcp.html", import.meta.url), "utf8");
  for (const tool of FREE_TOOLS) {
    assert.ok(page.includes(tool), `${tool} must be listed on the /mcp page`);
  }
});
