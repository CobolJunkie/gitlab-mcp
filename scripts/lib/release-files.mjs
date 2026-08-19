import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(repositoryRoot, args) {
  return execFileAsync("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function isInsideOrEqual(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    !relativePath ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function repositoryRelativePath(repositoryRoot, candidate) {
  const relativePath = relative(resolve(repositoryRoot), resolve(candidate));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new TypeError(
      "RELEASE_OUTPUT_DIR must resolve to a directory inside the repository root.",
    );
  }
  return relativePath.replaceAll("\\", "/");
}

async function nearestExistingPath(candidate) {
  let currentPath = candidate;
  for (;;) {
    try {
      return {
        path: currentPath,
        realPath: await realpath(currentPath),
      };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      currentPath = parentPath;
    }
  }
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export async function buildFileManifest(
  directoryRoot,
  { entryLabel = "Release package" } = {},
) {
  const entries = [];

  async function walk(currentDirectory) {
    const directoryEntries = await readdir(currentDirectory, {
      withFileTypes: true,
    });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of directoryEntries) {
      const absolutePath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `${entryLabel} contains unsupported filesystem entry ${absolutePath}.`,
        );
      }
      const data = await readFile(absolutePath);
      entries.push({
        path: relative(directoryRoot, absolutePath).replaceAll("\\", "/"),
        bytes: data.length,
        sha256: sha256(data),
      });
    }
  }

  await walk(directoryRoot);
  return entries;
}

export function manifestDigest(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.bytes));
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function manifestBytes(entries) {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

export function resolveReleaseOutputDirectory(
  repositoryRoot,
  configuredDirectory = process.env.RELEASE_OUTPUT_DIR,
) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot) {
    throw new TypeError("Repository root must be a non-empty path.");
  }
  if (
    configuredDirectory !== undefined &&
    typeof configuredDirectory !== "string"
  ) {
    throw new TypeError("RELEASE_OUTPUT_DIR must be a string when configured.");
  }

  const outputDirectory = configuredDirectory || "release";
  if (isAbsolute(outputDirectory)) {
    throw new TypeError(
      "RELEASE_OUTPUT_DIR must be a relative directory inside the repository root.",
    );
  }

  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedOutputDirectory = resolve(
    resolvedRepositoryRoot,
    outputDirectory,
  );
  repositoryRelativePath(resolvedRepositoryRoot, resolvedOutputDirectory);
  return join(repositoryRoot, outputDirectory);
}

export async function clearReleaseOutputFile(releaseRoot, outputPath) {
  const resolvedReleaseRoot = resolve(releaseRoot);
  const resolvedOutputPath = resolve(outputPath);
  if (dirname(resolvedOutputPath) !== resolvedReleaseRoot) {
    throw new TypeError(
      "Release output files must be direct children of RELEASE_OUTPUT_DIR.",
    );
  }

  await rm(resolvedOutputPath, { force: true });
  return resolvedOutputPath;
}

export async function assertSafeReleaseOutputDirectory(
  repositoryRoot,
  releaseRoot,
  { git = runGit } = {},
) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedReleaseRoot = resolve(releaseRoot);
  const relativeOutputDirectory = repositoryRelativePath(
    resolvedRepositoryRoot,
    resolvedReleaseRoot,
  );
  const physicalRepositoryRoot = await realpath(resolvedRepositoryRoot);
  const existingAncestor = await nearestExistingPath(resolvedReleaseRoot);
  const existingAncestorStats = await stat(existingAncestor.path);
  if (!existingAncestorStats.isDirectory()) {
    throw new TypeError(
      "RELEASE_OUTPUT_DIR must have an existing directory ancestor.",
    );
  }

  const expectedPhysicalAncestor = resolve(
    physicalRepositoryRoot,
    relative(resolvedRepositoryRoot, existingAncestor.path),
  );
  if (existingAncestor.realPath !== expectedPhysicalAncestor) {
    throw new TypeError("RELEASE_OUTPUT_DIR must not traverse symbolic links.");
  }
  if (!isInsideOrEqual(physicalRepositoryRoot, existingAncestor.realPath)) {
    throw new TypeError(
      "RELEASE_OUTPUT_DIR physical location must remain inside the repository root.",
    );
  }

  const { stdout: trackedFiles } = await git(resolvedRepositoryRoot, [
    "ls-files",
    "--",
    `:(literal)${relativeOutputDirectory}`,
  ]);
  if (trackedFiles.trim()) {
    throw new TypeError(
      "RELEASE_OUTPUT_DIR must be a dedicated untracked directory with no tracked repository files.",
    );
  }

  return resolvedReleaseRoot;
}

export async function gitStatusOutsideReleaseOutput(
  repositoryRoot,
  releaseRoot,
  { git = runGit } = {},
) {
  const safeReleaseRoot = await assertSafeReleaseOutputDirectory(
    repositoryRoot,
    releaseRoot,
    { git },
  );
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const relativeOutputDirectory = repositoryRelativePath(
    resolvedRepositoryRoot,
    safeReleaseRoot,
  );
  const { stdout } = await git(resolvedRepositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    `:(exclude,literal)${relativeOutputDirectory}`,
  ]);
  return stdout;
}
