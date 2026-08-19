import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClineMcpServerLaunch,
  CLINE_DISTRIBUTION,
  CLINE_INSTALL_ROOT_PLACEHOLDER,
  expectedClineMcpServer,
  renderClineDistributionFiles,
  renderClineMcpSettings,
} from "../adapters/cline/distribution.mjs";
import {
  assertClineSkillFrontmatter,
  CLINE_SKILL_COMPATIBILITY_MAX_LENGTH,
  CLINE_SKILL_DESCRIPTION_MAX_LENGTH,
  CLINE_SKILL_NAME_MAX_LENGTH,
} from "../adapters/cline/skill-validation.mjs";

const CANONICAL = {
  name: "gitlab",
  version: "1.2.3",
  description: "Canonical GitLab distribution",
  license: "MIT",
  mcp: { bundle: "server/dist/gitlab-mcp.cjs" },
  skills: { directory: "skills" },
};

test("Cline adapter contract owns only Cline packaging surfaces", () => {
  assert.equal(CLINE_DISTRIBUTION.id, "cline");
  assert.equal(CLINE_DISTRIBUTION.artifactName, "gitlab-cline-mcp");
  assert.deepEqual(CLINE_DISTRIBUTION.generatedFiles, [
    "adapters/cline/cline_mcp_settings.template.json",
  ]);
  assert.deepEqual(CLINE_DISTRIBUTION.packageFiles, [
    "adapters/cline/cline_mcp_settings.template.json",
    "adapters/cline/README.md",
    "distribution.json",
    "LICENSE",
  ]);
  assert.deepEqual(CLINE_DISTRIBUTION.skills, {
    projectDirectory: ".cline/skills",
    globalDirectory: "~/.cline/skills",
  });
  assert.equal(Object.isFrozen(CLINE_DISTRIBUTION), true);
  assert.equal(Object.isFrozen(CLINE_DISTRIBUTION.generatedFiles), true);
  assert.equal(Object.isFrozen(CLINE_DISTRIBUTION.packageFiles), true);
  assert.equal(Object.isFrozen(CLINE_DISTRIBUTION.files), true);
  assert.equal(Object.isFrozen(CLINE_DISTRIBUTION.skills), true);
});

test("Cline settings template uses the canonical MCP bundle with an explicit installation-root placeholder", () => {
  assert.deepEqual(expectedClineMcpServer(CANONICAL), {
    command: "node",
    args: [
      `${CLINE_INSTALL_ROOT_PLACEHOLDER}/server/dist/gitlab-mcp.cjs`,
      "--stdio",
    ],
  });

  const rendered = renderClineDistributionFiles({ canonical: CANONICAL });
  assert.deepEqual(
    JSON.parse(rendered[CLINE_DISTRIBUTION.files.mcpSettingsTemplate]),
    renderClineMcpSettings(CANONICAL),
  );
});

test("Cline settings rendering accepts POSIX and Windows absolute installation roots", () => {
  assert.deepEqual(renderClineMcpSettings(CANONICAL, "/opt/gitlab-mcp"), {
    mcpServers: {
      gitlab: {
        command: "node",
        args: ["/opt/gitlab-mcp/server/dist/gitlab-mcp.cjs", "--stdio"],
      },
    },
  });
  assert.deepEqual(
    renderClineMcpSettings(CANONICAL, "C:\\tools\\gitlab-mcp\\"),
    {
      mcpServers: {
        gitlab: {
          command: "node",
          args: ["C:/tools/gitlab-mcp/server/dist/gitlab-mcp.cjs", "--stdio"],
        },
      },
    },
  );
  assert.deepEqual(renderClineMcpSettings(CANONICAL, "/"), {
    mcpServers: {
      gitlab: {
        command: "node",
        args: ["/server/dist/gitlab-mcp.cjs", "--stdio"],
      },
    },
  });
  assert.deepEqual(renderClineMcpSettings(CANONICAL, "C:\\"), {
    mcpServers: {
      gitlab: {
        command: "node",
        args: ["C:/server/dist/gitlab-mcp.cjs", "--stdio"],
      },
    },
  });

  for (const invalidRoot of ["", "relative/path", null]) {
    assert.throws(
      () => renderClineMcpSettings(CANONICAL, invalidRoot),
      /installation root must be a non-empty absolute path/,
    );
  }

  assert.deepEqual(
    renderClineMcpSettings(CANONICAL, undefined),
    renderClineMcpSettings(CANONICAL),
  );
});

test("Cline launch validation checks owned fields and permits unrelated server metadata", () => {
  const server = {
    ...expectedClineMcpServer(CANONICAL, "/opt/gitlab-mcp"),
    env: { GITLAB_URL: "https://gitlab.example.com" },
    disabled: false,
  };
  assert.equal(
    assertClineMcpServerLaunch(server, CANONICAL, "/opt/gitlab-mcp"),
    server,
  );
  assert.throws(
    () =>
      assertClineMcpServerLaunch(
        { ...server, command: "bun" },
        CANONICAL,
        "/opt/gitlab-mcp",
      ),
    /launch must match the canonical launch/,
  );
  assert.throws(
    () =>
      assertClineMcpServerLaunch(
        { ...server, args: [...server.args, "--unexpected"] },
        CANONICAL,
        "/opt/gitlab-mcp",
      ),
    /launch must match the canonical launch/,
  );
});

test("Cline Skill validation reads standards-compliant YAML frontmatter", () => {
  const description = "a".repeat(CLINE_SKILL_DESCRIPTION_MAX_LENGTH);
  assert.deepEqual(
    assertClineSkillFrontmatter(
      `---\nname: review-skill\ndescription: ${description}\n---\nname: ignored-body-name\n`,
      "review-skill",
    ),
    { name: "review-skill", description },
  );

  const structured = assertClineSkillFrontmatter(
    [
      "---",
      'name: "review-skill"',
      "description: >",
      "  folded description",
      "license: MIT",
      "compatibility: Requires git and network access",
      "metadata:",
      "  owner: platform",
      '  version: "1.0"',
      'allowed-tools: "Bash(git:*) Read"',
      "---",
      "",
    ].join("\n"),
    "review-skill",
  );
  assert.equal(structured.name, "review-skill");
  assert.equal(structured.description.trim(), "folded description");

  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nname: review-skill\ndescription: valid\n# no closing delimiter\n",
        "review-skill",
      ),
    /must close YAML frontmatter/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nowner: platform\n---\nname: review-skill\ndescription: body-only metadata\n",
        "review-skill",
      ),
    /frontmatter must contain a name field/,
  );
});

test("Cline Skill validation enforces Agent Skills name rules", () => {
  assert.equal(
    assertClineSkillFrontmatter(
      `---\nname: ${"a".repeat(CLINE_SKILL_NAME_MAX_LENGTH)}\ndescription: valid\n---\n`,
      "a".repeat(CLINE_SKILL_NAME_MAX_LENGTH),
    ).name.length,
    CLINE_SKILL_NAME_MAX_LENGTH,
  );

  for (const invalidName of [
    "Review-skill",
    "-review-skill",
    "review-skill-",
    "review--skill",
    "a".repeat(CLINE_SKILL_NAME_MAX_LENGTH + 1),
  ]) {
    assert.throws(
      () =>
        assertClineSkillFrontmatter(
          `---\nname: ${invalidName}\ndescription: valid\n---\n`,
          invalidName,
        ),
      /name must be 1-64 lowercase letters, numbers, or single hyphens/,
    );
  }
});

test("Cline Skill validation rejects invalid required metadata", () => {
  assert.throws(
    () => assertClineSkillFrontmatter(null, "review-skill"),
    /must be UTF-8 text/,
  );
  assert.throws(
    () => assertClineSkillFrontmatter("---\nname: review-skill\n---\n", ""),
    /directory name must be a non-empty string/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "name: review-skill\ndescription: valid\n---\n",
        "review-skill",
      ),
    /must start with YAML frontmatter/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nname: other-skill\ndescription: valid\n---\n",
        "review-skill",
      ),
    /name must match its directory/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nname: review-skill\ndescription:\n---\n",
        "review-skill",
      ),
    /description must be a string/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nname: review-skill\ndescription: '   '\n---\n",
        "review-skill",
      ),
    /must provide a non-empty description/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nname: 123\ndescription: valid\n---\n",
        "review-skill",
      ),
    /name must be a string/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nname: review-skill\ndescription: [not, a, string]\n---\n",
        "review-skill",
      ),
    /description must be a string/,
  );
});

test("Cline Skill validation enforces optional Agent Skills field contracts", () => {
  const base = "---\nname: review-skill\ndescription: valid\n";

  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        `${base}compatibility: ${"a".repeat(CLINE_SKILL_COMPATIBILITY_MAX_LENGTH + 1)}\n---\n`,
        "review-skill",
      ),
    /compatibility must be at most 500 characters/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        `${base}compatibility: [cline, codex]\n---\n`,
        "review-skill",
      ),
    /compatibility must be a string/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        `${base}metadata:\n  owner:\n    team: platform\n---\n`,
        "review-skill",
      ),
    /metadata values must be strings/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        `${base}allowed-tools: [Read]\n---\n`,
        "review-skill",
      ),
    /allowed-tools must be a string/,
  );
});

test("Cline Skill validation rejects malformed and duplicate YAML", () => {
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        '---\nname: review-skill\ndescription: "unterminated\n---\n',
        "review-skill",
      ),
    /frontmatter must be valid YAML/,
  );
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        "---\nname: review-skill\nname: duplicate\ndescription: valid\n---\n",
        "review-skill",
      ),
    /frontmatter must be valid YAML/,
  );
  assert.throws(
    () => assertClineSkillFrontmatter("---\n- list\n---\n", "review-skill"),
    /frontmatter must be a YAML mapping/,
  );
});

test("Cline Skill validation rejects descriptions over 1024 characters", () => {
  const description = "a".repeat(CLINE_SKILL_DESCRIPTION_MAX_LENGTH + 1);
  assert.throws(
    () =>
      assertClineSkillFrontmatter(
        `---\nname: review-skill\ndescription: ${description}\n---\n`,
        "review-skill",
      ),
    /description must be at most 1024 characters/,
  );
});
