export const CLINE_INSTALL_ROOT_PLACEHOLDER = "<ABSOLUTE_GITLAB_MCP_ROOT>";

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

function normalizeInstallationRoot(installationRoot) {
  if (installationRoot === CLINE_INSTALL_ROOT_PLACEHOLDER) {
    return installationRoot;
  }
  if (typeof installationRoot !== "string" || !installationRoot.trim()) {
    throw new TypeError(
      "Cline installation root must be a non-empty absolute path.",
    );
  }

  const normalized = installationRoot.trim().replaceAll("\\", "/");
  const driveRootLength = windowsRootLength(normalized);
  const rootLength = driveRootLength || (normalized.startsWith("//") ? 2 : 1);
  const isAbsolute = driveRootLength > 0 || normalized.startsWith("/");
  if (!isAbsolute) {
    throw new TypeError(
      "Cline installation root must be a non-empty absolute path.",
    );
  }

  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === "/") {
    end -= 1;
  }
  return normalized.slice(0, end);
}

function bundlePath(canonical, installationRoot) {
  const root = normalizeInstallationRoot(installationRoot);
  const separator = root.endsWith("/") ? "" : "/";
  return `${root}${separator}${canonical.mcp.bundle}`;
}

const clineFiles = Object.freeze({
  mcpSettingsTemplate: "adapters/cline/cline_mcp_settings.template.json",
  readme: "adapters/cline/README.md",
  distributionMetadata: "distribution.json",
  license: "LICENSE",
});
const clinePackageFiles = Object.freeze(Object.values(clineFiles));
const clineSkills = Object.freeze({
  projectDirectory: ".cline/skills",
  globalDirectory: "~/.cline/skills",
});

export const CLINE_DISTRIBUTION = Object.freeze({
  id: "cline",
  artifactName: "gitlab-cline-mcp",
  generatedFiles: Object.freeze([clineFiles.mcpSettingsTemplate]),
  packageFiles: clinePackageFiles,
  files: clineFiles,
  skills: clineSkills,
});

export function expectedClineMcpServer(
  canonical,
  installationRoot = CLINE_INSTALL_ROOT_PLACEHOLDER,
) {
  return {
    command: "node",
    args: [bundlePath(canonical, installationRoot), "--stdio"],
  };
}

export function assertClineMcpServerLaunch(
  server,
  canonical,
  installationRoot = CLINE_INSTALL_ROOT_PLACEHOLDER,
) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new TypeError("Cline MCP server must be an object.");
  }

  const expected = expectedClineMcpServer(canonical, installationRoot);
  const argsMatch =
    Array.isArray(server.args) &&
    server.args.length === expected.args.length &&
    server.args.every((argument, index) => argument === expected.args[index]);
  if (server.command !== expected.command || !argsMatch) {
    throw new Error("Cline MCP server launch must match the canonical launch.");
  }
  return server;
}

export function renderClineMcpSettings(
  canonical,
  installationRoot = CLINE_INSTALL_ROOT_PLACEHOLDER,
) {
  return {
    mcpServers: {
      [canonical.name]: expectedClineMcpServer(canonical, installationRoot),
    },
  };
}

export function renderClineDistributionFiles({ canonical }) {
  const settings = renderClineMcpSettings(canonical);
  return {
    [CLINE_DISTRIBUTION.files.mcpSettingsTemplate]:
      `${JSON.stringify(settings, null, 2)}\n`,
  };
}
