import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { removeStaleMcpBundles } from "../scripts/lib/bundle-output.mjs";
import {
  RELEASE_ARTIFACT_LABEL_MAX_LENGTH,
  resolveReleaseArtifactLabel,
} from "../scripts/lib/release-artifact.mjs";
import {
  assertReleaseTagMatchesCanonical,
  expectedReleaseTag,
} from "../scripts/lib/release-tag.mjs";
import { normalizeCycloneDxSbom } from "../scripts/lib/sbom.mjs";

test("release tags must exactly match the canonical distribution version", () => {
  assert.equal(expectedReleaseTag("1.2.3"), "v1.2.3");
  assert.equal(expectedReleaseTag("1.2.3-rc.1"), "v1.2.3-rc.1");
  assert.doesNotThrow(() =>
    assertReleaseTagMatchesCanonical("v1.2.3", "1.2.3"),
  );

  for (const tag of ["1.2.3", "v1.2.4", "release-1.2.3", ""]) {
    assert.throws(
      () => assertReleaseTagMatchesCanonical(tag, "1.2.3"),
      /must exactly match canonical distribution version v1\.2\.3/,
    );
  }
});

test("release artifact labels remain filename-safe", () => {
  for (const label of [
    "validation",
    "v1.2.3",
    "v1.2.3-rc.1+build.7",
    "mr_96",
  ]) {
    assert.equal(
      resolveReleaseArtifactLabel({ configuredLabel: label }),
      label,
    );
  }
  assert.equal(resolveReleaseArtifactLabel(), "validation");
  assert.equal(
    resolveReleaseArtifactLabel({
      releaseTag: "v1.2.3",
      configuredLabel: "ignored",
    }),
    "v1.2.3",
  );
  assert.equal(
    resolveReleaseArtifactLabel({
      configuredLabel: "a".repeat(RELEASE_ARTIFACT_LABEL_MAX_LENGTH),
    }).length,
    RELEASE_ARTIFACT_LABEL_MAX_LENGTH,
  );

  for (const label of [
    "../escape",
    "nested/path",
    "windows\\path",
    ".hidden",
    "-flag",
    "has space",
    "a".repeat(RELEASE_ARTIFACT_LABEL_MAX_LENGTH + 1),
  ]) {
    assert.throws(
      () => resolveReleaseArtifactLabel({ configuredLabel: label }),
      /filename-safe ASCII characters/,
    );
  }
  assert.throws(
    () => resolveReleaseArtifactLabel({ configuredLabel: 42 }),
    /must be a string/,
  );
});

test("bundle cleanup removes stale generated cjs files and preserves the canonical output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "distribution-bundles-"));
  const dist = path.join(root, "server", "dist");
  const canonical = path.join(dist, "gitlab-mcp.cjs");

  try {
    assert.deepEqual(
      await removeStaleMcpBundles(
        root,
        path.join(root, "missing", "bundle.cjs"),
      ),
      [],
    );

    await mkdir(dist, { recursive: true });
    await writeFile(canonical, "canonical");
    await writeFile(path.join(dist, "old-a.cjs"), "stale-a");
    await writeFile(path.join(dist, "old-b.cjs"), "stale-b");
    await writeFile(path.join(dist, "bundle.map"), "keep");
    await mkdir(path.join(dist, "directory.cjs"));

    if (process.platform !== "win32") {
      await symlink(
        path.join(dist, "old-a.cjs"),
        path.join(dist, "linked.cjs"),
      );
    }

    const expectedRemoved =
      process.platform === "win32"
        ? ["old-a.cjs", "old-b.cjs"]
        : ["linked.cjs", "old-a.cjs", "old-b.cjs"];
    assert.deepEqual(
      await removeStaleMcpBundles(root, canonical),
      expectedRemoved,
    );
    assert.equal(await readFile(canonical, "utf8"), "canonical");
    assert.equal(await readFile(path.join(dist, "bundle.map"), "utf8"), "keep");

    for (const staleName of expectedRemoved) {
      await assert.rejects(
        readFile(path.join(dist, staleName), "utf8"),
        (error) => error?.code === "ENOENT",
      );
    }

    await assert.rejects(
      removeStaleMcpBundles(root, path.join(canonical, "nested.cjs")),
      (error) => error?.code === "ENOTDIR",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "bundle cleanup rejects symlinked output directories that escape the repository",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "distribution-bundle-root-"),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "distribution-bundle-outside-"),
    );
    const dist = path.join(root, "server", "dist");
    const victim = path.join(outside, "victim.cjs");

    try {
      await mkdir(path.join(root, "server"), { recursive: true });
      await writeFile(victim, "preserve-me");
      await symlink(outside, dist, "dir");

      await assert.rejects(
        removeStaleMcpBundles(root, path.join(dist, "gitlab-mcp.cjs")),
        /must resolve inside the repository/,
      );
      assert.equal(await readFile(victim, "utf8"), "preserve-me");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

test(
  "bundle cleanup rejects a canonical bundle symlink before build can follow it",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "distribution-bundle-root-"),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "distribution-bundle-outside-"),
    );
    const dist = path.join(root, "server", "dist");
    const canonical = path.join(dist, "gitlab-mcp.cjs");
    const victim = path.join(outside, "victim.cjs");

    try {
      await mkdir(dist, { recursive: true });
      await writeFile(victim, "preserve-me");
      await symlink(victim, canonical);

      await assert.rejects(
        removeStaleMcpBundles(root, canonical),
        /must not be a symbolic link/,
      );
      assert.equal(await readFile(victim, "utf8"), "preserve-me");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

test("CycloneDX normalization removes volatile metadata reproducibly", () => {
  const fixture = (serialNumber, timestamp) =>
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber,
      metadata: {
        timestamp,
        component: {
          name: "gitlab-codex-plugin",
          licenses: [{ license: { id: "MIT" } }],
        },
      },
    });

  const first = normalizeCycloneDxSbom(
    fixture("urn:uuid:first", "2026-08-14T20:53:37.946Z"),
  );
  const second = normalizeCycloneDxSbom(
    fixture("urn:uuid:second", "2026-08-14T20:54:12.100Z"),
  );
  assert.equal(second, first);

  const normalized = JSON.parse(first);
  assert.equal("serialNumber" in normalized, false);
  assert.equal("timestamp" in normalized.metadata, false);
  assert.throws(() => normalizeCycloneDxSbom(""), /non-empty JSON string/);
  assert.throws(() => normalizeCycloneDxSbom(42), /non-empty JSON string/);
  assert.throws(
    () => normalizeCycloneDxSbom("{}"),
    /must use the CycloneDX format/,
  );
});
