function packageFile(source, target) {
  return Object.freeze({ source, target });
}

function requireMcpSdkVersion(packageMetadata) {
  const version = packageMetadata?.dependencies?.["@modelcontextprotocol/sdk"];
  if (typeof version !== "string" || !version.trim()) {
    throw new TypeError(
      "Root package metadata must provide an @modelcontextprotocol/sdk dependency for the Pi package.",
    );
  }
  return version;
}

const piFiles = Object.freeze({
  manifest: "adapters/pi/package.json",
  extension: "adapters/pi/extensions/gitlab-mcp.mjs",
  bridge: "adapters/pi/mcp-bridge.mjs",
  readme: "adapters/pi/README.md",
  distributionMetadata: "distribution.json",
  license: "LICENSE",
});

const piPackagePaths = Object.freeze({
  manifest: "package.json",
  extension: "extensions/gitlab-mcp.mjs",
  bridge: "mcp-bridge.mjs",
  readme: "README.md",
  distributionMetadata: "distribution.json",
  license: "LICENSE",
});

const piPackageFiles = Object.freeze([
  packageFile(piFiles.manifest, piPackagePaths.manifest),
  packageFile(piFiles.extension, piPackagePaths.extension),
  packageFile(piFiles.bridge, piPackagePaths.bridge),
  packageFile(piFiles.readme, piPackagePaths.readme),
  packageFile(
    piFiles.distributionMetadata,
    piPackagePaths.distributionMetadata,
  ),
  packageFile(piFiles.license, piPackagePaths.license),
]);

export const PI_DISTRIBUTION = Object.freeze({
  id: "pi",
  artifactName: "gitlab-pi-mcp",
  generatedFiles: Object.freeze([piFiles.manifest]),
  packageFiles: piPackageFiles,
  files: piFiles,
  packagePaths: piPackagePaths,
});

export function renderPiPackageManifest(canonical, packageMetadata) {
  return {
    name: PI_DISTRIBUTION.artifactName,
    version: canonical.version,
    description: canonical.description,
    license: canonical.license,
    type: "module",
    keywords: ["pi-package"],
    engines: {
      node: ">=22.0.0",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": requireMcpSdkVersion(packageMetadata),
    },
    pi: {
      extensions: [`./${PI_DISTRIBUTION.packagePaths.extension}`],
      skills: [`./${canonical.skills.directory}`],
    },
  };
}

export function renderPiDistributionFiles({ canonical, packageMetadata }) {
  return {
    [PI_DISTRIBUTION.files.manifest]: `${JSON.stringify(
      renderPiPackageManifest(canonical, packageMetadata),
      null,
      2,
    )}\n`,
  };
}
