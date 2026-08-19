#!/usr/bin/env node

import {
  assertClineMcpServerLaunch,
  CLINE_DISTRIBUTION,
  CLINE_INSTALL_ROOT_PLACEHOLDER,
  renderClineMcpSettings,
} from "../adapters/cline/distribution.mjs";
import { assertClineSkillFrontmatter } from "../adapters/cline/skill-validation.mjs";
import {
  assertSingleCanonicalEntry,
  validateHarnessPackage,
} from "./harness-package-validation.mjs";

const probeEnvironment = {
  ...process.env,
  GITLAB_TOKEN: "cline-adapter-smoke-test",
  GITLAB_URL: "https://gitlab.example.com",
};

const result = await validateHarnessPackage({
  artifactName: CLINE_DISTRIBUTION.artifactName,
  packageFiles: CLINE_DISTRIBUTION.packageFiles,
  distributionMetadataPath: CLINE_DISTRIBUTION.files.distributionMetadata,
  harnessLabel: "Cline",
  clientNamePrefix: "cline",
  probeEnvironment,
  excludedPackagePaths: [".clinerules"],
  validateSkill: ({ skillName, skillText }) =>
    assertClineSkillFrontmatter(skillText, skillName),
  validateHarness: async ({
    canonical,
    packageRoot,
    rootPath,
    readPackageJson,
  }) => {
    const templateSettings = await readPackageJson(
      CLINE_DISTRIBUTION.files.mcpSettingsTemplate,
    );
    assertSingleCanonicalEntry(
      templateSettings.mcpServers,
      canonical.name,
      "Packaged Cline MCP settings template",
    );
    assertClineMcpServerLaunch(
      templateSettings.mcpServers[canonical.name],
      canonical,
      CLINE_INSTALL_ROOT_PLACEHOLDER,
    );

    const installedSettings = renderClineMcpSettings(canonical, packageRoot);
    assertSingleCanonicalEntry(
      installedSettings.mcpServers,
      canonical.name,
      "Rendered packaged Cline MCP settings",
    );
    const installedServer = installedSettings.mcpServers[canonical.name];
    assertClineMcpServerLaunch(installedServer, canonical, packageRoot);

    const canonicalSettings = renderClineMcpSettings(canonical, rootPath);
    return {
      canonicalServer: canonicalSettings.mcpServers[canonical.name],
      installedServer,
    };
  },
});

console.log(
  `Cline package validation passed: ${CLINE_DISTRIBUTION.artifactName} contains ${result.skillDirectories.length} canonical Skills and ${result.tools.length} canonical MCP tools over stdio protocol ${result.protocolVersion}; ${result.archiveName} is reproducible with ${result.checksumName}.`,
);
