import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCodexMcpServerLaunch,
  CODEX_DISTRIBUTION,
  expectedCodexMcpServer,
  isValidCodexManifestVersion,
  renderCodexDistributionFiles,
} from "../adapters/codex/distribution.mjs";

const CANONICAL = {
  name: "gitlab",
  version: "1.2.3",
  description: "Canonical GitLab distribution",
  license: "MIT",
  mcp: { bundle: "server/dist/gitlab-mcp.cjs" },
  skills: { directory: "skills" },
};

function codexInputs(version = "9.9.9+codex.20260814120000") {
  return {
    canonical: CANONICAL,
    codexManifest: {
      name: "stale",
      version,
      description: "stale",
      license: "Apache-2.0",
      skills: "./old-skills/",
      mcpServers: "./stale-mcp.json",
      author: { name: "Harness author" },
    },
    codexMcpConfig: {
      mcpServers: {
        stale: {
          command: "bun",
          args: [
            "--import",
            "${PLUGIN_ROOT}/legacy/preload.mjs",
            "${PLUGIN_ROOT}/server/dist/stale.cjs",
            "--stdio",
          ],
          env: { HARNESS_ONLY: "preserved" },
        },
      },
    },
    appConfig: {
      apps: {
        stale: { id: "external-app-id", required: true },
      },
    },
  };
}

test("Codex adapter contract owns its compatibility surfaces and launch path", () => {
  assert.equal(CODEX_DISTRIBUTION.id, "codex");
  assert.equal(CODEX_DISTRIBUTION.artifactName, "gitlab-codex-plugin");
  assert.deepEqual(CODEX_DISTRIBUTION.generatedFiles, [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    ".app.json",
  ]);
  assert.equal(Object.isFrozen(CODEX_DISTRIBUTION), true);
  assert.equal(Object.isFrozen(CODEX_DISTRIBUTION.files), true);
  assert.equal(Object.isFrozen(CODEX_DISTRIBUTION.generatedFiles), true);
  assert.deepEqual(expectedCodexMcpServer(CANONICAL), {
    command: "node",
    args: [
      "--import",
      "${PLUGIN_ROOT}/adapters/codex/preload.mjs",
      "${PLUGIN_ROOT}/server/dist/gitlab-mcp.cjs",
      "--stdio",
    ],
  });
});

test("Codex manifest version accepts the canonical base or valid Codex build metadata only", () => {
  assert.equal(isValidCodexManifestVersion("1.2.3", "1.2.3"), true);
  assert.equal(
    isValidCodexManifestVersion("1.2.3", "1.2.3+codex.20260814120000"),
    true,
  );
  assert.equal(
    isValidCodexManifestVersion("1.2.3", "1.2.3+codex.release-1.sha-abc123"),
    true,
  );

  for (const invalidVersion of [
    "1.2.3+other",
    "1.2.3+codex.",
    "1.2.3+codex.foo..bar",
    "1.2.3+codex.foo bar",
    "1.2.3+codex.foo+bar",
    "1.2.3+codex.???",
  ]) {
    assert.equal(
      isValidCodexManifestVersion("1.2.3", invalidVersion),
      false,
      invalidVersion,
    );
  }

  assert.throws(
    () => renderCodexDistributionFiles(codexInputs("9.9.9+other")),
    /build metadata must use \+codex\.<qualifier> with valid SemVer build identifiers/,
  );
});

test("Codex rendering rejects unexpected MCP server and app entries", () => {
  const extraServer = codexInputs();
  extraServer.codexMcpConfig.mcpServers.unexpected = {
    command: "node",
    args: ["unexpected.mjs"],
  };
  assert.throws(
    () => renderCodexDistributionFiles(extraServer),
    /Codex MCP server configuration must contain exactly one entry/,
  );

  const extraApp = codexInputs();
  extraApp.appConfig.apps.unexpected = { id: "unexpected-app" };
  assert.throws(
    () => renderCodexDistributionFiles(extraApp),
    /Codex app configuration must contain exactly one entry/,
  );
});

test("Codex rendering rejects array-shaped MCP server and app collections", () => {
  const arrayServers = codexInputs();
  arrayServers.codexMcpConfig.mcpServers = [
    arrayServers.codexMcpConfig.mcpServers.stale,
  ];
  assert.throws(
    () => renderCodexDistributionFiles(arrayServers),
    /Codex MCP config requires an mcpServers object/,
  );

  const arrayApps = codexInputs();
  arrayApps.appConfig.apps = [arrayApps.appConfig.apps.stale];
  assert.throws(
    () => renderCodexDistributionFiles(arrayApps),
    /App config requires an apps object/,
  );
});

test("Codex launch validation checks owned fields and permits unrelated server metadata", () => {
  const server = {
    ...expectedCodexMcpServer(CANONICAL),
    env: { HARNESS_ONLY: "preserved" },
  };
  assert.equal(assertCodexMcpServerLaunch(server, CANONICAL), server);

  assert.throws(
    () => assertCodexMcpServerLaunch({ ...server, command: "bun" }, CANONICAL),
    /command must match the canonical launch/,
  );
  assert.throws(
    () =>
      assertCodexMcpServerLaunch(
        { ...server, args: [...server.args, "--unexpected"] },
        CANONICAL,
      ),
    /args must match the canonical launch/,
  );
});

test("Codex rendering canonicalizes owned launch details while preserving unrelated harness metadata", () => {
  const rendered = renderCodexDistributionFiles(codexInputs());

  const manifest = JSON.parse(rendered[CODEX_DISTRIBUTION.files.manifest]);
  assert.equal(manifest.name, CANONICAL.name);
  assert.equal(manifest.version, "1.2.3+codex.20260814120000");
  assert.equal(manifest.description, CANONICAL.description);
  assert.equal(manifest.license, CANONICAL.license);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(manifest.author, { name: "Harness author" });

  const mcpConfig = JSON.parse(rendered[CODEX_DISTRIBUTION.files.mcpConfig]);
  assert.deepEqual(mcpConfig.mcpServers.gitlab, {
    ...expectedCodexMcpServer(CANONICAL),
    env: { HARNESS_ONLY: "preserved" },
  });
  assert.equal(
    assertCodexMcpServerLaunch(mcpConfig.mcpServers.gitlab, CANONICAL),
    mcpConfig.mcpServers.gitlab,
  );

  const appConfig = JSON.parse(rendered[CODEX_DISTRIBUTION.files.appConfig]);
  assert.deepEqual(appConfig.apps.gitlab, {
    id: "external-app-id",
    required: true,
  });
});
