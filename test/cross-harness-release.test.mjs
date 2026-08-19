import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { load as loadYaml } from "js-yaml";

import {
  assertCompleteHarnessSet,
  assertCompleteReleaseDirectory,
  buildCrossHarnessManifest,
  expectedReleaseDirectoryEntries,
  parseArchiveChecksum,
} from "../scripts/lib/cross-harness-release-contract.mjs";
import {
  assertSafeReleaseOutputDirectory,
  buildFileManifest,
  clearReleaseOutputFile,
  gitStatusOutsideReleaseOutput,
  manifestBytes,
  manifestDigest,
  resolveReleaseOutputDirectory,
  sha256,
} from "../scripts/lib/release-files.mjs";
import { SUPPORTED_HARNESSES } from "../scripts/lib/supported-harnesses.mjs";

test("release filesystem helpers are deterministic and bounded to ordinary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-files-test-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "b.txt"), "beta");

    const manifest = await buildFileManifest(root);
    assert.deepEqual(
      manifest.map((entry) => entry.path),
      ["a.txt", "nested/b.txt"],
    );
    assert.equal(manifestBytes(manifest), 9);
    assert.equal(manifest[0].sha256, sha256("alpha"));
    assert.equal(manifest[1].sha256, sha256("beta"));
    assert.equal(manifestDigest(manifest), manifestDigest([...manifest]));

    await symlink("a.txt", join(root, "link"));
    await assert.rejects(
      buildFileManifest(root, { entryLabel: "Test package" }),
      /Test package contains unsupported filesystem entry/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release output resolver preserves the established override contract", () => {
  assert.equal(
    resolveReleaseOutputDirectory("/repo/root", ""),
    join("/repo/root", "release"),
  );
  assert.equal(
    resolveReleaseOutputDirectory("/repo/root", "artifacts/release"),
    join("/repo/root", "artifacts/release"),
  );
  assert.throws(
    () => resolveReleaseOutputDirectory("", "release"),
    /Repository root must be a non-empty path/,
  );
  assert.throws(
    () => resolveReleaseOutputDirectory("/repo/root", 42),
    /RELEASE_OUTPUT_DIR must be a string/,
  );
  assert.throws(
    () => resolveReleaseOutputDirectory("/repo/root", "../release"),
    /inside the repository root/,
  );
  assert.throws(
    () => resolveReleaseOutputDirectory("/repo/root", "."),
    /inside the repository root/,
  );
  assert.throws(
    () => resolveReleaseOutputDirectory("/repo/root", "/tmp/release"),
    /inside the repository root/,
  );
});

test("release output safety rejects tracked and symlinked destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-output-test-"));
  const outside = await mkdtemp(join(tmpdir(), "release-output-outside-"));
  const outputRoot = resolveReleaseOutputDirectory(root, "artifacts/release");
  const gitCalls = [];
  const cleanGit = async (_repositoryRoot, args) => {
    gitCalls.push(args);
    if (args[0] === "ls-files") {
      return { stdout: "" };
    }
    if (args[0] === "status") {
      return { stdout: "" };
    }
    throw new Error(`Unexpected git command ${args[0]}.`);
  };

  try {
    assert.equal(
      await assertSafeReleaseOutputDirectory(root, outputRoot, {
        git: cleanGit,
      }),
      outputRoot,
    );
    assert.equal(
      await gitStatusOutsideReleaseOutput(root, outputRoot, { git: cleanGit }),
      "",
    );
    assert.ok(
      gitCalls.some(
        (args) =>
          args[0] === "status" &&
          args.includes(":(exclude,literal)artifacts/release"),
      ),
      "Release cleanliness must exclude only the validated output path.",
    );

    await assert.rejects(
      assertSafeReleaseOutputDirectory(root, outputRoot, {
        git: async () => ({ stdout: "artifacts/release/tracked.txt\n" }),
      }),
      /dedicated untracked directory/,
    );

    await mkdir(join(root, "artifacts"), { recursive: true });
    await rm(join(root, "artifacts"), { recursive: true, force: true });
    await symlink(outside, join(root, "artifacts"));
    await assert.rejects(
      assertSafeReleaseOutputDirectory(root, outputRoot, { git: cleanGit }),
      /must not traverse symbolic links/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("release output cleanup unlinks leaf symlinks and hard links", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-output-leaf-test-"));
  const releaseRoot = join(root, "release");
  const sentinelPath = join(root, "sentinel.txt");
  const outputPath = join(releaseRoot, "artifact.tar.gz");

  try {
    await mkdir(releaseRoot);
    await writeFile(sentinelPath, "sentinel");

    await symlink(sentinelPath, outputPath);
    assert.equal(
      await clearReleaseOutputFile(releaseRoot, outputPath),
      outputPath,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "sentinel");
    await assert.rejects(
      readFile(outputPath),
      (error) => error?.code === "ENOENT",
    );

    await link(sentinelPath, outputPath);
    await clearReleaseOutputFile(releaseRoot, outputPath);
    assert.equal(await readFile(sentinelPath, "utf8"), "sentinel");
    await assert.rejects(
      readFile(outputPath),
      (error) => error?.code === "ENOENT",
    );

    await assert.rejects(
      clearReleaseOutputFile(
        releaseRoot,
        join(releaseRoot, "nested", "artifact.tar.gz"),
      ),
      /direct children of RELEASE_OUTPUT_DIR/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI artifact collection follows the release output override contract", async () => {
  const ci = loadYaml(
    await readFile(new URL("../.gitlab-ci.yml", import.meta.url), "utf8"),
  );
  assert.equal(ci.variables?.RELEASE_OUTPUT_DIR, "release");
  assert.equal(
    ci.release_validation?.variables?.RELEASE_OUTPUT_DIR,
    "artifacts/release",
  );

  for (const jobName of [
    "codex_adapter",
    "claude_adapter",
    "cline_adapter",
    "pi_adapter",
    "release_validation",
    "release_artifacts",
  ]) {
    const paths = ci[jobName]?.artifacts?.paths;
    assert.ok(
      Array.isArray(paths) && paths.length > 0,
      `${jobName} must retain release artifacts.`,
    );
    for (const artifactPath of paths) {
      assert.ok(
        artifactPath.startsWith("$RELEASE_OUTPUT_DIR/"),
        `${jobName} artifact path ${artifactPath} must follow RELEASE_OUTPUT_DIR.`,
      );
    }
  }
});

test("strict Pi tag validation feeds the stage-ordered release gate", async () => {
  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageMetadata.scripts["validate:codex"],
    "node scripts/release-validate.mjs && node scripts/validate-codex-adapter.mjs",
  );
  assert.equal(
    packageMetadata.scripts["release:validate"],
    "npm run adapters:check && npm run validate:harnesses && npm run validate:release-set",
  );

  const ci = loadYaml(
    await readFile(new URL("../.gitlab-ci.yml", import.meta.url), "utf8"),
  );
  assert.ok(
    ci.pi_adapter?.rules?.some((rule) => rule.if === "$CI_COMMIT_TAG"),
    "The strict Pi adapter/runtime job must run for release tags.",
  );
  assert.equal(ci.pi_adapter?.stage, "adapter");
  assert.equal(ci.release_gate?.stage, "release");
  assert.equal(
    ci.release_gate?.needs,
    undefined,
    "The release gate must retain normal stage ordering so strict Pi validation finishes before it.",
  );
  const piStageIndex = ci.stages.indexOf(ci.pi_adapter.stage);
  const releaseStageIndex = ci.stages.indexOf(ci.release_gate.stage);
  assert.ok(
    piStageIndex < releaseStageIndex,
    "Strict Pi validation must be in an earlier stage than the release gate.",
  );
  assert.ok(
    ci.release_artifacts?.needs?.some(
      (need) => need.job === "release_gate" && need.artifacts === false,
    ),
    "Release publication must wait for the stage-ordered release gate.",
  );
});

test("supported harness registry is complete, unique, and canonically ordered", () => {
  assert.deepEqual(
    SUPPORTED_HARNESSES.map((harness) => harness.id),
    ["codex", "claude", "cline", "pi"],
  );
  assert.equal(
    new Set(SUPPORTED_HARNESSES.map((harness) => harness.id)).size,
    4,
  );
  assert.equal(
    new Set(SUPPORTED_HARNESSES.map((harness) => harness.artifactName)).size,
    4,
  );
  assertCompleteHarnessSet(
    SUPPORTED_HARNESSES.map((harness) => ({ id: harness.id })),
    SUPPORTED_HARNESSES,
  );
});

test("cross-harness completeness rejects missing, reordered, or duplicated harnesses", () => {
  const summaries = SUPPORTED_HARNESSES.map((harness) => ({ id: harness.id }));
  assert.throws(
    () => assertCompleteHarnessSet(summaries.slice(0, 3), SUPPORTED_HARNESSES),
    /every supported harness exactly once/,
  );
  assert.throws(
    () =>
      assertCompleteHarnessSet(
        [summaries[1], summaries[0], ...summaries.slice(2)],
        SUPPORTED_HARNESSES,
      ),
    /every supported harness exactly once/,
  );
  assert.throws(
    () =>
      assertCompleteHarnessSet(
        [summaries[0], summaries[1], summaries[1], summaries[3]],
        SUPPORTED_HARNESSES,
      ),
    /every supported harness exactly once/,
  );
});

test("archive checksum parsing requires one exact SHA-256 entry", () => {
  const digest = "a".repeat(64);
  assert.equal(
    parseArchiveChecksum(
      `${digest}  gitlab-cline-mcp-validation.tar.gz\n`,
      "gitlab-cline-mcp-validation.tar.gz",
      "cline.sha256",
    ),
    digest,
  );
  assert.equal(
    parseArchiveChecksum(
      `${"b".repeat(64)}  other.tar.gz\n${digest} *gitlab-cline-mcp-validation.tar.gz\n`,
      "gitlab-cline-mcp-validation.tar.gz",
      "SHA256SUMS",
    ),
    digest,
  );
  assert.throws(
    () => parseArchiveChecksum("", "archive.tar.gz", "checksum"),
    /must contain a checksum/,
  );
  assert.throws(
    () =>
      parseArchiveChecksum(
        `${digest}  archive.tar.gz\n${digest}  archive.tar.gz\n`,
        "archive.tar.gz",
        "checksum",
      ),
    /exactly one SHA-256 entry/,
  );
});

test("release directory contract rejects stale, missing, and unexpected artifacts", () => {
  const expected = expectedReleaseDirectoryEntries(
    SUPPORTED_HARNESSES,
    "validation",
  );
  assert.equal(expected.length, 12);
  assertCompleteReleaseDirectory(
    [...expected].reverse(),
    SUPPORTED_HARNESSES,
    "validation",
  );

  assert.throws(
    () =>
      assertCompleteReleaseDirectory(
        expected.slice(1),
        SUPPORTED_HARNESSES,
        "validation",
      ),
    /exactly the expected current harness artifacts/,
  );
  assert.throws(
    () =>
      assertCompleteReleaseDirectory(
        [
          ...expected,
          {
            name: "gitlab-cline-mcp-old-release.tar.gz",
            type: "file",
          },
        ],
        SUPPORTED_HARNESSES,
        "validation",
      ),
    /exactly the expected current harness artifacts/,
  );
  assert.throws(
    () =>
      assertCompleteReleaseDirectory(
        [
          ...expected,
          {
            name: "cross-harness-manifest.json",
            type: "file",
          },
        ],
        SUPPORTED_HARNESSES,
        "validation",
      ),
    /exactly the expected current harness artifacts/,
  );
});

test("release directory contract requires one Codex distribution", () => {
  assert.throws(
    () =>
      expectedReleaseDirectoryEntries(
        SUPPORTED_HARNESSES.filter((harness) => harness.id !== "codex"),
        "validation",
      ),
    /exactly one Codex distribution/,
  );
});

test("cross-harness manifest is deterministic and contains release baselines", () => {
  const harnesses = SUPPORTED_HARNESSES.map((harness, index) => ({
    ...harness,
    archive: `${harness.artifactName}-validation.tar.gz`,
    archiveBytes: 100 + index,
    packageBytes: 200 + index,
    sha256: String(index).repeat(64),
    checksumFile: `${harness.artifactName}.sha256`,
    bundleSha256: "b".repeat(64),
    skillsSha256: "c".repeat(64),
  }));
  const manifest = buildCrossHarnessManifest({
    canonical: { name: "gitlab", version: "1.2.3" },
    canonicalBundle: {
      path: "server/dist/gitlab-mcp.cjs",
      bytes: 1234,
      sha256: "b".repeat(64),
    },
    canonicalSkills: {
      directory: "skills",
      files: 5,
      bytes: 2345,
      sha256: "c".repeat(64),
    },
    harnesses,
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.distribution, {
    name: "gitlab",
    version: "1.2.3",
  });
  assert.deepEqual(
    manifest.harnesses.map((harness) => harness.id),
    ["codex", "claude", "cline", "pi"],
  );
  assert.equal(manifest.harnesses[0].archiveBytes, 100);
  assert.equal(manifest.harnesses[3].packageBytes, 203);
  assert.equal(
    JSON.stringify(manifest),
    JSON.stringify(
      buildCrossHarnessManifest({
        canonical: { name: "gitlab", version: "1.2.3" },
        canonicalBundle: manifest.canonicalBundle,
        canonicalSkills: manifest.canonicalSkills,
        harnesses,
      }),
    ),
  );
});
