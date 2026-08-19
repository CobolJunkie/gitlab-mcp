import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createDeterministicGitArchive } from "./deterministic-git-archive.mjs";
import { normalizeCanonicalDistribution } from "./lib/distribution-config.mjs";
import {
  RELEASE_ARTIFACT_LABEL_MAX_LENGTH,
  resolveReleaseArtifactLabel,
} from "./lib/release-artifact.mjs";
import {
  assertSafeReleaseOutputDirectory,
  buildFileManifest,
  resolveReleaseOutputDirectory,
  sha256,
} from "./lib/release-files.mjs";
import { probeStdioMcp } from "./lib/stdio-mcp-probe.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const releaseRoot = resolveReleaseOutputDirectory(rootPath);
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: rootPath,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function sortedToolNames(tools) {
  return tools.map((tool) => tool.name).sort();
}

function requireArtifactName(value) {
  if (
    typeof value !== "string" ||
    value.length > RELEASE_ARTIFACT_LABEL_MAX_LENGTH ||
    !ARTIFACT_NAME_PATTERN.test(value)
  ) {
    throw new TypeError(
      `Harness artifact name must be 1-${RELEASE_ARTIFACT_LABEL_MAX_LENGTH} filename-safe ASCII characters and must start with a letter or number.`,
    );
  }
  return value;
}

function requirePackageRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty package-relative path.`);
  }

  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a package-relative path.`);
  }
  return normalized;
}

function normalizePackageFiles(packageFiles) {
  if (!Array.isArray(packageFiles)) {
    throw new TypeError("Harness package files must be an array.");
  }

  const targets = new Set();
  return packageFiles.map((entry, index) => {
    let source;
    let target;
    if (typeof entry === "string") {
      source = entry;
      target = entry;
    } else if (
      entry &&
      typeof entry === "object" &&
      typeof entry.source === "string" &&
      typeof entry.target === "string"
    ) {
      ({ source, target } = entry);
    } else {
      throw new TypeError(
        "Harness package files must be paths or source/target mappings.",
      );
    }

    const normalizedSource = requirePackageRelativePath(
      source,
      `Harness package source ${index}`,
    );
    const normalizedTarget = requirePackageRelativePath(
      target,
      `Harness package target ${index}`,
    );
    if (targets.has(normalizedTarget)) {
      throw new TypeError(
        `Harness package target ${normalizedTarget} must be unique.`,
      );
    }
    targets.add(normalizedTarget);
    return { source: normalizedSource, target: normalizedTarget };
  });
}

function packagePathsOverlap(left, right) {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function assertPackageTargetsDoNotOverlap(mappings, reservedPaths) {
  for (let index = 0; index < mappings.length; index += 1) {
    const target = mappings[index].target;
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previousTarget = mappings[previousIndex].target;
      if (packagePathsOverlap(target, previousTarget)) {
        throw new TypeError(
          `Harness package target ${target} must not overlap harness package target ${previousTarget}.`,
        );
      }
    }

    for (const { path, label } of reservedPaths) {
      if (packagePathsOverlap(target, path)) {
        throw new TypeError(
          `Harness package target ${target} must not overlap ${label} ${path}.`,
        );
      }
    }
  }
}

function normalizePackagePathList(paths, label) {
  if (!Array.isArray(paths)) {
    throw new TypeError(`${label} must be an array.`);
  }
  return paths.map((path, index) =>
    requirePackageRelativePath(path, `${label} ${index}`),
  );
}

async function copyPackagePath(packageRoot, source, target) {
  const destinationPath = join(packageRoot, target);
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(join(rootPath, source), destinationPath, { recursive: true });
}

async function assertPackagedFile(packageRoot, relativePath, label) {
  const packagedFile = await stat(join(packageRoot, relativePath));
  assert.ok(packagedFile.isFile(), `${label} must be packaged as a file.`);
}

async function assertExcludedPackagePaths(packageRoot, excludedPaths) {
  for (const relativePath of excludedPaths) {
    await assert.rejects(
      stat(join(packageRoot, relativePath)),
      (error) => error?.code === "ENOENT",
      `Excluded package path ${relativePath} must not be present.`,
    );
  }
}

async function validateSkills({ packageRoot, canonical, validateSkill }) {
  const skillsRoot = join(packageRoot, canonical.skills.directory);
  const packagedSkills = await stat(skillsRoot);
  assert.ok(
    packagedSkills.isDirectory(),
    "Packaged canonical Skills path must be a directory.",
  );

  const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(
    skillDirectories.length > 0,
    "Packaged canonical Skills directory must contain skills.",
  );

  for (const skillName of skillDirectories) {
    const skillPath = join(skillsRoot, skillName, "SKILL.md");
    const skillText = await readFile(skillPath, "utf8");
    if (validateSkill) {
      await validateSkill({ skillName, skillText, skillPath });
    }
  }

  return skillDirectories;
}

async function packageFileManifest(directoryRoot) {
  return (
    await buildFileManifest(directoryRoot, {
      entryLabel: "Harness package",
    })
  ).map(({ path, sha256: fileSha256 }) => ({
    path,
    sha256: fileSha256,
  }));
}

async function createArchive({
  packageRoot,
  archiveRootName,
  archivePath,
  harnessLabel,
}) {
  const entries = await packageFileManifest(packageRoot);
  await createDeterministicGitArchive({
    repositoryRoot: rootPath,
    archivePath,
    prefix: `${archiveRootName}/`,
    commitMessage: `deterministic ${harnessLabel} release archive`,
    files: entries.map((entry) => ({
      sourcePath: join(packageRoot, entry.path),
      archivePath: entry.path,
    })),
  });
}

async function assertArchiveMatchesPackage({
  packageRoot,
  artifactName,
  archiveRootName,
  archivePath,
  harnessLabel,
}) {
  const extractionDirectory = await mkdtemp(
    join(tmpdir(), `${artifactName}-archive-check-`),
  );
  try {
    await run("tar", ["-xzf", archivePath, "-C", extractionDirectory]);
    const extractedRoot = join(extractionDirectory, archiveRootName);
    assert.deepEqual(
      await packageFileManifest(extractedRoot),
      await packageFileManifest(packageRoot),
      `${harnessLabel} distribution archive must exactly match the validated materialized package.`,
    );
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

async function validateDeterministicArchive({
  packageRoot,
  artifactName,
  harnessLabel,
  releaseLabel,
  requiredPaths,
  skillsDirectory,
}) {
  const archiveRootName = `${artifactName}-${releaseLabel}`;
  const archiveName = `${archiveRootName}.tar.gz`;
  const archivePath = join(releaseRoot, archiveName);
  const checksumName = `${archiveName}.sha256`;
  const checksumPath = join(releaseRoot, checksumName);
  const archiveOptions = {
    packageRoot,
    archiveRootName,
    archivePath,
    harnessLabel,
  };

  await rm(archivePath, { force: true });
  await rm(checksumPath, { force: true });
  await createArchive(archiveOptions);
  const firstArchiveDigest = sha256(await readFile(archivePath));
  await createArchive(archiveOptions);
  assert.equal(
    sha256(await readFile(archivePath)),
    firstArchiveDigest,
    `${harnessLabel} distribution archive must be byte-for-byte reproducible.`,
  );
  await assertArchiveMatchesPackage({
    ...archiveOptions,
    artifactName,
  });

  const { stdout: archiveListing } = await run("tar", ["-tzf", archivePath]);
  const archiveEntries = archiveListing.split(/\r?\n/u).filter(Boolean);
  for (const relativePath of requiredPaths) {
    assert.ok(
      archiveEntries.includes(`${archiveRootName}/${relativePath}`),
      `${harnessLabel} distribution archive must contain ${relativePath}.`,
    );
  }
  assert.ok(
    archiveEntries.some(
      (entry) =>
        entry.startsWith(`${archiveRootName}/${skillsDirectory}/`) &&
        entry.endsWith("/SKILL.md"),
    ),
    `${harnessLabel} distribution archive must contain canonical Skill definitions.`,
  );

  const checksum = `${firstArchiveDigest}  ${archiveName}\n`;
  await writeFile(checksumPath, checksum);
  assert.equal(await readFile(checksumPath, "utf8"), checksum);
  return { archiveName, checksumName };
}

export function assertSingleCanonicalEntry(entries, canonicalName, label) {
  assert.deepEqual(
    Object.keys(entries ?? {}),
    [canonicalName],
    `${label} must contain exactly the canonical ${canonicalName} entry.`,
  );
}

export async function validateHarnessPackage({
  artifactName,
  packageFiles,
  distributionMetadataPath,
  harnessLabel,
  clientNamePrefix,
  probeEnvironment,
  excludedPackagePaths = [],
  validateHarness,
  validateSkill,
}) {
  const safeArtifactName = requireArtifactName(artifactName);
  const mappings = normalizePackageFiles(packageFiles);
  const safeDistributionMetadataPath = requirePackageRelativePath(
    distributionMetadataPath,
    "Harness distribution metadata path",
  );
  const safeExcludedPackagePaths = normalizePackagePathList(
    excludedPackagePaths,
    "Excluded package path",
  );
  const packageRoot = join(releaseRoot, safeArtifactName);
  const releaseLabel = resolveReleaseArtifactLabel({
    releaseTag: process.env.CI_COMMIT_TAG,
    configuredLabel: process.env.RELEASE_ARTIFACT_LABEL,
  });
  const repositoryCanonical = normalizeCanonicalDistribution(
    JSON.parse(
      await readFile(new URL("../distribution.json", import.meta.url), "utf8"),
    ),
  );
  assertPackageTargetsDoNotOverlap(mappings, [
    { path: repositoryCanonical.mcp.bundle, label: "canonical MCP bundle" },
    {
      path: repositoryCanonical.skills.directory,
      label: "canonical Skills directory",
    },
  ]);

  await assertSafeReleaseOutputDirectory(rootPath, releaseRoot);
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  for (const { source, target } of mappings) {
    await copyPackagePath(packageRoot, source, target);
  }
  await copyPackagePath(
    packageRoot,
    repositoryCanonical.mcp.bundle,
    repositoryCanonical.mcp.bundle,
  );
  await copyPackagePath(
    packageRoot,
    repositoryCanonical.skills.directory,
    repositoryCanonical.skills.directory,
  );

  for (const { target } of mappings) {
    await assertPackagedFile(packageRoot, target, target);
  }
  await assertPackagedFile(
    packageRoot,
    repositoryCanonical.mcp.bundle,
    "Canonical MCP bundle",
  );
  await assertExcludedPackagePaths(packageRoot, safeExcludedPackagePaths);

  const readPackageJson = async (relativePath) =>
    JSON.parse(await readFile(join(packageRoot, relativePath), "utf8"));
  const packagedCanonical = normalizeCanonicalDistribution(
    await readPackageJson(safeDistributionMetadataPath),
  );
  assert.deepEqual(
    packagedCanonical,
    repositoryCanonical,
    "Packaged canonical distribution metadata must match the repository source.",
  );

  const { canonicalServer, installedServer } = await validateHarness({
    canonical: packagedCanonical,
    packageRoot,
    rootPath,
    readPackageJson,
  });
  const { tools: canonicalTools } = await probeStdioMcp({
    command: canonicalServer.command,
    args: canonicalServer.args,
    env: probeEnvironment,
    clientInfo: {
      name: `${clientNamePrefix}-canonical-smoke`,
      version: "1.0.0",
    },
  });

  const skillDirectories = await validateSkills({
    packageRoot,
    canonical: packagedCanonical,
    validateSkill,
  });
  const { protocolVersion, tools, runtimeInfo } = await probeStdioMcp({
    command: installedServer.command,
    args: installedServer.args,
    env: probeEnvironment,
    clientInfo: {
      name: `${clientNamePrefix}-adapter-smoke`,
      version: "1.0.0",
    },
  });
  assert.deepEqual(
    sortedToolNames(tools),
    sortedToolNames(canonicalTools),
    `Packaged ${harnessLabel} MCP tool inventory must match the canonical bundle.`,
  );
  assert.ok(tools.some((tool) => tool.name === "get_runtime_info"));
  assert.deepEqual(runtimeInfo.structuredContent.result.plugin, {
    name: packagedCanonical.name,
    version: packagedCanonical.version,
  });

  const { archiveName, checksumName } = await validateDeterministicArchive({
    packageRoot,
    artifactName: safeArtifactName,
    harnessLabel,
    releaseLabel,
    requiredPaths: [
      ...mappings.map(({ target }) => target),
      repositoryCanonical.mcp.bundle,
    ],
    skillsDirectory: repositoryCanonical.skills.directory,
  });

  return {
    archiveName,
    checksumName,
    packageRoot,
    protocolVersion,
    skillDirectories,
    tools,
  };
}
