// Release identity and testnet-demo consistency.
//
// These tests are intentionally repository-level: they catch the metadata drift
// that let npm reach 1.0.4 while the manifest, OpenAPI, lockfile, and live docs
// still said 1.0.3. They also prove that the documented demo policy is testnet
// only and fails closed if someone substitutes a mainnet requirement.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHED_VERSION, RELEASE_STATUS, RELEASE_VERSION } from "../src/version.mjs";
import { buildServiceManifest } from "../src/manifest.mjs";
import { buildOpenapi } from "../src/openapi.mjs";
import { PRICE_DEFAULTS } from "../src/contract.mjs";
import {
  buildInfoHosting,
  buildLlmsText,
  buildPreflightPaymentExample,
} from "../src/payment-mode.mjs";
import {
  createPaymentPolicyFromEnv,
  DEFAULT_NETWORKS,
  DEFAULT_PAY_TO,
  DEMO_NETWORK,
  MAINNET_NETWORK,
} from "../mcp-bridge/payment-policy.mjs";
import {
  assertSupportedExpectedMode,
  buildFreeSmokeEnv,
  resolveExpectedMode,
  resolveExpectedVersion,
} from "../scripts/post-deploy-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TESTNET_REQUIREMENT = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "50000",
  asset: TESTNET_USDC,
  payTo: DEFAULT_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

const MAINNET_REQUIREMENT = {
  ...TESTNET_REQUIREMENT,
  network: "eip155:8453",
  asset: MAINNET_USDC,
  extra: { name: "USD Coin", version: "2" },
};

test("release metadata uses one version across package, lockfile, registry, manifest, OpenAPI, and site", () => {
  const pkg = json("mcp-bridge/package.json");
  const lock = json("mcp-bridge/package-lock.json");
  const server = json("server.json");
  const manifest = buildServiceManifest({ mode: "testnet" });
  const openapi = buildOpenapi(PRICE_DEFAULTS);

  assert.equal(PUBLISHED_VERSION, RELEASE_VERSION, "the published npm version must match the release identity");
  assert.equal(pkg.version, RELEASE_VERSION);
  assert.equal(lock.version, RELEASE_VERSION);
  assert.equal(lock.packages[""].version, RELEASE_VERSION);
  assert.equal(server.version, RELEASE_VERSION);
  assert.equal(server.packages[0].version, RELEASE_VERSION);
  assert.equal(manifest.version, RELEASE_VERSION);
  assert.equal(openapi.info.version, RELEASE_VERSION);

  assert.match(read("mcp-bridge/index.mjs"), new RegExp(`const VERSION = "${RELEASE_VERSION}";`));
  const serverSource = read("src/server.mjs");
  assert.match(serverSource, /version: RELEASE_VERSION/);

  const testnetLlms = buildLlmsText({
    mode: "testnet",
    baseUrl: "https://verify402.onrender.com",
  });
  assert.match(
    testnetLlms,
    new RegExp(`npx -y verify402-mcp@${PUBLISHED_VERSION.replaceAll(".", "\\.")}`),
    "runtime /llms.txt must install the published npm version",
  );
  assert.doesNotMatch(
    testnetLlms,
    /unpublished|candidate/i,
    "runtime /llms.txt must not describe the published release as a candidate",
  );
  assert.doesNotMatch(
    read("src/payment-mode.mjs"),
    /verify402-mcp@\d+\.\d+\.\d+/,
    "runtime metadata must not pin a hardcoded release version",
  );
  const mcpPage = read("src/site/mcp.html");
  assert.match(mcpPage, new RegExp(`verify402-mcp v${PUBLISHED_VERSION.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(
    mcpPage,
    /candidate\s*·\s*unpublished/i,
    "the /mcp page must not present the published version as a candidate",
  );

  // The /info response definition must itself declare the top-level release
  // version. A string elsewhere in the document is not enough.
  const infoSchema = openapi.paths["/info"].get.responses[200].content["application/json"].schema;
  assert.ok(infoSchema.required.includes("version"), "OpenAPI /info must require top-level version");
  assert.equal(infoSchema.properties.version.const, RELEASE_VERSION);

  assert.equal(
    manifest.integrations.mcp.quickInstallCommand,
    `npx -y verify402-mcp@${PUBLISHED_VERSION}`,
    "manifest quickInstallCommand must install the published npm version",
  );
  assert.equal(
    manifest.integrations.mcp.releaseStatus,
    RELEASE_STATUS,
    "manifest must state the published release status",
  );
  assert.equal(manifest.integrations.mcp.publishedVersion, PUBLISHED_VERSION);
  assert.equal(
    Object.hasOwn(manifest.integrations.mcp, "plannedVersion"),
    false,
    "the published manifest must not carry planned-only fields",
  );
});

test("MCP Registry metadata truthfully describes the published 1.0.5 release", () => {
  const server = json("server.json");
  const env = server.packages?.[0]?.environmentVariables ?? [];
  const network = env.find((entry) => entry.name === "VERIFY402_NETWORKS");
  assert.ok(network, "server.json must document VERIFY402_NETWORKS");

  // The registry entry describes the published 1.0.5 release. Its built-in
  // runtime default is Base Sepolia testnet; Base mainnet is an explicit opt-in.
  assert.equal(Object.hasOwn(network, "default"), true, "server.json must declare the 1.0.5 default network");
  assert.equal(network.default, DEMO_NETWORK);
  assert.equal(network.isRequired, false, "the safe Base Sepolia default means configuration is optional");
  assert.match(network.description, /Base Sepolia/);
  assert.match(network.description, /eip155:84532|84532/);
  assert.match(network.description, /Base mainnet/);
  assert.match(network.description, /eip155:8453|8453/);

  const evmPrivateKey = env.find((entry) => entry.name === "EVM_PRIVATE_KEY");
  assert.ok(evmPrivateKey, "server.json must document EVM_PRIVATE_KEY");
  assert.equal(evmPrivateKey.isRequired, false);
  assert.match(evmPrivateKey.description, /Base Sepolia/);
  assert.match(evmPrivateKey.description, new RegExp(RELEASE_VERSION.replaceAll(".", "\\.")));
  assert.doesNotMatch(
    evmPrivateKey.description,
    /unpublished|candidate/i,
    "server.json must not describe the published release as a candidate",
  );

  // The top-level description must not imply the published package is a
  // testnet-only demo.
  assert.doesNotMatch(server.description, /testnet USDC|demo uses Base Sepolia/i);
});

test("public surfaces do not advertise mainnet as the demo payment rail", () => {
  const landing = read("src/landing.html");
  assert.doesNotMatch(landing, /Mainnet-armed/i);
  assert.match(landing, /testnet USDC/i);
  assert.match(landing, /mainnet chain data/i);

  const serverSource = read("src/server.mjs");
  assert.match(serverSource, /buildLlmsText\(/);
  assert.match(serverSource, /buildAgentDescription\(MODE\)/);
  assert.match(serverSource, /mode: MODE/);

  const testnetLlms = buildLlmsText({ mode: "testnet", releaseVersion: RELEASE_VERSION });
  assert.match(testnetLlms, /## Paid, x402 exact, testnet USDC/);
  assert.match(testnetLlms, /eip155:84532/);
  assert.match(testnetLlms, /VERIFY402_NETWORKS=eip155:84532/);
  assert.match(testnetLlms, /Base Sepolia/);

  const checks = read("src/site/checks.html");
  assert.doesNotMatch(checks, /USDC over x402 on Base or Solana/i);
  assert.match(checks, /Base Sepolia/);

  const bridgeIndex = read("mcp-bridge/index.mjs");
  assert.match(bridgeIndex, /createPaymentPolicyFromEnv/);
  assert.doesNotMatch(bridgeIndex, /VERIFY402_NETWORKS \|\| DEFAULT_NETWORKS/);

  const openapi = buildOpenapi(PRICE_DEFAULTS);
  const health = openapi.paths["/health"].get.responses[200].content["application/json"].schema.properties;
  assert.equal(health.mode.example, "testnet");
  assert.match(health.networks.example, /Base Sepolia/);
  assert.doesNotMatch(health.networks.example, /mainnet/i);

  const serviceManifest = read("docs/service-manifest.md");
  assert.doesNotMatch(serviceManifest, /Published GitHub release asset/i);
  assert.match(serviceManifest, /registry\.npmjs\.org\/verify402-mcp/);
  assert.match(serviceManifest, /eip155:84532/);
  assert.match(serviceManifest, /PAYMENT-SIGNATURE/);

  const discovery = read("docs/x402-discovery.md");
  assert.match(discovery, /X402_MODE=testnet/);
  assert.match(discovery, /eip155:84532/);
  assert.match(discovery, /PAYMENT-SIGNATURE/);
  assert.doesNotMatch(discovery, /Deployment Mode:\*\* Mainnet/);
});

test("runtime metadata follows the configured mode instead of hardcoding the demo rail", () => {
  const testnet = buildOpenapi(PRICE_DEFAULTS, { mode: "testnet", baseUrl: "https://testnet.example" });
  const mainnet = buildOpenapi(PRICE_DEFAULTS, { mode: "mainnet", baseUrl: "https://mainnet.example" });

  const health = (doc) => doc.paths["/health"].get.responses[200].content["application/json"].schema.properties;
  assert.equal(health(testnet).mode.example, "testnet");
  assert.equal(health(mainnet).mode.example, "mainnet");
  assert.match(health(testnet).networks.example, /Base Sepolia/);
  assert.match(health(mainnet).networks.example, /Base mainnet/);

  assert.equal(testnet.servers[0].url, "https://testnet.example");
  assert.equal(mainnet.servers[0].url, "https://mainnet.example");
  assert.match(testnet.info.description, /Base Sepolia testnet/);
  assert.match(mainnet.info.description, /Base mainnet/);
  assert.doesNotMatch(mainnet.info.description, /public demo settles on Base Sepolia/i);

  const preflight = (doc) => doc.paths["/preflight"].post.requestBody.content["application/json"].example.payment;
  assert.equal(preflight(testnet).network, DEMO_NETWORK);
  assert.equal(preflight(testnet).asset, TESTNET_USDC);
  assert.equal(preflight(mainnet).network, MAINNET_NETWORK);
  assert.equal(preflight(mainnet).asset, MAINNET_USDC);
  assert.equal(preflight(testnet).resource, "https://testnet.example/verify");
  assert.equal(preflight(mainnet).resource, "https://mainnet.example/verify");

  const infoSchema = (doc) => doc.paths["/info"].get.responses[200].content["application/json"].schema;
  assert.ok(infoSchema(testnet).required.includes("mode"));
  assert.equal(infoSchema(mainnet).properties.mode.example, "mainnet");
  assert.match(infoSchema(mainnet).properties.networks.example, /Base mainnet/);

  const testnetManifest = buildServiceManifest({ mode: "testnet", baseUrl: "https://testnet.example" });
  const mainnetManifest = buildServiceManifest({ mode: "mainnet", baseUrl: "https://mainnet.example" });
  assert.equal(testnetManifest.paymentRequirements.mode, "testnet");
  assert.equal(mainnetManifest.paymentRequirements.mode, "mainnet");
  assert.equal(testnetManifest.canonicalUrl, "https://testnet.example");
  assert.equal(mainnetManifest.canonicalUrl, "https://mainnet.example");
  assert.ok(testnetManifest.paymentRequirements.supportedNetworks.some((n) => n.id === DEMO_NETWORK));
  assert.ok(!testnetManifest.paymentRequirements.supportedNetworks.some((n) => n.id === MAINNET_NETWORK));
  assert.ok(mainnetManifest.paymentRequirements.supportedNetworks.some((n) => n.id === MAINNET_NETWORK));
  assert.ok(!mainnetManifest.paymentRequirements.supportedNetworks.some((n) => n.id === DEMO_NETWORK));

  const registryNetwork = (manifest) =>
    manifest.integrations.mcp.environmentVariables.find((entry) => entry.name === "VERIFY402_NETWORKS");
  assert.equal(Object.hasOwn(registryNetwork(testnetManifest), "default"), true);
  assert.equal(registryNetwork(testnetManifest).default, DEMO_NETWORK);
  assert.equal(registryNetwork(testnetManifest).isRequired, false);
  assert.equal(registryNetwork(testnetManifest).publishedPackageDefault, DEMO_NETWORK);
  assert.equal(
    Object.hasOwn(registryNetwork(testnetManifest), "candidatePackageDefault"),
    false,
    "the published manifest must not carry a separate candidate default",
  );
  assert.equal(registryNetwork(testnetManifest).demoValue, DEMO_NETWORK);
  assert.equal(registryNetwork(mainnetManifest).default, DEMO_NETWORK);
  assert.equal(registryNetwork(mainnetManifest).demoValue, MAINNET_NETWORK);

  const testnetLlms = buildLlmsText({
    mode: "testnet",
    baseUrl: "https://testnet.example",
  });
  const mainnetLlms = buildLlmsText({
    mode: "mainnet",
    baseUrl: "https://mainnet.example",
  });
  assert.match(testnetLlms, /testnet USDC/);
  assert.match(testnetLlms, /eip155:84532/);
  assert.match(testnetLlms, /https:\/\/testnet\.example/);
  assert.match(mainnetLlms, /## Paid, x402 exact, USDC \(Base mainnet/);
  assert.match(mainnetLlms, /eip155:8453/);
  assert.doesNotMatch(mainnetLlms, /testnet USDC/);
  assert.doesNotMatch(mainnetLlms, /eip155:84532/);
  assert.match(mainnetLlms, /https:\/\/mainnet\.example/);

  assert.equal(
    buildPreflightPaymentExample({
      mode: "testnet",
      baseUrl: "https://testnet.example",
      payTo: DEFAULT_PAY_TO,
    }).network,
    DEMO_NETWORK,
  );
  assert.equal(
    buildPreflightPaymentExample({
      mode: "mainnet",
      baseUrl: "https://mainnet.example",
      payTo: DEFAULT_PAY_TO,
    }).network,
    MAINNET_NETWORK,
  );

  assert.match(buildInfoHosting("testnet").status, /testnet only/);
  assert.match(buildInfoHosting("mainnet").status, /does not claim production validation/);
});

test("public demo docs name Base Sepolia testnet USDC, not mainnet as the demo default", () => {
  const docs = [
    "README.md",
    "examples/ONBOARDING.md",
    "mcp-bridge/llms-install.md",
    "docs/ai-agent-guide.md",
    "src/site/start.html",
    "src/site/preflight.html",
    "src/site/docs.html",
  ];

  for (const rel of docs) {
    const text = read(rel);
    assert.match(text, /eip155:84532/, `${rel} must name the demo testnet network`);
    assert.match(text, new RegExp(TESTNET_USDC, "i"), `${rel} must name testnet USDC`);
    assert.match(text, /testnet/i, `${rel} must say the demo payment rail is testnet`);
  }

  const readme = read("README.md");
  assert.match(readme, /"VERIFY402_NETWORKS": "eip155:84532"/);
  assert.match(readme, /mainnet chain data/i);
  assert.match(readme, /Mainnet is explicit[\s\S]{0,1600}VERIFY402_NETWORKS=eip155:8453/i);

  const envExample = read(".env.example");
  assert.match(envExample, /VERIFY402_NETWORKS=eip155:84532/);
  assert.match(envExample, /VERIFY402_NETWORKS=eip155:8453/);
  assert.match(envExample, /Future mainnet deployment only/i);

  // An active line is the default; a commented line is only documentation.
  const activeEnv = envExample
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.match(activeEnv, /^VERIFY402_NETWORKS=eip155:84532$/m);
  assert.doesNotMatch(activeEnv, /^VERIFY402_NETWORKS=eip155:8453$/m);

  const bridgeEnv = read("mcp-bridge/.env.example");
  const activeBridgeEnv = bridgeEnv
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.match(activeBridgeEnv, /^VERIFY402_NETWORKS=eip155:84532$/m);
  assert.doesNotMatch(activeBridgeEnv, /^VERIFY402_NETWORKS=eip155:8453$/m);

  const bridgeReadme = read("mcp-bridge/README.md");
  assert.match(bridgeReadme, /testnet USDC/i);
  assert.match(bridgeReadme, /eip155:84532/);
  assert.match(bridgeReadme, /Published package note/i);
  assert.doesNotMatch(bridgeReadme, /Defaults are Base mainnet/i);

  for (const name of fs.readdirSync(path.join(ROOT, "src/site"))) {
    if (!name.endsWith(".html")) continue;
    assert.doesNotMatch(
      read(`src/site/${name}`),
      /Mainnet-armed/,
      `src/site/${name} must not imply the demo is a mainnet payment service`,
    );
  }
});

test("bridge demo default is testnet, accepts the live testnet challenge, and fails closed on mainnet", () => {
  const readme = read("README.md");
  const documentedNetwork = readme.match(/"VERIFY402_NETWORKS":\s*"([^"]+)"/)?.[1];
  assert.equal(documentedNetwork, DEMO_NETWORK);

  assert.deepEqual(DEFAULT_NETWORKS, [DEMO_NETWORK]);
  assert.equal(DEFAULT_NETWORKS.includes(MAINNET_NETWORK), false);

  // Exercise the same policy builder the paid client uses, with no env
  // override. This is the runtime default, not a paragraph in a README.
  const demoPolicy = createPaymentPolicyFromEnv({
    resourcePrefix: "https://verify402.onrender.com",
    env: {},
  });

  assert.deepEqual(demoPolicy.allowedNetworks, [DEMO_NETWORK]);
  const selected = demoPolicy.filter(2, [MAINNET_REQUIREMENT, TESTNET_REQUIREMENT]);
  assert.deepEqual(selected.map((r) => r.network), [DEMO_NETWORK]);

  assert.throws(
    () => demoPolicy.filter(2, [MAINNET_REQUIREMENT]),
    /no payment on an allowed network\/payee/,
    "demo policy must refuse a mainnet-only 402",
  );

  // If a future change made mainnet the runtime default, this is the exact
  // regression: the demo's Base Sepolia challenge would be refused.
  const simulatedMainnetDefault = createPaymentPolicyFromEnv({
    resourcePrefix: "https://verify402.onrender.com",
    env: { VERIFY402_NETWORKS: MAINNET_NETWORK },
  });
  assert.throws(
    () => simulatedMainnetDefault.filter(2, [TESTNET_REQUIREMENT]),
    /no payment on an allowed network\/payee/,
    "a mainnet runtime default must fail the demo-policy test",
  );

  const explicitMainnet = createPaymentPolicyFromEnv({
    resourcePrefix: "https://verify402.onrender.com",
    env: { VERIFY402_NETWORKS: MAINNET_NETWORK },
  });
  assert.deepEqual(explicitMainnet.allowedNetworks, [MAINNET_NETWORK]);
  assert.equal(explicitMainnet.filter(2, [MAINNET_REQUIREMENT]).length, 1);

  assert.equal(
    demoPolicy.checkBeforeSign({
      paymentRequired: { resource: { url: "https://verify402.onrender.com/verify" } },
      selectedRequirements: TESTNET_REQUIREMENT,
    }),
    undefined,
  );
  assert.equal(
    demoPolicy.checkBeforeSign({
      paymentRequired: { resource: { url: "https://verify402.onrender.com/preflight" } },
      selectedRequirements: TESTNET_REQUIREMENT,
    })?.abort,
    true,
  );
});

test("payment proof documentation uses PAYMENT-SIGNATURE and preserves the legacy x-payment alias", () => {
  const readme = read("README.md");
  assert.match(readme, /PAYMENT-SIGNATURE/);
  assert.match(readme, /x-payment/);
  assert.doesNotMatch(readme, /with the `payment` header/);

  const openapi = buildOpenapi(PRICE_DEFAULTS);
  for (const route of ["/verify", "/safety", "/route", "/quotecheck", "/depth"]) {
    const names = openapi.paths[route].post.parameters.map((p) => p.name);
    assert.ok(names.includes("PAYMENT-SIGNATURE"), `${route} must document PAYMENT-SIGNATURE`);
    assert.ok(names.includes("x-payment"), `${route} must document legacy x-payment`);
  }

  const manifest = buildServiceManifest({ mode: "testnet" });
  assert.deepEqual(manifest.paymentRequirements.settlementHeaders.paymentProofHeaders, ["x-payment", "payment-signature"]);
  assert.ok(
    manifest.paymentRequirements.supportedNetworks.some((n) => n.id === "eip155:84532" && n.asset === TESTNET_USDC),
    "testnet manifest must offer Base Sepolia testnet USDC",
  );
  assert.ok(
    !manifest.paymentRequirements.supportedNetworks.some((n) => n.id === "eip155:8453"),
    "testnet manifest must not advertise a mainnet settlement rail",
  );

  const example = openapi.paths["/preflight"].post.requestBody.content["application/json"].example;
  assert.equal(example.payment.network, "eip155:84532");
  assert.equal(example.payment.asset, TESTNET_USDC);
});

test("public install docs pin the published package 1.0.5", () => {
  for (const rel of [
    "README.md",
    "examples/ONBOARDING.md",
    "mcp-bridge/llms-install.md",
    "src/site/mcp.html",
  ]) {
    const text = read(rel);
    assert.doesNotMatch(text, /releases\/download\/mcp-v1\.0\.4/, `${rel} must not link a missing release asset`);
    assert.match(
      text,
      new RegExp(`verify402-mcp@${PUBLISHED_VERSION.replaceAll(".", "\\.")}`),
      `${rel} must pin the published npm package`,
    );
  }

  const manifest = buildServiceManifest({ mode: "testnet" });
  const mcp = manifest.integrations.mcp;
  const tarball = new URL(mcp.tarballUrl);
  assert.equal(tarball.hostname, "registry.npmjs.org");
  assert.match(
    tarball.pathname,
    new RegExp(`verify402-mcp-${PUBLISHED_VERSION.replaceAll(".", "\\.")}\\.tgz$`),
  );
  assert.equal(mcp.quickInstallCommand, `npx -y verify402-mcp@${PUBLISHED_VERSION}`);
  assert.equal(mcp.publishedVersion, PUBLISHED_VERSION);
  assert.equal(
    Object.hasOwn(mcp, "plannedTarballUrl"),
    false,
    "the published manifest must not carry planned-only fields",
  );

  const registry = new URL(mcp.registryUrl);
  assert.equal(registry.hostname, "registry.modelcontextprotocol.io");
  assert.match(registry.pathname, /\/versions$/, "registry URL must resolve before and after the manual publish");
});

test("public surfaces describe 1.0.5 as published and never link a non-existent tag", () => {
  for (const rel of [
    "README.md",
    "examples/ONBOARDING.md",
    "mcp-bridge/llms-install.md",
    "src/site/mcp.html",
  ]) {
    const text = read(rel);
    assert.match(text, /published/i, `${rel} must describe the release as published`);
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.includes(RELEASE_VERSION)) continue;
      assert.doesNotMatch(
        line,
        /candidate|unpublished|not published yet|planned|after publication|after the npm publish|after its npm artifact/i,
        `${rel}:${index + 1} must not describe published ${RELEASE_VERSION} as a candidate: ${line.trim()}`,
      );
    }
    assert.doesNotMatch(text, /releases\/tag\/mcp-v1\.0\.5/, `${rel} must not link a tag that does not exist`);
  }
});

test("registry metadata describes the published 1.0.5 package without claiming registry publication", () => {
  const server = json("server.json");
  assert.equal(server.version, RELEASE_VERSION);
  const pkg = server.packages[0];
  assert.equal(pkg.version, RELEASE_VERSION);
  const description = pkg.environmentVariables.find((entry) => entry.name === "EVM_PRIVATE_KEY").description;
  assert.match(description, new RegExp(RELEASE_VERSION.replaceAll(".", "\\.")));
  assert.match(description, /Base Sepolia/);
  assert.match(description, /Base mainnet/);
  assert.doesNotMatch(description, /unpublished|candidate/i);
  assert.doesNotMatch(description, /defaults to Base mainnet/i, "this release must not claim a mainnet default");
  assert.match(description, /not enabled by this release/i);
  assert.doesNotMatch(
    `${server.description} ${description}`,
    /registry entry (?:is|has been) published|listed on the .*registry/i,
    "server.json must not claim the registry publication is complete",
  );
});

test("every advertised paid MCP tool is bound to one paid route in the bridge", async () => {
  const { PAID_TOOL_ROUTES } = await import("../mcp-bridge/index.mjs");
  const manifest = buildServiceManifest({ mode: "testnet" });
  const paid = manifest.integrations.mcp.tools
    .filter((tool) => tool.type === "paid")
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(Object.keys(PAID_TOOL_ROUTES).sort(), paid);
  const values = Object.values(PAID_TOOL_ROUTES);
  assert.equal(new Set(values).size, values.length, "each paid tool must have a distinct route");
});

test("the release runbook sequences validation, artifact, npm, registry, then deploy", () => {
  const runbook = read("PUBLISH_STEPS_FOR_ME.md");
  const steps = [
    "Validate and inspect the release",
    "Create and verify the npm 1.0.5 artifact",
    "Publish npm 1.0.5",
    "only when the npm 1.0.5 artifact exists",
    "Verify the actual 1.0.5 registry version",
    "Deploy only after",
  ];
  let previous = -1;
  for (const step of steps) {
    const index = runbook.indexOf(step);
    assert.ok(index >= 0, `runbook must contain the step: ${step}`);
    assert.ok(index > previous, `runbook step is out of order: ${step}`);
    previous = index;
  }
  assert.doesNotMatch(runbook, /missing\s+(registry\s+)?default/i, "obsolete missing-default instruction must be gone");
  assert.doesNotMatch(
    runbook,
    /Status today: the working tree is an \*\*unpublished `1\.0\.5` candidate\*\*/i,
    "the runbook must not describe the published release as a current unpublished candidate",
  );
  assert.match(runbook, /npm `verify402-mcp@1\.0\.5` is \*\*published\*\*/i);
  assert.match(runbook, /MCP Registry publication of `1\.0\.5` is \*\*pending and unverified\*\*/i);
  assert.match(runbook, /Render deployment of `1\.0\.5` is \*\*pending and unverified\*\*/i);
  assert.match(runbook, /Transition the release metadata to published 1\.0\.5 — completed/);
});

test("post-deploy is testnet-only and rejects unsupported modes before network access", () => {
  assert.equal(resolveExpectedVersion(undefined), RELEASE_VERSION);
  assert.equal(resolveExpectedVersion("  "), RELEASE_VERSION);
  assert.equal(resolveExpectedVersion("1.0.5"), "1.0.5");
  assert.equal(resolveExpectedMode(undefined), "testnet");
  assert.equal(resolveExpectedMode(" testnet "), "testnet");

  assert.doesNotThrow(() => assertSupportedExpectedMode("testnet"));
  assert.throws(
    () => assertSupportedExpectedMode("mainnet"),
    /unsupported EXPECTED_MODE "mainnet"/,
    "mainnet post-deploy checks are not implemented and must be refused",
  );
  assert.throws(
    () => assertSupportedExpectedMode("staging"),
    /unsupported EXPECTED_MODE "staging"/,
    "any unsupported mode must be refused rather than guessed",
  );
});

test("post-deploy smoke environment is forced free-only and strips payment credentials", () => {
  const parent = {
    SMOKE_PAID: "1",
    EVM_PRIVATE_KEY: "0x" + "11".repeat(32),
    CDP_API_KEY_SECRET: "not-a-real-secret",
    SMOKE_BASE_URL: "https://verify402.onrender.com",
    AGENT_URL: "https://verify402.onrender.com",
  };

  const free = buildFreeSmokeEnv(parent);

  assert.equal(free.SMOKE_PAID, "0", "SMOKE_PAID must be forced off");
  for (const name of [
    "EVM_PRIVATE_KEY",
    "CDP_API_KEY_SECRET",
  ]) {
    assert.equal(Object.hasOwn(free, name), false, `${name} must not reach the smoke child`);
  }
  assert.equal(free.SMOKE_BASE_URL, parent.SMOKE_BASE_URL);
  assert.equal(free.AGENT_URL, parent.AGENT_URL);

  // The helper must copy, never mutate, the caller's environment.
  assert.equal(parent.SMOKE_PAID, "1");
  assert.ok(Object.hasOwn(parent, "EVM_PRIVATE_KEY"));
});
