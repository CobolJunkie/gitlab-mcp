import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

export function resolveRepositoryPath(
  rootPath,
  repositoryRelativePath,
  label = "repository path",
) {
  const candidate = requireNonEmptyString(
    repositoryRelativePath,
    label,
  ).replaceAll("\\", "/");
  const root = resolve(rootPath);
  const resolved = resolve(root, candidate);
  const relation = relative(root, resolved);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new TypeError(`${label} escapes the repository.`);
  }
  return resolved;
}

function pathEscapesRoot(rootPath, candidatePath) {
  const relation = relative(rootPath, candidatePath);
  return (
    relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)
  );
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

export async function assertCanonicalDistributionResources(
  rootPath,
  canonicalInput,
) {
  const canonical = normalizeCanonicalDistribution(canonicalInput);
  const root = await realpath(resolve(rootPath));
  const skillsCandidate = resolveRepositoryPath(
    root,
    canonical.skills.directory,
    "distribution skills.directory",
  );

  let skillsCandidateStats;
  try {
    skillsCandidateStats = await lstat(skillsCandidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TypeError(
        "distribution skills.directory must reference an existing directory.",
      );
    }
    throw error;
  }

  if (skillsCandidateStats.isSymbolicLink()) {
    throw new TypeError(
      "distribution skills.directory must not be a symbolic link.",
    );
  }

  let skillsPath;
  try {
    skillsPath = await realpath(skillsCandidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TypeError(
        "distribution skills.directory must reference an existing directory.",
      );
    }
    throw error;
  }

  if (pathEscapesRoot(root, skillsPath)) {
    throw new TypeError(
      "distribution skills.directory must resolve inside the repository.",
    );
  }

  const skillsStats = await stat(skillsPath);
  if (!skillsStats.isDirectory()) {
    throw new TypeError(
      "distribution skills.directory must reference an existing directory.",
    );
  }

  return canonical;
}
