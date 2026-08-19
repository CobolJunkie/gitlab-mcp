const JSON_INDENT = 2;
const CODEX_VERSION_BUILD_PREFIX = "+codex.";
const SEMVER_BUILD_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

export function isValidCodexManifestVersion(baseVersion, version) {
  if (version === baseVersion) {
    return true;
  }
  if (typeof version !== "string") {
    return false;
  }

  const qualifiedPrefix = `${baseVersion}${CODEX_VERSION_BUILD_PREFIX}`;
  if (!version.startsWith(qualifiedPrefix)) {
    return false;
  }

  const qualifier = version.slice(qualifiedPrefix.length);
  for (const identifier of qualifier.split(".")) {
    if (!identifier || !SEMVER_BUILD_IDENTIFIER_PATTERN.test(identifier)) {
      return false;
    }
  }
  return true;
}

function codexVersion(baseVersion, currentVersion) {
  const qualifierIndex =
    typeof currentVersion === "string" ? currentVersion.indexOf("+") : -1;
  const version =
    qualifierIndex === -1
      ? baseVersion
      : `${baseVersion}${currentVersion.slice(qualifierIndex)}`;

  if (!isValidCodexManifestVersion(baseVersion, version)) {
    throw new TypeError(
      "Codex manifest version build metadata must use +codex.<qualifier> with valid SemVer build identifiers.",
    );
  }
  return version;
}

function canonicalNamedEntry(entries, canonicalName, label) {
  const names = Object.keys(entries);
  if (names.length !== 1) {
    throw new Error(`${label} must contain exactly one entry.`);
  }

  const existingName = names[0];
  const entry = entries[existingName];
  if (existingName === canonicalName) {
    return entry;
  }

  delete entries[existingName];
  entries[canonicalName] = entry;
  return entry;
}

export const CODEX_DISTRIBUTION = deepFreeze({
  id: "codex",
  artifactName: "gitlab-codex-plugin",
  generatedFiles: [".codex-plugin/plugin.json", ".mcp.json", ".app.json"],
  files: {
    manifest: ".codex-plugin/plugin.json",
    mcpConfig: ".mcp.json",
    appConfig: ".app.json",
    preload: "adapters/codex/preload.mjs",
  },
});

export function expectedCodexMcpServer(canonical) {
  return {
    command: "node",
    args: [
      "--import",
      `\${PLUGIN_ROOT}/${CODEX_DISTRIBUTION.files.preload}`,
      `\${PLUGIN_ROOT}/${canonical.mcp.bundle}`,
      "--stdio",
    ],
  };
}

export function assertCodexMcpServerLaunch(server, canonical) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new TypeError("Codex MCP server must be an object.");
  }

  const expected = expectedCodexMcpServer(canonical);
  if (server.command !== expected.command) {
    throw new Error(
      "Codex MCP server command must match the canonical launch.",
    );
  }
  if (
    !Array.isArray(server.args) ||
    server.args.length !== expected.args.length ||
    server.args.some((argument, index) => argument !== expected.args[index])
  ) {
    throw new Error("Codex MCP server args must match the canonical launch.");
  }

  return server;
}

function isCodexBundleArgument(argument) {
  if (typeof argument !== "string") return false;
  const prefix = "${PLUGIN_ROOT}/server/dist/";
  const suffix = ".cjs";
  if (!argument.startsWith(prefix) || !argument.endsWith(suffix)) {
    return false;
  }
  const filename = argument.slice(prefix.length, -suffix.length);
  return (
    filename.length > 0 && !filename.includes("/") && !filename.includes("\\")
  );
}

function canonicalCodexServer(mcpConfig, canonical) {
  if (
    !mcpConfig?.mcpServers ||
    typeof mcpConfig.mcpServers !== "object" ||
    Array.isArray(mcpConfig.mcpServers)
  ) {
    throw new TypeError("Codex MCP config requires an mcpServers object.");
  }

  const server = canonicalNamedEntry(
    mcpConfig.mcpServers,
    canonical.name,
    "Cannot determine which Codex MCP server; Codex MCP server configuration",
  );
  if (!Array.isArray(server.args)) {
    throw new TypeError("Codex MCP server requires an args array.");
  }

  const bundleArgumentIndexes = server.args
    .map((argument, index) => (isCodexBundleArgument(argument) ? index : -1))
    .filter((index) => index !== -1);
  if (bundleArgumentIndexes.length !== 1) {
    throw new Error(
      "Codex MCP server must contain exactly one server/dist/*.cjs bundle argument.",
    );
  }

  const expected = expectedCodexMcpServer(canonical);
  server.command = expected.command;
  server.args = expected.args;
  assertCodexMcpServerLaunch(server, canonical);
}

function canonicalApp(appConfig, canonical) {
  if (
    !appConfig?.apps ||
    typeof appConfig.apps !== "object" ||
    Array.isArray(appConfig.apps)
  ) {
    throw new TypeError("App config requires an apps object.");
  }
  canonicalNamedEntry(
    appConfig.apps,
    canonical.name,
    "Cannot determine which app entry; Codex app configuration",
  );
}

export function renderCodexDistributionFiles({
  canonical,
  codexManifest: codexManifestInput,
  codexMcpConfig: codexMcpConfigInput,
  appConfig: appConfigInput,
}) {
  const codexManifest = clone(codexManifestInput);
  const codexMcpConfig = clone(codexMcpConfigInput);
  const appConfig = clone(appConfigInput);

  codexManifest.name = canonical.name;
  codexManifest.version = codexVersion(
    canonical.version,
    codexManifest.version,
  );
  codexManifest.description = canonical.description;
  codexManifest.license = canonical.license;
  codexManifest.skills = `./${canonical.skills.directory}/`;
  codexManifest.mcpServers = `./${CODEX_DISTRIBUTION.files.mcpConfig}`;

  canonicalCodexServer(codexMcpConfig, canonical);
  canonicalApp(appConfig, canonical);

  return {
    [CODEX_DISTRIBUTION.files.manifest]: serializeJson(codexManifest),
    [CODEX_DISTRIBUTION.files.mcpConfig]: serializeJson(codexMcpConfig),
    [CODEX_DISTRIBUTION.files.appConfig]: serializeJson(appConfig),
  };
}
