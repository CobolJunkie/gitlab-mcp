#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCodexMcpServerLaunch,
  CODEX_DISTRIBUTION,
  isValidCodexManifestVersion,
} from "../adapters/codex/distribution.mjs";
import { assertSingleCanonicalEntry } from "./harness-package-validation.mjs";
import { normalizeCanonicalDistribution } from "./lib/distribution-config.mjs";
import { probeStdioMcp } from "./lib/stdio-mcp-probe.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const canonical = normalizeCanonicalDistribution(
  JSON.parse(
    await readFile(new URL("../distribution.json", import.meta.url), "utf8"),
  ),
);
const manifest = JSON.parse(
  await readFile(
    new URL(`../${CODEX_DISTRIBUTION.files.manifest}`, import.meta.url),
    "utf8",
  ),
);
const mcpConfig = JSON.parse(
  await readFile(
    new URL(`../${CODEX_DISTRIBUTION.files.mcpConfig}`, import.meta.url),
    "utf8",
  ),
);
const appConfig = JSON.parse(
  await readFile(
    new URL(`../${CODEX_DISTRIBUTION.files.appConfig}`, import.meta.url),
    "utf8",
  ),
);

assert.equal(manifest.name, canonical.name);
assert.ok(
  isValidCodexManifestVersion(canonical.version, manifest.version),
  "Codex manifest version must match the canonical base version or valid +codex.* build metadata.",
);
assert.equal(manifest.description, canonical.description);
assert.equal(manifest.license, canonical.license);
assert.equal(manifest.skills, `./${canonical.skills.directory}/`);
assert.equal(manifest.mcpServers, `./${CODEX_DISTRIBUTION.files.mcpConfig}`);

assertSingleCanonicalEntry(
  mcpConfig.mcpServers,
  canonical.name,
  "Codex MCP server configuration",
);
const configuredServer = mcpConfig.mcpServers[canonical.name];
assertCodexMcpServerLaunch(configuredServer, canonical);
assertSingleCanonicalEntry(
  appConfig.apps,
  canonical.name,
  "Codex app configuration",
);

const preload = await stat(join(rootPath, CODEX_DISTRIBUTION.files.preload));
assert.ok(preload.isFile(), "Codex adapter preload must exist.");
const skills = await stat(join(rootPath, canonical.skills.directory));
assert.ok(
  skills.isDirectory(),
  "Canonical Skills directory must exist for Codex.",
);
const bundle = await stat(join(rootPath, canonical.mcp.bundle));
assert.ok(
  bundle.isFile(),
  "Canonical MCP bundle must exist for Codex validation.",
);

const normalizedRoot = rootPath.replaceAll("\\", "/");
const pluginRoot = normalizedRoot.endsWith("/")
  ? normalizedRoot.slice(0, -1)
  : normalizedRoot;
const installedArgs = configuredServer.args.map((argument) =>
  argument.replaceAll("${PLUGIN_ROOT}", pluginRoot),
);
const probeEnvironment = {
  ...process.env,
  GITLAB_TOKEN: "codex-adapter-smoke-test",
  GITLAB_URL: "https://gitlab.example.com",
};
const [{ tools: canonicalTools }, { protocolVersion, tools, runtimeInfo }] =
  await Promise.all([
    probeStdioMcp({
      command: process.execPath,
      args: [join(rootPath, canonical.mcp.bundle), "--stdio"],
      env: probeEnvironment,
      clientInfo: { name: "codex-canonical-smoke", version: "1.0.0" },
    }),
    probeStdioMcp({
      command: process.execPath,
      args: installedArgs,
      env: probeEnvironment,
      clientInfo: { name: "codex-adapter-smoke", version: "1.0.0" },
    }),
  ]);

const toolNames = (list) =>
  list
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));
assert.deepEqual(
  toolNames(tools),
  toolNames(canonicalTools),
  "Codex MCP tool inventory must match the canonical bundle.",
);
assert.deepEqual(runtimeInfo.structuredContent.result.plugin, {
  name: canonical.name,
  version: manifest.version,
});

console.log(
  `Codex adapter validation passed: ${tools.length} canonical MCP tools over stdio protocol ${protocolVersion} with canonical Skills and runtime provenance.`,
);
