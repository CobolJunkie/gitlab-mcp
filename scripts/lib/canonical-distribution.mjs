import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { normalizeCanonicalDistribution } from "../../shared/canonical-distribution.mjs";

export { normalizeCanonicalDistribution } from "../../shared/canonical-distribution.mjs";

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
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
