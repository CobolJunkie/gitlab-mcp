#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCanonicalDistribution } from "./lib/distribution-config.mjs";
import { probeStdioMcp } from "./lib/stdio-mcp-probe.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = dirname(dirname(scriptPath));
const canonical = normalizeCanonicalDistribution(
  JSON.parse(await readFile(join(pluginRoot, "distribution.json"), "utf8")),
);
const mcpConfig = JSON.parse(
  await readFile(join(pluginRoot, ".mcp.json"), "utf8"),
);
const pluginMetadata = JSON.parse(
  await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
);
const launchArgs = mcpConfig.mcpServers[canonical.name].args.map((value) =>
  value.replaceAll("${PLUGIN_ROOT}", pluginRoot),
);
const { tools, runtimeInfo } = await probeStdioMcp({
  command: process.execPath,
  args: launchArgs,
  env: {
    ...process.env,
    GITLAB_TOKEN: "extracted-bundle-smoke-test",
    GITLAB_URL: "https://gitlab.example.com",
  },
  clientInfo: { name: "extracted-bundle-smoke", version: "1.0.0" },
});

assert.equal(tools.length, 175);
assert.ok(tools.some((tool) => tool.name === "create_destructive_commit"));
assert.deepEqual(runtimeInfo.structuredContent.result.plugin, {
  name: pluginMetadata.name,
  version: pluginMetadata.version,
});

console.log(
  "Extracted Codex distribution smoke passed with 175 tools and preserved provenance.",
);
