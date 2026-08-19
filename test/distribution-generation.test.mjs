import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCanonicalDistributionResources,
  assertDistributionFiles,
  normalizeCanonicalDistribution,
  renderDistributionFiles,
  resolveRepositoryPath,
} from "../scripts/lib/distribution-config.mjs";

const CANONICAL = {
  schemaVersion: 1,
  name: "gitlab",
  version: "1.2.3",
  description: "Canonical GitLab distribution",
  license: "MIT",
  mcp: {
    bundle: "server/dist/gitlab-mcp.cjs",
  },
  skills: {
    directory: "skills",
  },
};

function fixtures() {
  return {
    canonical: CANONICAL,
    packageMetadata: {
      name: "@local/gitlab-mcp",
      version: "9.9.9",
      description: "stale",
      private: true,
      dependencies: {
        "@modelcontextprotocol/sdk": "1.29.0",
      },
    },
    packageLock: {
      name: "@local/stale-lock-package",
      version: "9.9.9",
      packages: {
        "": {
          name: "@local/stale-lock-package",
          version: "9.9.9",
        },
      },
    },
    codexManifest: {
      name: "stale-name",
      version: "9.9.9+codex.20260814120000",
      description: "stale",
      license: "Apache-2.0",
      skills: "./stale-skills/",
      author: {
        name: "Harness-specific author",
      },
    },
    codexMcpConfig: {
      mcpServers: {
        staleName: {
          command: "node",
          args: [
            "--import",
            "${PLUGIN_ROOT}/adapters/codex/preload.mjs",
            "${PLUGIN_ROOT}/server/dist/stale.cjs",
            "--stdio",
          ],
        },
      },
    },
    appConfig: {
      apps: {
        staleName: {
          id: "external-app-id",
          required: true,
        },
      },
    },
  };
}

test("canonical distribution metadata validates and freezes shared fields", () => {
  const normalized = normalizeCanonicalDistribution(CANONICAL);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.mcp), true);

  const normalizedTrailingSlashes = normalizeCanonicalDistribution({
    ...CANONICAL,
    skills: { directory: "skills///" },
  });
  assert.equal(normalizedTrailingSlashes.skills.directory, "skills");

  const normalizedPrerelease = normalizeCanonicalDistribution({
    ...CANONICAL,
    version: "1.2.3-rc.1",
  });
  assert.equal(normalizedPrerelease.version, "1.2.3-rc.1");

  for (const [metadata, expected] of [
    [{ ...CANONICAL, schemaVersion: 2 }, /schemaVersion must be 1/],
    [{ ...CANONICAL, name: "GitLab" }, /lowercase letters/],
    [{ ...CANONICAL, description: "  " }, /must be a non-empty string/],
    [{ ...CANONICAL, version: "1.2.3+codex" }, /valid SemVer base version/],
    [{ ...CANONICAL, version: "01.2.3" }, /valid SemVer base version/],
    [{ ...CANONICAL, version: "1.02.3" }, /valid SemVer base version/],
    [{ ...CANONICAL, version: "1.2.03" }, /valid SemVer base version/],
    [{ ...CANONICAL, version: "1.2.3-01" }, /valid SemVer base version/],
    [{ ...CANONICAL, version: "1.2.3-alpha..1" }, /valid SemVer base version/],
    [{ ...CANONICAL, version: "1.2.3-" }, /valid SemVer base version/],
    [
      { ...CANONICAL, mcp: { bundle: "../outside.cjs" } },
      /repository-relative path/,
    ],
    [
      { ...CANONICAL, mcp: { bundle: "dist/custom-mcp.cjs" } },
      /directly under server\/dist/,
    ],
    [
      { ...CANONICAL, mcp: { bundle: "%2e%2e/out.cjs" } },
      /directly under server\/dist/,
    ],
    [
      { ...CANONICAL, mcp: { bundle: "server/dist/nested/custom.cjs" } },
      /directly under server\/dist/,
    ],
  ]) {
    assert.throws(() => normalizeCanonicalDistribution(metadata), expected);
  }
});

test("repository path resolution cannot escape through filesystem semantics", () => {
  const root = path.resolve("repo-root");
  assert.equal(
    resolveRepositoryPath(root, "server/dist/custom-mcp.cjs", "bundle"),
    path.join(root, "server", "dist", "custom-mcp.cjs"),
  );
  assert.equal(
    resolveRepositoryPath(root, "%2e%2e/out.cjs", "bundle"),
    path.join(root, "%2e%2e", "out.cjs"),
  );
  assert.throws(
    () => resolveRepositoryPath(root, "../outside.cjs", "bundle"),
    /bundle escapes the repository/,
  );
});

test("canonical Skills directory must exist inside the repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "distribution-resources-"));
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "distribution-outside-"),
  );
  try {
    await mkdir(path.join(root, "skills"));
    const canonical = await assertCanonicalDistributionResources(
      root,
      CANONICAL,
    );
    assert.equal(canonical.skills.directory, "skills");

    await assert.rejects(
      assertCanonicalDistributionResources(root, {
        ...CANONICAL,
        skills: { directory: "missing-skills" },
      }),
      /must reference an existing directory/,
    );

    await writeFile(path.join(root, "not-a-directory"), "fixture");
    await assert.rejects(
      assertCanonicalDistributionResources(root, {
        ...CANONICAL,
        skills: { directory: "not-a-directory" },
      }),
      /must reference an existing directory/,
    );

    if (process.platform !== "win32") {
      const internalSkills = path.join(root, "internal-skills");
      await mkdir(internalSkills);
      await symlink(
        internalSkills,
        path.join(root, "linked-internal-skills"),
        "dir",
      );
      await assert.rejects(
        assertCanonicalDistributionResources(root, {
          ...CANONICAL,
          skills: { directory: "linked-internal-skills" },
        }),
        /must not be a symbolic link/,
      );

      await mkdir(path.join(outside, "skills"));
      await symlink(outside, path.join(root, "linked-parent"), "dir");
      await assert.rejects(
        assertCanonicalDistributionResources(root, {
          ...CANONICAL,
          skills: { directory: "linked-parent/skills" },
        }),
        /must resolve inside the repository/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("generation synchronizes shared fields while preserving harness-specific data", () => {
  const rendered = renderDistributionFiles(fixtures());
  const packageMetadata = JSON.parse(rendered["package.json"]);
  const packageLock = JSON.parse(rendered["package-lock.json"]);
  const codexManifest = JSON.parse(rendered[".codex-plugin/plugin.json"]);
  const codexMcpConfig = JSON.parse(rendered[".mcp.json"]);
  const appConfig = JSON.parse(rendered[".app.json"]);

  assert.equal(packageMetadata.name, "@local/gitlab-mcp");
  assert.equal(packageMetadata.version, CANONICAL.version);
  assert.equal(packageMetadata.description, CANONICAL.description);
  assert.equal(packageLock.name, packageMetadata.name);
  assert.equal(packageLock.version, CANONICAL.version);
  assert.equal(packageLock.packages[""].name, packageMetadata.name);
  assert.equal(packageLock.packages[""].version, CANONICAL.version);
  assert.equal(packageLock.packages[""].license, CANONICAL.license);

  assert.equal(codexManifest.name, CANONICAL.name);
  assert.equal(
    codexManifest.version,
    `${CANONICAL.version}+codex.20260814120000`,
  );
  assert.equal(codexManifest.description, CANONICAL.description);
  assert.equal(codexManifest.license, CANONICAL.license);
  assert.equal(codexManifest.skills, "./skills/");
  assert.deepEqual(codexManifest.author, {
    name: "Harness-specific author",
  });

  assert.deepEqual(Object.keys(codexMcpConfig.mcpServers), [CANONICAL.name]);
  assert.deepEqual(codexMcpConfig.mcpServers.gitlab.args, [
    "--import",
    "${PLUGIN_ROOT}/adapters/codex/preload.mjs",
    "${PLUGIN_ROOT}/server/dist/gitlab-mcp.cjs",
    "--stdio",
  ]);
  assert.deepEqual(Object.keys(appConfig.apps), [CANONICAL.name]);
  assert.deepEqual(appConfig.apps.gitlab, {
    id: "external-app-id",
    required: true,
  });
  assert.equal(rendered["server/src/version.mjs"], undefined);
  assert.equal(rendered["server/test/mcp-contract.test.mjs"], undefined);
});

test("generation rejects malformed package and distribution inputs", () => {
  {
    const input = fixtures();
    input.packageMetadata.name = "   ";
    assert.throws(
      () => renderDistributionFiles(input),
      /package\.json requires a non-empty name/,
    );
  }

  {
    const input = fixtures();
    input.packageLock.packages = {};
    assert.throws(
      () => renderDistributionFiles(input),
      /package-lock\.json requires a root package entry/,
    );
  }

  {
    const input = fixtures();
    input.codexMcpConfig = {};
    assert.throws(
      () => renderDistributionFiles(input),
      /requires an mcpServers object/,
    );
  }

  {
    const input = fixtures();
    input.codexMcpConfig.mcpServers.other = {
      command: "node",
      args: ["server/dist/other.cjs"],
    };
    assert.throws(
      () => renderDistributionFiles(input),
      /Cannot determine which Codex MCP server/,
    );
  }

  {
    const input = fixtures();
    input.codexMcpConfig.mcpServers.staleName.args = "not-an-array";
    assert.throws(
      () => renderDistributionFiles(input),
      /requires an args array/,
    );
  }

  {
    const input = fixtures();
    input.codexMcpConfig.mcpServers.staleName.args = [
      "--import",
      "${PLUGIN_ROOT}/adapters/codex/preload.mjs",
      "--stdio",
    ];
    assert.throws(
      () => renderDistributionFiles(input),
      /exactly one server\/dist\/\*\.cjs bundle argument/,
    );
  }

  {
    const input = fixtures();
    input.codexMcpConfig.mcpServers.staleName.args.push(
      "${PLUGIN_ROOT}/server/dist/second.cjs",
    );
    assert.throws(
      () => renderDistributionFiles(input),
      /exactly one server\/dist\/\*\.cjs bundle argument/,
    );
  }

  {
    const input = fixtures();
    input.appConfig = {};
    assert.throws(
      () => renderDistributionFiles(input),
      /App config requires an apps object/,
    );
  }

  {
    const input = fixtures();
    input.appConfig.apps.other = {
      id: "second-app-id",
      required: false,
    };
    assert.throws(
      () => renderDistributionFiles(input),
      /Cannot determine which app entry/,
    );
  }
});

test("generation is deterministic and idempotent", () => {
  const first = renderDistributionFiles(fixtures());
  const second = renderDistributionFiles({
    canonical: CANONICAL,
    packageMetadata: JSON.parse(first["package.json"]),
    packageLock: JSON.parse(first["package-lock.json"]),
    codexManifest: JSON.parse(first[".codex-plugin/plugin.json"]),
    codexMcpConfig: JSON.parse(first[".mcp.json"]),
    appConfig: JSON.parse(first[".app.json"]),
  });

  assert.deepEqual(second, first);
});

test("generation stays idempotent when the canonical bundle filename changes", () => {
  const input = fixtures();
  const canonical = {
    ...CANONICAL,
    mcp: { bundle: "server/dist/custom-mcp.cjs" },
  };
  input.canonical = canonical;

  const first = renderDistributionFiles(input);
  assert.deepEqual(JSON.parse(first[".mcp.json"]).mcpServers.gitlab.args, [
    "--import",
    "${PLUGIN_ROOT}/adapters/codex/preload.mjs",
    "${PLUGIN_ROOT}/server/dist/custom-mcp.cjs",
    "--stdio",
  ]);

  const second = renderDistributionFiles({
    canonical,
    packageMetadata: JSON.parse(first["package.json"]),
    packageLock: JSON.parse(first["package-lock.json"]),
    codexManifest: JSON.parse(first[".codex-plugin/plugin.json"]),
    codexMcpConfig: JSON.parse(first[".mcp.json"]),
    appConfig: JSON.parse(first[".app.json"]),
  });

  assert.deepEqual(second, first);
});

test("drift checking fails when a generated shared field changes", () => {
  const expected = renderDistributionFiles(fixtures());
  const actual = { ...expected };
  actual["package.json"] = actual["package.json"].replace(
    '"version": "1.2.3"',
    '"version": "9.9.9"',
  );

  assert.throws(
    () => assertDistributionFiles(actual, expected),
    /Distribution metadata drift detected in package\.json/,
  );
});
