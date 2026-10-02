import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_ARTIFACT_DIRECTORY = "artifacts/formatting";
const GIT_EXECUTABLE = "/usr/bin/git";
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

function runGit(repositoryRoot, args, { allowDifference = false } = {}) {
  const result = spawnSync(GIT_EXECUTABLE, args, {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0 || (allowDifference && result.status === 1)) {
    return result;
  }

  const stderr = result.stderr?.toString("utf8").trim();
  const exitCode = result.status ?? "unknown";
  const stderrSuffix = stderr ? `: ${stderr}` : "";
  throw new Error(
    `git ${args.join(" ")} failed with exit code ${exitCode}${stderrSuffix}`,
  );
}

function decodeNulSeparatedPaths(buffer) {
  const text = buffer.toString("utf8");
  if (!text) {
    return [];
  }

  const paths = text.split("\0");
  if (paths.at(-1) === "") {
    paths.pop();
  }
  return paths;
}

function resolveRepositoryPath(repositoryRoot, repositoryPath) {
  if (!repositoryPath || isAbsolute(repositoryPath)) {
    throw new Error(
      `Unsafe repository path: ${JSON.stringify(repositoryPath)}`,
    );
  }

  const root = resolve(repositoryRoot);
  const absolutePath = resolve(root, repositoryPath);
  const relativePath = relative(root, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Repository path escapes checkout: ${repositoryPath}`);
  }

  return absolutePath;
}

export async function captureFormattingFixArtifacts({
  repositoryRoot = process.cwd(),
  artifactDirectory = DEFAULT_ARTIFACT_DIRECTORY,
  git = runGit,
} = {}) {
  const root = resolve(repositoryRoot);
  const artifactRoot = resolveRepositoryPath(root, artifactDirectory);
  await rm(artifactRoot, { recursive: true, force: true });

  const diffCheck = git(root, ["diff", "--quiet", "--exit-code", "--"], {
    allowDifference: true,
  });
  if (diffCheck.status === 0) {
    return { changed: false, paths: [] };
  }

  const changedPaths = decodeNulSeparatedPaths(
    git(root, ["diff", "--name-only", "-z", "--diff-filter=ACMRTUXB", "--"])
      .stdout,
  );
  if (changedPaths.length === 0) {
    throw new Error(
      "Formatting changed tracked content but no changed paths were reported.",
    );
  }

  const filesDirectory = resolve(artifactRoot, "files");
  await mkdir(filesDirectory, { recursive: true });

  const patch = git(root, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--",
  ]).stdout;
  const patchPath = resolve(artifactRoot, "prettier.patch");
  await writeFile(patchPath, patch);

  const manifestPath = resolve(artifactRoot, "changed-files.txt");
  await writeFile(manifestPath, `${changedPaths.join("\n")}\n`, "utf8");

  for (const repositoryPath of changedPaths) {
    const sourcePath = resolveRepositoryPath(root, repositoryPath);
    const destinationPath = resolveRepositoryPath(
      filesDirectory,
      repositoryPath,
    );
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  return {
    changed: true,
    paths: changedPaths,
    artifactDirectory: artifactRoot,
    filesDirectory,
    manifestPath,
    patchPath,
  };
}
