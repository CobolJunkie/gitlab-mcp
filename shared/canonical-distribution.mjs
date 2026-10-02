const MCP_BUNDLE_PATTERN = /^server\/dist\/[A-Za-z0-9][A-Za-z0-9._-]*\.cjs$/;
const SEMVER_NUMERIC_IDENTIFIER_PATTERN = /^(?:0|[1-9]\d*)$/;
const SEMVER_PRERELEASE_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/;

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireRepositoryRelativePath(value, label) {
  const normalized = requireNonEmptyString(value, label).replaceAll("\\", "/");
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "/") {
    end -= 1;
  }
  const trimmed = normalized.slice(0, end);
  const segments = trimmed.split("/");
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:\//.test(trimmed) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a repository-relative path.`);
  }
  return trimmed;
}

function requireMcpBundlePath(value) {
  const normalized = requireRepositoryRelativePath(
    value,
    "distribution mcp.bundle",
  );
  if (!MCP_BUNDLE_PATTERN.test(normalized)) {
    throw new TypeError(
      "distribution mcp.bundle must be a .cjs file directly under server/dist/.",
    );
  }
  return normalized;
}

function isValidSemanticBaseVersion(version) {
  if (version.includes("+")) {
    return false;
  }

  const prereleaseSeparator = version.indexOf("-");
  const core =
    prereleaseSeparator === -1
      ? version
      : version.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1 ? null : version.slice(prereleaseSeparator + 1);
  const coreIdentifiers = core.split(".");
  if (
    coreIdentifiers.length !== 3 ||
    coreIdentifiers.some(
      (identifier) => !SEMVER_NUMERIC_IDENTIFIER_PATTERN.test(identifier),
    )
  ) {
    return false;
  }

  if (prerelease === null) {
    return true;
  }
  if (!prerelease) {
    return false;
  }

  return prerelease.split(".").every((identifier) => {
    if (!SEMVER_PRERELEASE_IDENTIFIER_PATTERN.test(identifier)) {
      return false;
    }
    return (
      !/^\d+$/.test(identifier) ||
      SEMVER_NUMERIC_IDENTIFIER_PATTERN.test(identifier)
    );
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function normalizeCanonicalDistribution(metadata) {
  if (metadata?.schemaVersion !== 1) {
    throw new TypeError("distribution.json schemaVersion must be 1.");
  }

  const name = requireNonEmptyString(metadata.name, "distribution name");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new TypeError(
      "distribution name must contain only lowercase letters, digits, and hyphens.",
    );
  }

  const version = requireNonEmptyString(
    metadata.version,
    "distribution version",
  );
  if (!isValidSemanticBaseVersion(version)) {
    throw new TypeError(
      "distribution version must be a valid SemVer base version without build metadata.",
    );
  }

  const normalized = {
    schemaVersion: 1,
    name,
    version,
    description: requireNonEmptyString(
      metadata.description,
      "distribution description",
    ),
    license: requireNonEmptyString(metadata.license, "distribution license"),
    mcp: {
      bundle: requireMcpBundlePath(metadata.mcp?.bundle),
    },
    skills: {
      directory: requireRepositoryRelativePath(
        metadata.skills?.directory,
        "distribution skills.directory",
      ),
    },
  };

  return deepFreeze(normalized);
}
