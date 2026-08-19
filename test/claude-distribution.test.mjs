import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClaudeMcpServerLaunch,
  assertClaudePluginManifest,
  CLAUDE_DISTRIBUTION,
  CLAUDE_PLUGIN_MANIFEST_SCHEMA,
  CLAUDE_PLUGIN_ROOT_PLACEHOLDER,
  expectedClaudeMcpServer,
  renderClaudeDistributionFiles,
  renderClaudeMcpConfig,
  renderClaudePluginManifest,
} from "../adapters/claude/distribution.mjs";

const CANONICAL = {
  name: "gitlab",
  version: "1.2.3",
  description: "Canonical GitLab distribution",
  license: "MIT",
  mcp: { bundle: "server/dist/gitlab-mcp.cjs" },
  skills: { directory: "skills" },
};

test("Claude adapter contract owns only Claude packaging surfaces", () => {
  assert.equal(CLAUDE_DISTRIBUTION.id, "claude");
  assert.equal(CLAUDE_DISTRIBUTION.artifactName, "gitlab-claude-code-mcp");
  assert.deepEqual(CLAUDE_DISTRIBUTION.generatedFiles, [
    "adapters/claude/.claude-plugin/plugin.json",
    "adapters/claude/.mcp.json",
  ]);
  assert.deepEqual(CLAUDE_DISTRIBUTION.packageFiles, [
    {
      source: "adapters/claude/.claude-plugin/plugin.json",
      target: ".claude-plugin/plugin.json",
    },
    {
      source: "adapters/claude/.mcp.json",
      target: ".mcp.json",
    },
    { source: "adapters/claude/README.md", target: "README.md" },
    { source: "distribution.json", target: "distribution.json" },
    { source: "LICENSE", target: "LICENSE" },
  ]);
  assert.equal(Object.isFrozen(CLAUDE_DISTRIBUTION), true);
  assert.equal(Object.isFrozen(CLAUDE_DISTRIBUTION.generatedFiles), true);
  assert.equal(Object.isFrozen(CLAUDE_DISTRIBUTION.packageFiles), true);
  assert.equal(Object.isFrozen(CLAUDE_DISTRIBUTION.files), true);
  assert.equal(Object.isFrozen(CLAUDE_DISTRIBUTION.packagePaths), true);
  for (const mapping of CLAUDE_DISTRIBUTION.packageFiles) {
    assert.equal(Object.isFrozen(mapping), true);
  }
});

test("Claude manifest is generated from canonical distribution metadata", () => {
  const manifest = renderClaudePluginManifest(CANONICAL);
  assert.deepEqual(manifest, {
    $schema: CLAUDE_PLUGIN_MANIFEST_SCHEMA,
    name: "gitlab",
    version: "1.2.3",
    description: "Canonical GitLab distribution",
    license: "MIT",
    mcpServers: "./.mcp.json",
  });
  assert.equal(assertClaudePluginManifest(manifest, CANONICAL), manifest);

  for (const field of [
    "$schema",
    "name",
    "version",
    "description",
    "license",
    "mcpServers",
  ]) {
    assert.throws(
      () =>
        assertClaudePluginManifest(
          { ...manifest, [field]: "unexpected" },
          CANONICAL,
        ),
      new RegExp(`manifest ${field.replace("$", "\\$")} must match`),
    );
  }

  assert.throws(
    () => assertClaudePluginManifest(null, CANONICAL),
    /manifest must be an object/,
  );
});

test("Claude MCP configuration uses the relocatable plugin root and canonical bundle", () => {
  assert.deepEqual(expectedClaudeMcpServer(CANONICAL), {
    command: "node",
    args: [
      `${CLAUDE_PLUGIN_ROOT_PLACEHOLDER}/server/dist/gitlab-mcp.cjs`,
      "--stdio",
    ],
  });
  assert.deepEqual(renderClaudeMcpConfig(CANONICAL), {
    mcpServers: {
      gitlab: expectedClaudeMcpServer(CANONICAL),
    },
  });

  const rendered = renderClaudeDistributionFiles({ canonical: CANONICAL });
  assert.deepEqual(
    JSON.parse(rendered[CLAUDE_DISTRIBUTION.files.manifest]),
    renderClaudePluginManifest(CANONICAL),
  );
  assert.deepEqual(
    JSON.parse(rendered[CLAUDE_DISTRIBUTION.files.mcpConfig]),
    renderClaudeMcpConfig(CANONICAL),
  );
  assert.match(
    rendered[CLAUDE_DISTRIBUTION.files.mcpConfig],
    /"args": \["\$\{CLAUDE_PLUGIN_ROOT\}\/server\/dist\/gitlab-mcp\.cjs", "--stdio"\]/,
  );
});

test("Claude launch validation supports materialized POSIX and Windows plugin roots", () => {
  assert.deepEqual(expectedClaudeMcpServer(CANONICAL, "/opt/gitlab-claude"), {
    command: "node",
    args: ["/opt/gitlab-claude/server/dist/gitlab-mcp.cjs", "--stdio"],
  });
  assert.deepEqual(
    expectedClaudeMcpServer(CANONICAL, "/opt/gitlab-claude///"),
    {
      command: "node",
      args: ["/opt/gitlab-claude/server/dist/gitlab-mcp.cjs", "--stdio"],
    },
  );
  assert.deepEqual(
    expectedClaudeMcpServer(CANONICAL, "C:\\tools\\gitlab-claude\\"),
    {
      command: "node",
      args: ["C:/tools/gitlab-claude/server/dist/gitlab-mcp.cjs", "--stdio"],
    },
  );
  assert.deepEqual(expectedClaudeMcpServer(CANONICAL, "C:\\"), {
    command: "node",
    args: ["C:/server/dist/gitlab-mcp.cjs", "--stdio"],
  });

  const server = {
    ...expectedClaudeMcpServer(CANONICAL, "/opt/gitlab-claude"),
    env: { GITLAB_URL: "https://gitlab.example.com" },
  };
  assert.equal(
    assertClaudeMcpServerLaunch(server, CANONICAL, "/opt/gitlab-claude"),
    server,
  );
  assert.throws(
    () =>
      assertClaudeMcpServerLaunch(
        { ...server, command: "bun" },
        CANONICAL,
        "/opt/gitlab-claude",
      ),
    /launch must match the canonical launch/,
  );
  assert.throws(
    () =>
      assertClaudeMcpServerLaunch(
        { ...server, args: [...server.args, "--unexpected"] },
        CANONICAL,
        "/opt/gitlab-claude",
      ),
    /launch must match the canonical launch/,
  );

  for (const invalidRoot of [
    "",
    "relative/plugin",
    "C:relative\\plugin",
    "1:\\tools\\gitlab-claude",
  ]) {
    assert.throws(
      () => expectedClaudeMcpServer(CANONICAL, invalidRoot),
      /plugin root must be a non-empty absolute path/,
    );
  }
});

test("Claude generated MCP configuration follows a changed canonical bundle path", () => {
  const canonical = {
    ...CANONICAL,
    mcp: { bundle: "server/dist/custom-mcp.cjs" },
  };
  assert.deepEqual(renderClaudeMcpConfig(canonical).mcpServers.gitlab.args, [
    `${CLAUDE_PLUGIN_ROOT_PLACEHOLDER}/server/dist/custom-mcp.cjs`,
    "--stdio",
  ]);
});
