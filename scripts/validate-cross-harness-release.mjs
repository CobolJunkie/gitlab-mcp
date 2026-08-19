#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertCompleteHarnessSet,
  assertCompleteReleaseDirectory,
  buildCrossHarnessManifest,
  parseArchiveChecksum,
} from "./lib/cross-harness-release-contract.mjs";
import { normalizeCanonicalDistribution } from "./lib/distribution-config.mjs";
import { resolveReleaseArtifactLabel } from "./lib/release-artifact.mjs";
import {
  assertSafeReleaseOutputDirectory,
  buildFileManifest,
  manifestBytes,
  manifestDigest,
  resolveReleaseOutputDirectory,
  sha256,
} from "./lib/release-files.mjs";
import { SUPPORTED_HARNESSES } from "./lib/supported-harnesses.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const releaseRoot = resolveReleaseOutputDirectory(rootPath);
const canonical = normalizeCanonicalDistribution(
  JSON.parse(
    await readFile(new URL("../distribution.json", import.meta.url), "utf8"),
  ),
);
const releaseLabel = resolveReleaseArtifactLabel({
  releaseTag: process.env.CI_COMMIT_TAG,
  configuredLabel: process.env.RELEASE_ARTIFACT_LABEL,
});
const manifestName = "cross-harness-manifest.json";
const comparePaths = (left, right) => left.localeCompare(right);

async function run(command, args) {
  return execFileAsync(command, args, {
    cwd: rootPath,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function readExpectedArchiveChecksum(harness, archiveName) {
  const checksumFile =
    harness.id === "codex" ? "SHA256SUMS" : `${archiveName}.sha256`;
  const checksumText = await readFile(join(releaseRoot, checksumFile), "utf8");
  return {
    checksumFile,
    sha256: parseArchiveChecksum(checksumText, archiveName, checksumFile),
  };
}

async function expectedCodexPackagePaths() {
  const { stdout } = await run("git", ["ls-tree", "-r", "--name-only", "HEAD"]);
  const trackedPaths = stdout.split(/\r?\n/u).filter(Boolean);
  return [...new Set([...trackedPaths, canonical.mcp.bundle])].sort(
    comparePaths,
  );
}

function assertCodexArchiveContents(packageFiles, expectedPaths) {
  const actualPaths = packageFiles
    .map((entry) => entry.path)
    .sort(comparePaths);
  assert.deepEqual(
    actualPaths,
    expectedPaths,
    "Codex archive must contain exactly the tracked release tree plus the canonical generated MCP bundle.",
  );

  const forbiddenPrefixes = [".git/", "coverage/", "node_modules/", "release/"];
  for (const entry of packageFiles) {
    assert.ok(
      !forbiddenPrefixes.some(
        (prefix) =>
          entry.path === prefix.slice(0, -1) || entry.path.startsWith(prefix),
      ),
      `Codex archive must not contain forbidden path ${entry.path}.`,
    );
  }
}

async function summarizeHarnessArchive(harness, expected) {
  const archiveRootName = `${harness.artifactName}-${releaseLabel}`;
  const archiveName = `${archiveRootName}.tar.gz`;
  const archivePath = join(releaseRoot, archiveName);
  const archiveData = await readFile(archivePath);
  const archiveSha256 = sha256(archiveData);
  const checksum = await readExpectedArchiveChecksum(harness, archiveName);
  assert.equal(
    archiveSha256,
    checksum.sha256,
    `${harness.label} archive must match ${checksum.checksumFile}.`,
  );

  const extractionDirectory = await mkdtemp(
    join(tmpdir(), `${harness.id}-release-gate-`),
  );
  try {
    await run("tar", ["-xzf", archivePath, "-C", extractionDirectory]);
    const packageRoot = join(extractionDirectory, archiveRootName);
    const packageFiles = await buildFileManifest(packageRoot);
    if (harness.id === "codex") {
      assertCodexArchiveContents(packageFiles, expected.codexPackagePaths);
    }

    const packagedCanonical = normalizeCanonicalDistribution(
      JSON.parse(
        await readFile(join(packageRoot, "distribution.json"), "utf8"),
      ),
    );
    assert.deepEqual(
      packagedCanonical,
      canonical,
      `${harness.label} distribution metadata must match the canonical source.`,
    );

    const packagedBundle = await readFile(
      join(packageRoot, canonical.mcp.bundle),
    );
    const bundleSha256 = sha256(packagedBundle);
    assert.equal(
      bundleSha256,
      expected.bundleSha256,
      `${harness.label} must package the exact canonical MCP bundle.`,
    );

    const skillsRoot = join(packageRoot, canonical.skills.directory);
    const skillFiles = await buildFileManifest(skillsRoot);
    assert.ok(
      skillFiles.some(
        (entry) =>
          entry.path.endsWith("/SKILL.md") || entry.path === "SKILL.md",
      ),
      `${harness.label} package must contain canonical Skill definitions.`,
    );
    const skillsSha256 = manifestDigest(skillFiles);
    assert.equal(
      skillsSha256,
      expected.skillsSha256,
      `${harness.label} must package the exact canonical Skills tree.`,
    );

    return {
      ...harness,
      archive: archiveName,
      archiveBytes: archiveData.length,
      packageBytes: manifestBytes(packageFiles),
      sha256: archiveSha256,
      checksumFile: checksum.checksumFile,
      bundleSha256,
      skillsSha256,
    };
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

function releaseEntryType(entry) {
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  return "unsupported";
}

await assertSafeReleaseOutputDirectory(rootPath, releaseRoot);
await rm(join(releaseRoot, manifestName), { force: true });
await rm(join(releaseRoot, `${manifestName}.sha256`), { force: true });

const canonicalBundleData = await readFile(
  join(rootPath, canonical.mcp.bundle),
);
const canonicalBundle = {
  path: canonical.mcp.bundle,
  bytes: canonicalBundleData.length,
  sha256: sha256(canonicalBundleData),
};
const canonicalSkillFiles = await buildFileManifest(
  join(rootPath, canonical.skills.directory),
);
const canonicalSkills = {
  directory: canonical.skills.directory,
  files: canonicalSkillFiles.length,
  bytes: manifestBytes(canonicalSkillFiles),
  sha256: manifestDigest(canonicalSkillFiles),
};
const codexPackagePaths = await expectedCodexPackagePaths();

const harnesses = [];
for (const harness of SUPPORTED_HARNESSES) {
  harnesses.push(
    await summarizeHarnessArchive(harness, {
      bundleSha256: canonicalBundle.sha256,
      skillsSha256: canonicalSkills.sha256,
      codexPackagePaths,
    }),
  );
}
assertCompleteHarnessSet(harnesses, SUPPORTED_HARNESSES);

const releaseEntries = (
  await readdir(releaseRoot, { withFileTypes: true })
).map((entry) => ({
  name: entry.name,
  type: releaseEntryType(entry),
}));
assertCompleteReleaseDirectory(
  releaseEntries,
  SUPPORTED_HARNESSES,
  releaseLabel,
);

const manifest = buildCrossHarnessManifest({
  canonical,
  canonicalBundle,
  canonicalSkills,
  harnesses,
});
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(join(releaseRoot, manifestName), manifestText);
await writeFile(
  join(releaseRoot, `${manifestName}.sha256`),
  `${sha256(manifestText)}  ${manifestName}\n`,
);

for (const harness of harnesses) {
  console.log(
    `${harness.label}: ${harness.archiveBytes} compressed bytes, ${harness.packageBytes} unpacked bytes, sha256 ${harness.sha256}`,
  );
}
console.log(
  `Cross-harness release validation passed for ${harnesses.length} distributions; wrote ${manifestName}.`,
);
