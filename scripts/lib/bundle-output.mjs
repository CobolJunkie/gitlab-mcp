import { lstat, readdir, realpath, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

function pathEscapesRoot(rootPath, candidatePath) {
  const relation = relative(rootPath, candidatePath);
  return (
    relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)
  );
}

async function resolveExistingAncestor(candidatePath) {
  let current = candidatePath;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function assertBundleDirectoryInsideRepository(
  repositoryRoot,
  bundleDirectory,
) {
  const lexicalRoot = resolve(repositoryRoot);
  const physicalRoot = await realpath(lexicalRoot);
  const candidate = resolve(bundleDirectory);
  if (pathEscapesRoot(lexicalRoot, candidate)) {
    throw new TypeError("MCP bundle output directory escapes the repository.");
  }

  const physicalAncestor = await resolveExistingAncestor(candidate);
  if (pathEscapesRoot(physicalRoot, physicalAncestor)) {
    throw new TypeError(
      "MCP bundle output directory must resolve inside the repository.",
    );
  }
}

async function assertCanonicalBundleIsNotSymlink(canonicalBundlePath) {
  try {
    const bundleStats = await lstat(canonicalBundlePath);
    if (bundleStats.isSymbolicLink()) {
      throw new TypeError(
        "Canonical MCP bundle output must not be a symbolic link.",
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function removeStaleMcpBundles(
  repositoryRoot,
  canonicalBundlePath,
) {
  const bundleDirectory = dirname(canonicalBundlePath);
  await assertBundleDirectoryInsideRepository(repositoryRoot, bundleDirectory);
  await assertCanonicalBundleIsNotSymlink(canonicalBundlePath);

  let entries;
  try {
    entries = await readdir(bundleDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const canonicalName = basename(canonicalBundlePath);
  const staleEntries = entries
    .filter(
      (entry) =>
        entry.name !== canonicalName &&
        entry.name.endsWith(".cjs") &&
        (entry.isFile() || entry.isSymbolicLink()),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of staleEntries) {
    await rm(join(bundleDirectory, entry.name), { force: true });
  }

  return staleEntries.map((entry) => entry.name);
}
