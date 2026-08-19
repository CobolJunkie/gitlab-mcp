import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import packageMetadata from "../package.json" with { type: "json" };
import {
  normalizeCanonicalDistribution,
  resolveRepositoryPath,
} from "./lib/distribution-config.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = dirname(dirname(scriptPath));
const canonical = normalizeCanonicalDistribution(
  JSON.parse(
    await readFile(new URL("../distribution.json", import.meta.url), "utf8"),
  ),
);
const bundlePath = resolveRepositoryPath(
  pluginRoot,
  canonical.mcp.bundle,
  "distribution mcp.bundle",
);
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
);
childEnv.GITLAB_TOKEN = "bundle-smoke-test";
childEnv.GITLAB_URL = "https://gitlab.example.com";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundlePath, "--stdio"],
  env: childEnv,
  stderr: "inherit",
});
const client = new Client({
  name: "gitlab-plugin-bundle-smoke-test",
  version: "1.0.0",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(
    listed.tools.length === 147,
    `Expected 147 bundled tools, got ${listed.tools.length}.`,
  );
  const runtime = await client.callTool({
    name: "get_runtime_info",
    arguments: {},
  });
  assert.equal(runtime.isError, undefined);
  assert.deepEqual(runtime.structuredContent.result.plugin, {
    name: "gitlab",
    version: packageMetadata.version,
  });
  assert.equal(runtime.structuredContent.result.toolInventory.count, 147);
  assert.match(
    runtime.structuredContent.result.toolInventory.fingerprint,
    /^sha256:[a-f0-9]{64}$/,
  );
  console.log(
    `Bundled MCP smoke test passed with ${listed.tools.length} tools.`,
  );
} finally {
  await client.close().catch(() => undefined);
}

const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const address = probe.address();
assert.equal(typeof address, "object");
const httpPort = address.port;
await new Promise((resolve) => probe.close(resolve));

const httpEnv = {
  ...childEnv,
  MCP_HOST: "127.0.0.1",
  MCP_PORT: String(httpPort),
};
const httpChild = spawn(process.execPath, [bundlePath, "--http"], {
  env: httpEnv,
  stdio: ["ignore", "ignore", "pipe"],
});
let httpStderr = "";
httpChild.stderr.on("data", (chunk) => {
  httpStderr += chunk.toString();
});

try {
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      health = await fetch(`http://127.0.0.1:${httpPort}/health`);
      if (health.ok) {
        break;
      }
    } catch {
      await delay(50);
    }
  }
  assert.ok(health?.ok, `Bundled HTTP server failed to start: ${httpStderr}`);
  const body = await health.json();
  assert.equal(body.service, "gitlab-mcp");
  console.log("Bundled MCP HTTP health check passed.");
} finally {
  httpChild.kill();
}
