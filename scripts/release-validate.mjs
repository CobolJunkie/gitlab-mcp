#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertCodexMcpServerLaunch,
  CODEX_DISTRIBUTION,
  isValidCodexManifestVersion,
} from "../adapters/codex/distribution.mjs";
import { createDeterministicGitArchive } from "./deterministic-git-archive.mjs";
import { normalizeCanonicalDistribution } from "./lib/canonical-distribution.mjs";
import { resolveReleaseArtifactLabel } from "./lib/release-artifact.mjs";
import {
  clearReleaseOutputFile,
  gitStatusOutsideReleaseOutput,
  resolveReleaseOutputDirectory,
  sha256,
} from "./lib/release-files.mjs";
import { assertReleaseTagMatchesCanonical } from "./lib/release-tag.mjs";
import { normalizeCycloneDxSbom } from "./lib/sbom.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const canonical = normalizeCanonicalDistribution(
  JSON.parse(
    await readFile(new URL("../distribution.json", import.meta.url), "utf8"),
  ),
);
const releaseTag = process.env.CI_COMMIT_TAG;
if (releaseTag) {
  assertReleaseTagMatchesCanonical(releaseTag, canonical.version);
}
const releaseRoot = resolveReleaseOutputDirectory(rootPath);
const label = resolveReleaseArtifactLabel({
  releaseTag,
  configuredLabel: process.env.RELEASE_ARTIFACT_LABEL,
});
const packageDirectoryName = `${CODEX_DISTRIBUTION.artifactName}-${label}`;
const prefix = `${packageDirectoryName}/`;
const archiveName = `${packageDirectoryName}.tar.gz`;
const sbomName = `${packageDirectoryName}.cdx.json`;
const archivePath = join(releaseRoot, archiveName);
const sbomPath = join(releaseRoot, sbomName);
const checksumsPath = join(releaseRoot, "SHA256SUMS");
const bundlePath = join(rootPath, canonical.mcp.bundle);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: rootPath,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function checksum(name, data) {
  return `${sha256(data)}  ${name}`;
}

function assertSingleCanonicalEntry(entries, canonicalName, label) {
  assert.deepEqual(
    Object.keys(entries ?? {}),
    [canonicalName],
    `${label} must contain exactly the canonical ${canonicalName} entry.`,
  );
}

async function assertCleanCheckout() {
  const stdout = await gitStatusOutsideReleaseOutput(rootPath, releaseRoot);
  assert.equal(
    stdout,
    "",
    "Release validation requires a clean checkout outside the validated RELEASE_OUTPUT_DIR.",
  );
}

async function assertReleaseTagContext() {
  if (!releaseTag) {
    return;
  }

  const { stdout: objectType } = await run("git", [
    "cat-file",
    "-t",
    releaseTag,
  ]);
  assert.equal(
    objectType.trim(),
    "tag",
    `Release tag ${releaseTag} must be an annotated Git tag.`,
  );

  const [{ stdout: taggedCommit }, { stdout: headCommit }] = await Promise.all([
    run("git", ["rev-list", "-n", "1", releaseTag]),
    run("git", ["rev-parse", "HEAD"]),
  ]);
  assert.equal(
    taggedCommit.trim(),
    headCommit.trim(),
    `Release tag ${releaseTag} must point to the commit being validated.`,
  );
}

async function createReleaseArchive() {
  await createDeterministicGitArchive({
    repositoryRoot: rootPath,
    archivePath,
    prefix,
    commitMessage: "deterministic release archive",
    baseTree: "HEAD",
    files: [
      {
        sourcePath: bundlePath,
        archivePath: canonical.mcp.bundle,
        mode: "100644",
      },
    ],
  });
}

async function createNormalizedSbom() {
  const { stdout } = await run(process.execPath, [
    process.env.npm_execpath,
    "sbom",
    "--omit=dev",
    "--sbom-format=cyclonedx",
  ]);
  return normalizeCycloneDxSbom(stdout);
}

function assertCanonicalSbomLicense(sbomText) {
  const sbom = JSON.parse(sbomText);
  const licenses = sbom.metadata?.component?.licenses ?? [];
  assert.ok(
    licenses.some(
      (entry) =>
        entry?.license?.id === canonical.license ||
        entry?.license?.name === canonical.license ||
        entry?.expression === canonical.license,
    ),
    `CycloneDX root component must report canonical license ${canonical.license}.`,
  );
}

await assertCleanCheckout();
await assertReleaseTagContext();
await run(process.execPath, ["scripts/build.mjs"]);
await assertCleanCheckout();
const firstBundleDigest = sha256(await readFile(bundlePath));

await mkdir(releaseRoot, { recursive: true });
await Promise.all([
  clearReleaseOutputFile(releaseRoot, archivePath),
  clearReleaseOutputFile(releaseRoot, sbomPath),
  clearReleaseOutputFile(releaseRoot, checksumsPath),
]);
await createReleaseArchive();
const firstArchiveDigest = sha256(await readFile(archivePath));

await rm(bundlePath, { force: true });
await run(process.execPath, ["scripts/build.mjs"]);
await assertCleanCheckout();
assert.equal(
  sha256(await readFile(bundlePath)),
  firstBundleDigest,
  "Canonical MCP bundle must be byte-for-byte reproducible across independent builds.",
);

await createReleaseArchive();
assert.equal(
  sha256(await readFile(archivePath)),
  firstArchiveDigest,
  "Release archive must be byte-for-byte reproducible across independent bundle builds.",
);

assert.ok(
  process.env.npm_execpath,
  "npm_execpath is required to generate the SBOM.",
);
const firstSbom = await createNormalizedSbom();
const secondSbom = await createNormalizedSbom();
assert.equal(
  secondSbom,
  firstSbom,
  "CycloneDX SBOM must be byte-for-byte reproducible after volatile metadata normalization.",
);
assertCanonicalSbomLicense(firstSbom);
await writeFile(sbomPath, firstSbom);

const checksums = await Promise.all(
  [archiveName, sbomName].map(async (name) =>
    checksum(name, await readFile(join(releaseRoot, name))),
  ),
);
await writeFile(checksumsPath, `${checksums.join("\n")}\n`);
const recordedChecksums = await readFile(checksumsPath, "utf8");
assert.equal(recordedChecksums, `${checksums.join("\n")}\n`);

const extractionDirectory = await mkdtemp(
  join(tmpdir(), `${CODEX_DISTRIBUTION.artifactName}-release-`),
);
try {
  await run("tar", ["-xzf", archivePath, "-C", extractionDirectory]);
  const extractedRoot = join(extractionDirectory, packageDirectoryName);
  const extractedSkills = await stat(
    join(extractedRoot, canonical.skills.directory),
  );
  assert.ok(
    extractedSkills.isDirectory(),
    "Extracted distribution must contain the canonical Skills directory.",
  );

  const codexManifest = JSON.parse(
    await readFile(
      join(extractedRoot, CODEX_DISTRIBUTION.files.manifest),
      "utf8",
    ),
  );
  assert.equal(codexManifest.name, canonical.name);
  assert.ok(
    isValidCodexManifestVersion(canonical.version, codexManifest.version),
    "Extracted Codex manifest version must equal the canonical base version or use +codex.<qualifier> build metadata.",
  );
  assert.equal(codexManifest.description, canonical.description);
  assert.equal(codexManifest.license, canonical.license);
  assert.equal(codexManifest.skills, `./${canonical.skills.directory}/`);
  assert.equal(
    codexManifest.mcpServers,
    `./${CODEX_DISTRIBUTION.files.mcpConfig}`,
  );

  const preload = await stat(
    join(extractedRoot, CODEX_DISTRIBUTION.files.preload),
  );
  assert.ok(preload.isFile(), "Extracted Codex adapter preload must exist.");

  const mcpConfig = JSON.parse(
    await readFile(
      join(extractedRoot, CODEX_DISTRIBUTION.files.mcpConfig),
      "utf8",
    ),
  );
  assertSingleCanonicalEntry(
    mcpConfig.mcpServers,
    canonical.name,
    "Extracted Codex MCP server configuration",
  );
  assertCodexMcpServerLaunch(mcpConfig.mcpServers[canonical.name], canonical);

  const appConfig = JSON.parse(
    await readFile(
      join(extractedRoot, CODEX_DISTRIBUTION.files.appConfig),
      "utf8",
    ),
  );
  assertSingleCanonicalEntry(
    appConfig.apps,
    canonical.name,
    "Extracted Codex app configuration",
  );
  assert.ok(
    appConfig.apps[canonical.name],
    "Extracted Codex app configuration must contain the canonical app entry.",
  );

  await run(process.execPath, [
    join(extractedRoot, "scripts/smoke-extracted-bundle.mjs"),
  ]);
} finally {
  await rm(extractionDirectory, { recursive: true, force: true });
}

console.log(
  `Release validation passed: reproducible bundle and deterministic ${archiveName}, ${sbomName}, SHA256SUMS, and extracted Codex distribution smoke.`,
);
