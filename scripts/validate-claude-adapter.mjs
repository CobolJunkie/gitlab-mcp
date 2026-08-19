#!/usr/bin/env node

import {
  assertClaudeMcpServerLaunch,
  assertClaudePluginManifest,
  CLAUDE_DISTRIBUTION,
  expectedClaudeMcpServer,
} from "../adapters/claude/distribution.mjs";
import {
  assertSingleCanonicalEntry,
  validateHarnessPackage,
} from "./harness-package-validation.mjs";

const probeEnvironment = {
  ...process.env,
  GITLAB_TOKEN: "claude-adapter-smoke-test",
  GITLAB_URL: "https://gitlab.example.com",
};

const result = await validateHarnessPackage({
  artifactName: CLAUDE_DISTRIBUTION.artifactName,
  packageFiles: CLAUDE_DISTRIBUTION.packageFiles,
  distributionMetadataPath:
    CLAUDE_DISTRIBUTION.packagePaths.distributionMetadata,
  harnessLabel: "Claude Code",
  clientNamePrefix: "claude",
  probeEnvironment,
  excludedPackagePaths: ["adapters"],
  validateHarness: async ({
    canonical,
    packageRoot,
    rootPath,
    readPackageJson,
  }) => {
    const pluginManifest = await readPackageJson(
      CLAUDE_DISTRIBUTION.packagePaths.manifest,
    );
    assertClaudePluginManifest(pluginManifest, canonical);

    const mcpConfig = await readPackageJson(
      CLAUDE_DISTRIBUTION.packagePaths.mcpConfig,
    );
    assertSingleCanonicalEntry(
      mcpConfig.mcpServers,
      canonical.name,
      "Packaged Claude MCP configuration",
    );
    assertClaudeMcpServerLaunch(
      mcpConfig.mcpServers[canonical.name],
      canonical,
    );

    return {
      canonicalServer: expectedClaudeMcpServer(canonical, rootPath),
      installedServer: expectedClaudeMcpServer(canonical, packageRoot),
    };
  },
});

console.log(
  `Claude Code package validation passed: ${CLAUDE_DISTRIBUTION.artifactName} contains ${result.skillDirectories.length} canonical Skills and ${result.tools.length} canonical MCP tools over stdio protocol ${result.protocolVersion}; ${result.archiveName} is reproducible with ${result.checksumName}.`,
);
