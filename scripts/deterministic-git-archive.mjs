import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sanitizedGitEnvironment(globalConfigPath) {
  const environment = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_TEMPLATE_DIR",
  ]) {
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_SYSTEM: globalConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function normalizeArchivePath(path) {
  if (typeof path !== "string" || !path.trim()) {
    throw new TypeError("Archive file paths must be non-empty strings.");
  }
  const normalized = path.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(
      "Archive file paths must stay inside the archive root.",
    );
  }
  return normalized;
}

function normalizeArchivePrefix(prefix) {
  if (prefix === "") {
    return "";
  }
  if (typeof prefix !== "string" || !prefix.trim()) {
    throw new TypeError("Archive prefix must be a string.");
  }
  const normalized = prefix.trim().replaceAll("\\", "/");
  const withoutTrailingSlash = normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  return `${normalizeArchivePath(withoutTrailingSlash)}/`;
}

function normalizeArchiveFiles(files) {
  if (!Array.isArray(files)) {
    throw new TypeError("Deterministic archive files must be an array.");
  }

  const archivePaths = new Set();
  return files.map((file) => {
    if (!file || typeof file.sourcePath !== "string") {
      throw new TypeError("Archive files require a sourcePath.");
    }
    const archivePath = normalizeArchivePath(file.archivePath);
    if (archivePaths.has(archivePath)) {
      throw new TypeError(`Archive file path ${archivePath} must be unique.`);
    }
    archivePaths.add(archivePath);
    return { ...file, archivePath };
  });
}

async function git(repositoryRoot, args, environment) {
  return execFileAsync("git", args, {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function resolveGitMode(sourcePath, configuredMode) {
  if (configuredMode) {
    return configuredMode;
  }
  const sourceStat = await stat(sourcePath);
  return sourceStat.mode & 0o111 ? "100755" : "100644";
}

export async function createDeterministicGitArchive({
  repositoryRoot,
  archivePath,
  prefix,
  commitMessage,
  files,
  baseTree = null,
}) {
  const safePrefix = normalizeArchivePrefix(prefix);
  const normalizedFiles = normalizeArchiveFiles(files);
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "gitlab-mcp-deterministic-archive-"),
  );
  const gitDirectory = join(temporaryRoot, "repo.git");
  const indexPath = join(temporaryRoot, "index");
  const globalConfigPath = join(temporaryRoot, "global.gitconfig");
  const templateDirectory = join(temporaryRoot, "git-template");

  try {
    await writeFile(globalConfigPath, "");
    await mkdir(templateDirectory);
    const cleanEnvironment = sanitizedGitEnvironment(globalConfigPath);
    const initEnvironment = {
      ...cleanEnvironment,
      GIT_TEMPLATE_DIR: templateDirectory,
    };
    const { stdout: repositoryObjectsOutput } = await git(
      repositoryRoot,
      ["rev-parse", "--git-path", "objects"],
      cleanEnvironment,
    );
    const repositoryObjects = resolve(
      repositoryRoot,
      repositoryObjectsOutput.trim(),
    );
    const { stdout: timestampOutput } = await git(
      repositoryRoot,
      ["show", "-s", "--format=%ct", "HEAD"],
      cleanEnvironment,
    );
    const timestamp = timestampOutput.trim();

    let baseCommit = null;
    if (baseTree) {
      const { stdout: baseCommitOutput } = await git(
        repositoryRoot,
        ["rev-parse", "--verify", `${baseTree}^{commit}`],
        cleanEnvironment,
      );
      baseCommit = baseCommitOutput.trim();
    }

    await git(
      repositoryRoot,
      ["init", "--bare", "--quiet", gitDirectory],
      initEnvironment,
    );
    const temporaryGitEnvironment = {
      ...cleanEnvironment,
      GIT_DIR: gitDirectory,
      GIT_INDEX_FILE: indexPath,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects,
    };

    await git(
      repositoryRoot,
      baseCommit ? ["read-tree", baseCommit] : ["read-tree", "--empty"],
      temporaryGitEnvironment,
    );

    for (const file of normalizedFiles) {
      const { stdout: blobOutput } = await git(
        repositoryRoot,
        ["hash-object", "-w", "--no-filters", "--", file.sourcePath],
        temporaryGitEnvironment,
      );
      await git(
        repositoryRoot,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          await resolveGitMode(file.sourcePath, file.mode),
          blobOutput.trim(),
          file.archivePath,
        ],
        temporaryGitEnvironment,
      );
    }

    const { stdout: treeOutput } = await git(
      repositoryRoot,
      ["write-tree"],
      temporaryGitEnvironment,
    );
    const deterministicCommitEnvironment = {
      ...temporaryGitEnvironment,
      GIT_AUTHOR_NAME: "GitLab MCP Release",
      GIT_AUTHOR_EMAIL: "release@localhost",
      GIT_AUTHOR_DATE: `${timestamp} +0000`,
      GIT_COMMITTER_NAME: "GitLab MCP Release",
      GIT_COMMITTER_EMAIL: "release@localhost",
      GIT_COMMITTER_DATE: `${timestamp} +0000`,
    };
    const commitArgs = ["commit-tree", treeOutput.trim()];
    if (baseCommit) {
      commitArgs.push("-p", baseCommit);
    }
    commitArgs.push("-m", commitMessage);
    const { stdout: commitOutput } = await git(
      repositoryRoot,
      commitArgs,
      deterministicCommitEnvironment,
    );

    await git(
      repositoryRoot,
      [
        "archive",
        "--format=tar.gz",
        `--prefix=${safePrefix}`,
        `--output=${archivePath}`,
        commitOutput.trim(),
      ],
      deterministicCommitEnvironment,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
