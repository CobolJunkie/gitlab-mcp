export const CLAUDE_PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";
export const CLAUDE_PLUGIN_MANIFEST_SCHEMA =
  "https://json.schemastore.org/claude-code-plugin-manifest.json";

function packageFile(source, target) {
  return Object.freeze({ source, target });
}

function windowsRootLength(path) {
  if (path.length < 3 || path[1] !== ":" || path[2] !== "/") {
    return 0;
  }
  const firstCodePoint = path.codePointAt(0);
  const isAsciiLetter =
    (firstCodePoint >= 65 && firstCodePoint <= 90) ||
    (firstCodePoint >= 97 && firstCodePoint <= 122);
  return isAsciiLetter ? 3 : 0;
}

function normalizePluginRoot(pluginRoot) {
  if (pluginRoot === CLAUDE_PLUGIN_ROOT_PLACEHOLDER) {
    return pluginRoot;
  }
  if (typeof pluginRoot !== "string" || !pluginRoot.trim()) {
    throw new TypeError(
      "Claude plugin root must be a non-empty absolute path.",
    );
  }

  const normalized = pluginRoot.trim().replaceAll("\\", "/");
  const driveRootLength = windowsRootLength(normalized);
  const rootLength = driveRootLength || (normalized.startsWith("//") ? 2 : 1);
  const isAbsolute = driveRootLength > 0 || normalized.startsWith("/");
  if (!isAbsolute) {
    throw new TypeError(
      "Claude plugin root must be a non-empty absolute path.",
    );
  }

  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === "/") {
    end -= 1;
  }
  return normalized.slice(0, end);
}

function bundlePath(canonical, pluginRoot) {
  const root = normalizePluginRoot(pluginRoot);
  const separator = root.endsWith("/") ? "" : "/";
  return `${root}${separator}${canonical.mcp.bundle}`;
}

function serializeClaudeMcpConfig(canonical) {
  const server = expectedClaudeMcpServer(canonical);
  const serializedArgs = server.args
    .map((argument) => JSON.stringify(argument))
    .join(", ");

  return [
    "{",
    '  "mcpServers": {',
    `    ${JSON.stringify(canonical.name)}: {`,
    `      "command": ${JSON.stringify(server.command)},`,
    `      "args": [${serializedArgs}]`,
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

const claudeFiles = Object.freeze({
  manifest: "adapters/claude/.claude-plugin/plugin.json",
  mcpConfig: "adapters/claude/.mcp.json",
  readme: "adapters/claude/README.md",
  distributionMetadata: "distribution.json",
  license: "LICENSE",
});

const claudePackagePaths = Object.freeze({
  manifest: ".claude-plugin/plugin.json",
  mcpConfig: ".mcp.json",
  readme: "README.md",
  distributionMetadata: "distribution.json",
  license: "LICENSE",
});

const claudePackageFiles = Object.freeze([
  packageFile(claudeFiles.manifest, claudePackagePaths.manifest),
  packageFile(claudeFiles.mcpConfig, claudePackagePaths.mcpConfig),
  packageFile(claudeFiles.readme, claudePackagePaths.readme),
  packageFile(
    claudeFiles.distributionMetadata,
    claudePackagePaths.distributionMetadata,
  ),
  packageFile(claudeFiles.license, claudePackagePaths.license),
]);

export const CLAUDE_DISTRIBUTION = Object.freeze({
  id: "claude",
  artifactName: "gitlab-claude-code-mcp",
  generatedFiles: Object.freeze([claudeFiles.manifest, claudeFiles.mcpConfig]),
  packageFiles: claudePackageFiles,
  files: claudeFiles,
  packagePaths: claudePackagePaths,
});

export function expectedClaudeMcpServer(
  canonical,
  pluginRoot = CLAUDE_PLUGIN_ROOT_PLACEHOLDER,
) {
  return {
    command: "node",
    args: [bundlePath(canonical, pluginRoot), "--stdio"],
  };
}

export function assertClaudeMcpServerLaunch(
  server,
  canonical,
  pluginRoot = CLAUDE_PLUGIN_ROOT_PLACEHOLDER,
) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new TypeError("Claude MCP server must be an object.");
  }

  const expected = expectedClaudeMcpServer(canonical, pluginRoot);
  const argsMatch =
    Array.isArray(server.args) &&
    server.args.length === expected.args.length &&
    server.args.every((argument, index) => argument === expected.args[index]);

  if (server.command !== expected.command || !argsMatch) {
    throw new Error(
      "Claude MCP server launch must match the canonical launch.",
    );
  }

  return server;
}

export function renderClaudePluginManifest(canonical) {
  return {
    $schema: CLAUDE_PLUGIN_MANIFEST_SCHEMA,
    name: canonical.name,
    version: canonical.version,
    description: canonical.description,
    license: canonical.license,
    mcpServers: `./${CLAUDE_DISTRIBUTION.packagePaths.mcpConfig}`,
  };
}

export function assertClaudePluginManifest(manifest, canonical) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Claude plugin manifest must be an object.");
  }

  const expected = renderClaudePluginManifest(canonical);
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) {
      throw new Error(
        `Claude plugin manifest ${field} must match the canonical distribution.`,
      );
    }
  }

  return manifest;
}

export function renderClaudeMcpConfig(canonical) {
  return {
    mcpServers: {
      [canonical.name]: expectedClaudeMcpServer(canonical),
    },
  };
}

export function renderClaudeDistributionFiles({ canonical }) {
  return {
    [CLAUDE_DISTRIBUTION.files.manifest]:
      `${JSON.stringify(renderClaudePluginManifest(canonical), null, 2)}\n`,
    [CLAUDE_DISTRIBUTION.files.mcpConfig]: serializeClaudeMcpConfig(canonical),
  };
}
