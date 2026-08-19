import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  GitLabApiError,
  GitLabAuthenticationError,
} from "../src/gitlab-client.mjs";
import { createGitLabMcpServer, decorateToolSecurity } from "../src/server.mjs";
import { SERVER_VERSION } from "../src/version.mjs";

async function connectedPair(clientFactory, options = {}) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({ ...options, clientFactory });
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test("advertises a broad GitLab parity tool surface with annotations", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async () => ({ data: {} }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

  assert.equal(
    listed.tools.length,
    147,
    `expected 147 tools, got ${listed.tools.length}`,
  );
  for (const name of [
    "get_runtime_info",
    "get_gitlab_capabilities",
    "list_groups",
    "list_group_projects",
    "search_gitlab",
    "search_projects",
    "get_project_member",
    "get_blob",
    "get_file",
    "fetch_gitlab_file_url",
    "download_gitlab_attachment",
    "create_file",
    "create_branch",
    "create_commit",
    "create_destructive_commit",
    "list_commit_diffs",
    "create_issue",
    "list_global_issues",
    "update_issue",
    "list_issue_reactions",
    "create_merge_request",
    "list_merge_request_diffs",
    "get_merge_request_file_patch",
    "list_merge_request_discussions",
    "resolve_merge_request_discussion",
    "list_merge_request_reactions",
    "list_pipeline_jobs",
    "create_pipeline",
    "get_latest_pipeline",
    "get_pipeline_test_report",
    "get_pipeline_test_report_summary",
    "list_pipeline_bridges",
    "list_project_jobs",
    "get_job_log",
    "get_job_artifact_archive",
    "retry_pipeline",
    "merge_merge_request",
    "list_project_runners",
    "lint_ci_configuration",
    "list_protected_branches",
    "protect_branch",
    "update_protected_branch",
    "unprotect_branch",
    "list_project_approval_rules",
    "create_project_approval_rule",
    "update_project_approval_rule",
    "delete_project_approval_rule",
    "list_tags",
    "create_tag",
    "delete_tag",
    "list_releases",
    "create_release",
    "delete_release",
    "list_release_asset_links",
    "get_release_asset_link",
    "create_release_asset_link",
    "update_release_asset_link",
    "delete_release_asset_link",
    "list_pipeline_schedules",
    "create_pipeline_schedule",
    "create_pipeline_schedule_variable",
    "update_pipeline_schedule_variable",
    "delete_pipeline_schedule_variable",
    "list_project_ci_variables",
    "get_project_ci_variable",
    "create_project_ci_variable",
    "update_project_ci_variable",
    "delete_project_ci_variable",
    "list_group_ci_variables",
    "get_group_ci_variable",
    "create_group_ci_variable",
    "update_group_ci_variable",
    "delete_group_ci_variable",
  ]) {
    assert.ok(byName.has(name), `missing parity tool ${name}`);
    assert.equal(byName.get(name).outputSchema.type, "object");
    assert.equal(byName.get(name).annotations.openWorldHint, true);
  }

  assert.equal(byName.get("get_file").annotations.readOnlyHint, true);
  assert.equal(
    byName.get("get_gitlab_capabilities").annotations.readOnlyHint,
    true,
  );
  assert.equal(
    byName.get("get_gitlab_capabilities").annotations.idempotentHint,
    true,
  );
  assert.equal(byName.get("create_file").annotations.readOnlyHint, false);
  assert.equal(byName.get("delete_file").annotations.destructiveHint, true);
  const safeCommit = byName.get("create_commit");
  const destructiveCommit = byName.get("create_destructive_commit");
  assert.equal(safeCommit.annotations.destructiveHint, false);
  assert.equal(destructiveCommit.annotations.destructiveHint, true);
  assert.match(
    destructiveCommit.outputSchema.properties.result.description,
    /Created destructive GitLab commit/,
  );
  assert.equal(safeCommit.inputSchema.properties.force, undefined);
  assert.ok(destructiveCommit.inputSchema.properties.force);
  assert.equal(
    destructiveCommit.inputSchema.required.includes("start_sha"),
    true,
  );
  const safeActions = JSON.stringify(safeCommit.inputSchema.properties.actions);
  const destructiveActions = JSON.stringify(
    destructiveCommit.inputSchema.properties.actions,
  );
  assert.doesNotMatch(safeActions, /\"delete\"/);
  assert.match(destructiveActions, /\"delete\"/);
  assert.equal(
    byName.get("merge_merge_request").annotations.destructiveHint,
    true,
  );
});

test("reports installed runtime provenance without consulting GitLab", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async () => {
      throw new Error("get_runtime_info must not call GitLab");
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const response = await client.callTool({
    name: "get_runtime_info",
    arguments: {},
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent.result, {
    server: { name: "gitlab", version: SERVER_VERSION },
    plugin: { name: "gitlab", version: SERVER_VERSION },
    build: { id: "not_configured" },
    deployment: { mode: "embedded", readOnly: false },
    toolInventory: {
      count: names.length,
      fingerprint: `sha256:${createHash("sha256").update(names.join("\n")).digest("hex")}`,
    },
  });
});

test("reports intentional read-only filtering and a validated build ID", async (t) => {
  const { client, server } = await connectedPair(
    () => ({ request: async () => ({ data: {} }) }),
    { readOnly: true, deploymentMode: "http", buildId: "ABCDEF1234" },
  );
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const response = await client.callTool({
    name: "get_runtime_info",
    arguments: {},
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent.result.deployment, {
    mode: "http",
    readOnly: true,
  });
  assert.equal(response.structuredContent.result.build.id, "abcdef1234");
  assert.equal(
    response.structuredContent.result.toolInventory.count,
    listed.tools.length,
  );
  assert.ok(listed.tools.length < 140);
});

test("omits both commit mutation tools in read-only mode", async (t) => {
  const { client, server } = await connectedPair(
    () => ({ request: async () => ({ data: {} }) }),
    { readOnly: true },
  );
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  assert.equal(names.has("get_runtime_info"), true);
  assert.equal(names.has("create_commit"), false);
  assert.equal(names.has("create_destructive_commit"), false);
  assert.equal(names.has("list_project_ci_variables"), true);
  assert.equal(names.has("list_group_ci_variables"), true);
  assert.equal(names.has("create_project_ci_variable"), false);
  assert.equal(names.has("delete_group_ci_variable"), false);
});

test("maps every captured GitHub connector tool to an implemented GitLab workflow", async (t) => {
  const parity = JSON.parse(
    await readFile(
      new URL("../../docs/github-tool-parity.json", import.meta.url),
      "utf8",
    ),
  );
  const { client, server } = await connectedPair(() => ({
    request: async () => ({ data: {} }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const gitlabTools = new Set(listed.tools.map((tool) => tool.name));
  const githubTools = new Set(
    parity.mappings.map((mapping) => mapping.githubTool),
  );

  assert.equal(parity.githubToolCount, 89);
  assert.equal(parity.mappings.length, 89);
  assert.equal(githubTools.size, 89, "GitHub parity mappings must be unique");
  for (const mapping of parity.mappings) {
    assert.ok(
      ["equivalent", "platform_native", "local_fallback"].includes(
        mapping.status,
      ),
      `invalid parity status for ${mapping.githubTool}`,
    );
    assert.ok(
      mapping.gitlabTools.length > 0,
      `missing GitLab mapping for ${mapping.githubTool}`,
    );
    for (const tool of mapping.gitlabTools) {
      assert.ok(
        gitlabTools.has(tool),
        `${mapping.githubTool} maps to missing GitLab tool ${tool}`,
      );
    }
    if (mapping.status !== "equivalent") {
      assert.ok(
        mapping.rationale,
        `${mapping.githubTool} needs a platform-difference rationale`,
      );
    }
  }
});

test("advertises HTTP OAuth per tool and returns a tool-level linking challenge", async (t) => {
  const challenge =
    'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="api", error="invalid_token", error_description="A valid GitLab access token is required."';
  const { client, server } = await connectedPair(
    () => {
      throw new GitLabAuthenticationError();
    },
    {
      securitySchemes: [{ type: "oauth2", scopes: ["api"] }],
      authChallenge: challenge,
    },
  );
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const currentUser = listed.tools.find(
    (tool) => tool.name === "get_current_user",
  );
  const schemes = [{ type: "oauth2", scopes: ["api"] }];
  assert.deepEqual(currentUser._meta.securitySchemes, schemes);
  assert.deepEqual(
    decorateToolSecurity({ name: "get_current_user" }, schemes),
    {
      name: "get_current_user",
      securitySchemes: schemes,
      _meta: { securitySchemes: schemes },
    },
  );

  const result = await client.callTool({
    name: "get_current_user",
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result._meta, {
    "mcp/www_authenticate": [challenge],
  });
});

test("returns compact and detailed capability discovery contract shapes", async (t) => {
  const { client, server } = await connectedPair(() => ({
    baseUrl: "https://gitlab.example.com",
    token: "contract-token",
    request: async (path) => ({
      data:
        path === "/user"
          ? { id: 42, username: "contract-user" }
          : path === "/version"
            ? { version: "18.2.0", revision: "abc123" }
            : path === "/metadata"
              ? { version: "18.2.0", revision: "abc123", enterprise: true }
              : { scopes: ["read_api"], active: true },
    }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const compact = await client.callTool({
    name: "get_gitlab_capabilities",
    arguments: { refresh: true },
  });
  assert.equal(compact.isError, undefined);
  assert.equal(compact.structuredContent.result.schemaVersion, 1);
  assert.equal(compact.structuredContent.result.probes, undefined);
  assert.equal(
    compact.structuredContent.result.capabilities.authenticated_api.state,
    "available",
  );

  const detailed = await client.callTool({
    name: "get_gitlab_capabilities",
    arguments: { detailed: true },
  });
  assert.equal(detailed.structuredContent.result.cache.status, "hit");
  assert.equal(
    detailed.structuredContent.result.probes.user.status,
    "available",
  );
  assert.ok(detailed.structuredContent.result.notes.length > 0);
});

test("uses a stable ASCII marker when presentation text is truncated", async (t) => {
  const oversized = { payload: "x".repeat(130_000) };
  const { client, server } = await connectedPair(() => ({
    request: async () => ({ data: oversized }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "search_projects",
    arguments: {},
  });

  assert.deepEqual(result.structuredContent.result, { data: oversized });
  assert.equal(result.content[0].type, "text");
  assert.ok(
    result.content[0].text.endsWith(
      "\n... response truncated by MCP presentation limit",
    ),
  );
  assert.doesNotMatch(result.content[0].text, /â€¦|…/);
});

test("routes branch creation through the expected GitLab API call", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { name: "codex/test" } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "create_branch",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      ref: "main",
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    result: { name: "codex/test" },
  });
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/repository/branches",
      options: {
        method: "POST",
        query: { branch: "codex/test", ref: "main" },
      },
    },
  ]);
});

test("uses the supported draft-title transition instead of an ignored draft_event", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (!options.method) return { data: { title: "Draft: Existing title" } };
      if (options.body?.draft_event) throw new Error("unsupported draft_event");
      return { data: { title: options.body.title } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const ready = await client.callTool({
    name: "update_merge_request",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      draft_event: "mark_as_ready",
    },
  });
  const draft = await client.callTool({
    name: "update_merge_request",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      title: "Existing title",
      draft_event: "mark_as_draft",
    },
  });

  assert.equal(ready.isError, undefined);
  assert.equal(draft.isError, undefined);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/merge_requests/1",
      options: {},
    },
    {
      path: "/projects/group%2Fproject/merge_requests/1",
      options: { method: "PUT", body: { title: "Existing title" } },
    },
    {
      path: "/projects/group%2Fproject/merge_requests/1",
      options: { method: "PUT", body: { title: "Draft: Existing title" } },
    },
  ]);
});

test("preflights ordinary destructive commits and reserves start_sha for force", async (t) => {
  const calls = [];
  const startSha = "a".repeat(40);
  let branchSha = startSha;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (String(path).endsWith("/repository/branches/codex%2Ftest")) {
        return { data: { commit: { id: branchSha } } };
      }
      return { data: { id: "new-commit" } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const ordinary = await client.callTool({
    name: "create_destructive_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: remove fixture",
      start_sha: startSha,
      actions: [
        {
          action: "delete",
          file_path: "fixture.txt",
          last_commit_id: "last-commit",
        },
      ],
    },
  });
  assert.equal(ordinary.isError, undefined);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/repository/branches/codex%2Ftest",
      options: undefined,
    },
    {
      path: "/projects/group%2Fproject/repository/commits",
      options: {
        method: "POST",
        body: {
          branch: "codex/test",
          commit_message: "test: remove fixture",
          actions: [
            {
              action: "delete",
              file_path: "fixture.txt",
              last_commit_id: "last-commit",
            },
          ],
        },
      },
    },
  ]);

  calls.length = 0;
  const forced = await client.callTool({
    name: "create_destructive_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: force fixture removal",
      start_sha: startSha,
      force: true,
      actions: [
        {
          action: "delete",
          file_path: "fixture.txt",
          last_commit_id: "last-commit",
        },
      ],
    },
  });
  assert.equal(forced.isError, undefined);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/repository/commits",
      options: {
        method: "POST",
        body: {
          branch: "codex/test",
          commit_message: "test: force fixture removal",
          actions: [
            {
              action: "delete",
              file_path: "fixture.txt",
              last_commit_id: "last-commit",
            },
          ],
          start_sha: startSha,
          force: true,
        },
      },
    },
  ]);

  calls.length = 0;
  branchSha = "b".repeat(40);
  const stale = await client.callTool({
    name: "create_destructive_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: reject stale fixture removal",
      start_sha: startSha,
      actions: [
        {
          action: "delete",
          file_path: "fixture.txt",
          last_commit_id: "last-commit",
        },
      ],
    },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /no longer matches start_sha/);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/repository/branches/codex%2Ftest",
      options: undefined,
    },
  ]);
});

test("create_commit rejects start_sha combined with start_branch", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async () => ({ data: { id: "new-commit" } }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: invalid combo",
      start_branch: "main",
      start_sha: "a".repeat(40),
      actions: [
        {
          action: "create",
          file_path: "test.txt",
          content: "hello",
        },
      ],
    },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /does not accept both start_branch and start_sha/,
  );
});

test("create_commit rejects invalid start_sha values", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async () => ({ data: { id: "new-commit" } }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // Short SHA should be rejected
  const shortResult = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: short sha",
      start_sha: "abc123",
      actions: [{ action: "create", file_path: "test.txt", content: "hello" }],
    },
  });
  assert.equal(shortResult.isError, true);

  // Non-hex characters should be rejected
  const nonHexResult = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: non-hex sha",
      start_sha: "z".repeat(40),
      actions: [{ action: "create", file_path: "test.txt", content: "hello" }],
    },
  });
  assert.equal(nonHexResult.isError, true);

  // Valid full SHA should be accepted
  const validResult = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: valid sha",
      start_sha: "a".repeat(40),
      actions: [{ action: "create", file_path: "test.txt", content: "hello" }],
    },
  });
  assert.equal(validResult.isError, undefined);
});

test("create_commit requires last_commit_id for update and move actions", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async () => ({ data: { id: "new-commit" } }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const updateResult = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: missing concurrency id",
      actions: [
        {
          action: "update",
          file_path: "test.txt",
          content: "updated",
        },
      ],
    },
  });
  assert.equal(updateResult.isError, true);
  assert.match(updateResult.content[0].text, /requires last_commit_id/);

  const moveResult = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: missing concurrency id",
      actions: [
        {
          action: "move",
          file_path: "new.txt",
          previous_path: "old.txt",
        },
      ],
    },
  });
  assert.equal(moveResult.isError, true);
  assert.match(moveResult.content[0].text, /requires last_commit_id/);
});

test("create_commit allows chmod actions without last_commit_id", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { id: "new-commit" } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const chmodResult = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: chmod without concurrency id",
      actions: [
        {
          action: "chmod",
          file_path: "script.sh",
          execute_filemode: true,
        },
      ],
    },
  });
  assert.equal(chmodResult.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/projects/group%2Fproject/repository/commits");
});

test("create_commit allows create actions without last_commit_id", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { id: "new-commit" } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "create_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: new file",
      actions: [
        {
          action: "create",
          file_path: "new.txt",
          content: "hello",
        },
      ],
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/projects/group%2Fproject/repository/commits");
});

// ── Suggestion test helpers ─────────────────────────────────────────

const HEAD_SHA = "abc123def456";
const HEAD_SHA_OTHER = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/** Standard MR metadata with a head SHA. */
function mrMetadata() {
  return {
    data: {
      diff_refs: { head_sha: HEAD_SHA, base_sha: "base", start_sha: "start" },
    },
  };
}

/** Discussions containing two valid suggestions. */
function discussionsWithSuggestions() {
  return {
    data: [
      {
        id: "disc-1",
        individual_note: false,
        notes: [
          {
            id: 100,
            type: "DiffNote",
            body: "suggestion note",
            system: false,
            noteable_id: 1,
            noteable_type: "MergeRequest",
            project_id: 12,
            suggestions: [
              {
                id: 5,
                from_line: 10,
                to_line: 10,
                appliable: true,
                applied: false,
                from_content: "old",
                to_content: "new",
              },
              {
                id: 6,
                from_line: 20,
                to_line: 20,
                appliable: true,
                applied: false,
                from_content: "old2",
                to_content: "new2",
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A mock client factory that returns MR metadata, discussions, and then delegates to a final handler. */
function suggestionClientFactory(finalHandler) {
  const calls = [];
  return {
    calls,
    factory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        // Route: MR metadata
        if (path === "/projects/group%2Fproject/merge_requests/1") {
          return mrMetadata();
        }
        // Route: discussions
        if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
          return discussionsWithSuggestions();
        }
        // Everything else goes to the final handler
        return finalHandler(path, options);
      },
    }),
  };
}

// ── apply_merge_request_suggestion tests ───────────────────────────

test("routes apply_merge_request_suggestion through PUT /suggestions/:id/apply with preflight", async (t) => {
  const { calls, factory } = suggestionClientFactory(async (path, options) => {
    return {
      data: {
        id: 5,
        applicable: true,
        applied: true,
        from_line: 10,
        to_line: 10,
        from_content: "old",
        to_content: "new",
      },
    };
  });
  const { client, server } = await connectedPair(factory);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_merge_request_suggestion",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      suggestion_id: 5,
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.applied, true);
  // Should have: 1) MR metadata, 2) discussions, 3) suggestion apply
  assert.equal(calls.length, 3);
  assert.equal(calls[0].path, "/projects/group%2Fproject/merge_requests/1");
  assert.equal(
    calls[1].path,
    "/projects/group%2Fproject/merge_requests/1/discussions",
  );
  assert.equal(calls[2].path, "/suggestions/5/apply");
  assert.deepEqual(calls[2].options, { method: "PUT", body: {} });
});

test("apply_merge_request_suggestion rejects when acknowledge is false", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_merge_request_suggestion",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      suggestion_id: 5,
      expected_head_sha: HEAD_SHA,
      acknowledge: false,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /acknowledge: true/);
  assert.equal(calls.length, 0, "request should not have been forwarded");
});

test("apply_merge_request_suggestion rejects when expected head SHA differs", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_merge_request_suggestion",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      suggestion_id: 5,
      expected_head_sha: HEAD_SHA_OTHER,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_head_sha mismatch/);
  assert.match(result.content[0].text, new RegExp(HEAD_SHA));
  // Only the MR metadata call should have been made — no discussions, no mutation
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/projects/group%2Fproject/merge_requests/1");
});

test("apply_merge_request_suggestion rejects when suggestion not found in MR", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return discussionsWithSuggestions();
      }
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_merge_request_suggestion",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      suggestion_id: 999,
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);
  assert.match(result.content[0].text, /999/);
  // MR metadata + discussions fetched, but no mutation
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/projects/group%2Fproject/merge_requests/1");
  assert.equal(
    calls[1].path,
    "/projects/group%2Fproject/merge_requests/1/discussions",
  );
});

test("apply_merge_request_suggestion rejects when suggestion is already applied", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return {
          data: [
            {
              id: "disc-1",
              individual_note: false,
              notes: [
                {
                  id: 100,
                  type: "DiffNote",
                  body: "suggestion note",
                  system: false,
                  noteable_id: 1,
                  noteable_type: "MergeRequest",
                  project_id: 12,
                  suggestions: [
                    {
                      id: 5,
                      from_line: 10,
                      to_line: 10,
                      appliable: true,
                      applied: true,
                      from_content: "old",
                      to_content: "new",
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_merge_request_suggestion",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      suggestion_id: 5,
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already been applied/);
  // No mutation call
  assert.equal(calls.length, 2);
});

test("apply_merge_request_suggestion rejects when suggestion is not applicable (stale)", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return {
          data: [
            {
              id: "disc-1",
              individual_note: false,
              notes: [
                {
                  id: 100,
                  type: "DiffNote",
                  body: "suggestion note",
                  system: false,
                  noteable_id: 1,
                  noteable_type: "MergeRequest",
                  project_id: 12,
                  suggestions: [
                    {
                      id: 5,
                      from_line: 10,
                      to_line: 10,
                      appliable: false,
                      applied: false,
                      from_content: "old",
                      to_content: "new",
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_merge_request_suggestion",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      suggestion_id: 5,
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not applicable/);
  // No mutation call
  assert.equal(calls.length, 2);
});

test("apply_merge_request_suggestion normalizes GitLab apply failure (race)", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return discussionsWithSuggestions();
      }
      // Simulate GitLab returning an error for the apply endpoint
      throw new Error("400 Bad Request: Suggestion is not applicable");
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_merge_request_suggestion",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      suggestion_id: 5,
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  // The error from GitLab should be propagated as an MCP error
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not applicable/);
  // 3 calls: MR metadata, discussions, failed apply
  assert.equal(calls.length, 3);
});

// ── batch_apply_merge_request_suggestions tests ────────────────────

test("routes batch_apply_merge_request_suggestions through PUT /suggestions/batch_apply with preflight", async (t) => {
  const { calls, factory } = suggestionClientFactory(async (path, options) => {
    return {
      data: [
        { id: 5, applicable: true, applied: true },
        { id: 6, applicable: true, applied: true },
      ],
    };
  });
  const { client, server } = await connectedPair(factory);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "batch_apply_merge_request_suggestions",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      ids: [5, 6],
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
      commit_message: "Apply review suggestions",
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.length, 2);
  // Should have: 1) MR metadata, 2) discussions, 3) batch apply
  assert.equal(calls.length, 3);
  assert.equal(calls[0].path, "/projects/group%2Fproject/merge_requests/1");
  assert.equal(
    calls[1].path,
    "/projects/group%2Fproject/merge_requests/1/discussions",
  );
  assert.equal(calls[2].path, "/suggestions/batch_apply");
  assert.deepEqual(calls[2].options, {
    method: "PUT",
    body: { ids: [5, 6], commit_message: "Apply review suggestions" },
  });
});

test("batch_apply_merge_request_suggestions rejects when acknowledge is false", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "batch_apply_merge_request_suggestions",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      ids: [5, 6],
      expected_head_sha: HEAD_SHA,
      acknowledge: false,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /acknowledge: true/);
  assert.equal(calls.length, 0, "request should not have been forwarded");
});

test("batch_apply_merge_request_suggestions rejects when expected head SHA differs", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "batch_apply_merge_request_suggestions",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      ids: [5, 6],
      expected_head_sha: HEAD_SHA_OTHER,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_head_sha mismatch/);
  // Only MR metadata fetched — no discussions, no mutation
  assert.equal(calls.length, 1);
});

test("batch_apply_merge_request_suggestions rejects when any suggestion is stale/not applicable", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return {
          data: [
            {
              id: "disc-1",
              individual_note: false,
              notes: [
                {
                  id: 100,
                  type: "DiffNote",
                  body: "suggestion note",
                  system: false,
                  noteable_id: 1,
                  noteable_type: "MergeRequest",
                  project_id: 12,
                  suggestions: [
                    {
                      id: 5,
                      from_line: 10,
                      to_line: 10,
                      appliable: true,
                      applied: false,
                      from_content: "old",
                      to_content: "new",
                    },
                    {
                      id: 6,
                      from_line: 20,
                      to_line: 20,
                      appliable: false,
                      applied: false,
                      from_content: "old2",
                      to_content: "new2",
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "batch_apply_merge_request_suggestions",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      ids: [5, 6],
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Batch rejected/);
  assert.match(result.content[0].text, /not applicable/);
  // No batch_apply mutation call — only MR metadata + discussions
  assert.equal(calls.length, 2);
});

test("batch_apply_merge_request_suggestions rejects when any suggestion is already applied", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return {
          data: [
            {
              id: "disc-1",
              individual_note: false,
              notes: [
                {
                  id: 100,
                  type: "DiffNote",
                  body: "suggestion note",
                  system: false,
                  noteable_id: 1,
                  noteable_type: "MergeRequest",
                  project_id: 12,
                  suggestions: [
                    {
                      id: 5,
                      from_line: 10,
                      to_line: 10,
                      appliable: true,
                      applied: false,
                      from_content: "old",
                      to_content: "new",
                    },
                    {
                      id: 6,
                      from_line: 20,
                      to_line: 20,
                      appliable: true,
                      applied: true,
                      from_content: "old2",
                      to_content: "new2",
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "batch_apply_merge_request_suggestions",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      ids: [5, 6],
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Batch rejected/);
  assert.match(result.content[0].text, /already been applied/);
  assert.equal(calls.length, 2);
});

test("batch_apply_merge_request_suggestions rejects when any suggestion does not belong to the MR", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return discussionsWithSuggestions(); // only has ids 5 and 6
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "batch_apply_merge_request_suggestions",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      ids: [5, 999],
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Batch rejected/);
  assert.match(result.content[0].text, /not found/);
  assert.match(result.content[0].text, /999/);
  assert.equal(calls.length, 2);
});

test("batch_apply_merge_request_suggestions normalizes GitLab batch-apply failure (race)", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return discussionsWithSuggestions();
      }
      // Simulate GitLab returning a race-condition error on batch_apply
      throw new Error(
        "409 Conflict: Suggestions have changed since you last read them",
      );
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "batch_apply_merge_request_suggestions",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      ids: [5, 6],
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /409 Conflict/);
  // 3 calls: MR metadata, discussions, failed batch_apply
  assert.equal(calls.length, 3);
});

test("omits suggestion tools in read-only mode", async (t) => {
  const { client, server } = await connectedPair(
    () => ({ request: async () => ({ data: {} }) }),
    { readOnly: true },
  );
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  assert.equal(names.has("apply_merge_request_suggestion"), false);
  assert.equal(names.has("batch_apply_merge_request_suggestions"), false);
});

test("routes rebase_merge_request through the expected GitLab API call", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { rebaseable: true } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "rebase_merge_request",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      skip_ci: true,
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/merge_requests/1/rebase",
      options: {
        method: "PUT",
        body: { skip_ci: true },
      },
    },
  ]);
});

test("routes scoped GitLab search and artifact archive requests", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "merge_requests",
      search: "oauth",
      state: "opened",
      fields: ["title"],
    },
  });
  await client.callTool({
    name: "get_job_artifact_archive",
    arguments: {
      project: "group/project",
      job_id: 42,
      max_bytes: 2500000,
    },
  });

  assert.deepEqual(calls, [
    {
      path: "/groups/parent%2Fteam/search",
      options: {
        query: {
          search: "oauth",
          scope: "merge_requests",
          state: "opened",
          "fields[]": ["title"],
        },
      },
    },
    {
      path: "/projects/group%2Fproject/jobs/42/artifacts",
      options: {
        responseType: "binary",
        maxBytes: 2500000,
      },
    },
  ]);
});

test("redacts operator credentials, schedule values, and merged CI YAML", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async (path) => {
      if (String(path).endsWith("/runners")) {
        return {
          data: [
            {
              id: 1,
              description: "runner",
              token: "runner-secret",
              authentication_token: "runner-auth-secret",
            },
          ],
        };
      }
      if (String(path).endsWith("/ci/lint")) {
        return {
          data: {
            valid: true,
            errors: [],
            merged_yaml: "variables:\n  PASSWORD: leaked",
          },
        };
      }
      if (String(path).includes("/pipeline_schedules/1/variables")) {
        return {
          data: {
            key: "DEPLOY_TOKEN",
            value: "flat-response-secret",
            variable_type: "env_var",
          },
        };
      }
      return {
        data: {
          id: 1,
          description: "Sensitive schedule configuration",
          inputs: [
            {
              name: "deployment_target",
              value: "schedule-input-canary",
            },
          ],
          variables: [
            {
              key: "DEPLOY_TOKEN",
              value: "schedule-secret",
              variable_type: "env_var",
            },
          ],
        },
      };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const runners = await client.callTool({
    name: "list_project_runners",
    arguments: { project: "group/project" },
  });
  const lint = await client.callTool({
    name: "lint_ci_configuration",
    arguments: {
      project: "group/project",
      content: "test:\n  script: echo ok",
    },
  });
  const schedule = await client.callTool({
    name: "get_pipeline_schedule",
    arguments: {
      project: "group/project",
      pipeline_schedule_id: 1,
    },
  });
  const schedules = await client.callTool({
    name: "list_pipeline_schedules",
    arguments: { project: "group/project" },
  });
  const createdSchedule = await client.callTool({
    name: "create_pipeline_schedule",
    arguments: {
      project: "group/project",
      description: "Test schedule",
      ref: "main",
      cron: "0 1 * * *",
      inputs: [{ name: "deployment_target", value: "submitted-input-canary" }],
    },
  });
  const updatedSchedule = await client.callTool({
    name: "update_pipeline_schedule",
    arguments: {
      project: "group/project",
      pipeline_schedule_id: 1,
      active: true,
      inputs: [{ name: "deployment_target", value: "updated-input-canary" }],
    },
  });
  const ownedSchedule = await client.callTool({
    name: "take_ownership_pipeline_schedule",
    arguments: { project: "group/project", pipeline_schedule_id: 1 },
  });
  const createdVariable = await client.callTool({
    name: "create_pipeline_schedule_variable",
    arguments: {
      project: "group/project",
      pipeline_schedule_id: 1,
      key: "DEPLOY_TOKEN",
      value: "submitted-secret",
    },
  });
  const updatedVariable = await client.callTool({
    name: "update_pipeline_schedule_variable",
    arguments: {
      project: "group/project",
      pipeline_schedule_id: 1,
      key: "DEPLOY_TOKEN",
      value: "updated-submitted-secret",
    },
  });
  const deletedVariable = await client.callTool({
    name: "delete_pipeline_schedule_variable",
    arguments: {
      project: "group/project",
      pipeline_schedule_id: 1,
      key: "DEPLOY_TOKEN",
    },
  });

  const combined = JSON.stringify({
    runners,
    lint,
    schedule,
    schedules,
    createdSchedule,
    updatedSchedule,
    ownedSchedule,
    createdVariable,
    updatedVariable,
    deletedVariable,
  });
  assert.doesNotMatch(
    combined,
    /runner-secret|runner-auth-secret|schedule-secret|submitted-secret|updated-submitted-secret|flat-response-secret|schedule-input-canary|submitted-input-canary|updated-input-canary|PASSWORD: leaked/,
  );
  assert.equal(
    schedule.structuredContent.result.variables[0].key,
    "DEPLOY_TOKEN",
  );
  assert.deepEqual(schedule.structuredContent.result.inputs, [
    { name: "deployment_target" },
  ]);
  assert.equal(lint.structuredContent.result.valid, true);
  assert.deepEqual(createdVariable.structuredContent.result, {
    key: "DEPLOY_TOKEN",
    variable_type: "env_var",
  });
  assert.deepEqual(updatedVariable.structuredContent.result, {
    key: "DEPLOY_TOKEN",
    variable_type: "env_var",
  });
  assert.deepEqual(deletedVariable.structuredContent.result, {
    key: "DEPLOY_TOKEN",
  });
});

test("returns CI/CD variable metadata only for project and group lifecycles", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (String(path) === "/projects/group%2Fproject/variables") {
        return {
          data: [
            {
              key: "PROJECT_TOKEN",
              value: "flat-project-secret",
              variable_type: "env_var",
              protected: true,
              masked: true,
              hidden: true,
              raw: false,
              environment_scope: "production",
            },
          ],
        };
      }
      if (String(path) === "/groups/parent%2Fteam/variables") {
        return {
          data: {
            variables: [
              {
                key: "GROUP_TOKEN",
                value: "nested-group-secret",
                variable_type: "file",
                protected: true,
                masked: true,
                hidden: true,
                raw: true,
                environment_scope: "*",
              },
            ],
          },
        };
      }
      return {
        data: {
          key: "DEPLOY_TOKEN",
          value: "mutation-or-read-secret",
          variable_type: "env_var",
          protected: true,
          masked: true,
          hidden: true,
          raw: false,
          environment_scope: "production",
          description: "Deployment credential",
        },
      };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const callsToMake = [
    ["list_project_ci_variables", { project: "group/project" }],
    [
      "get_project_ci_variable",
      {
        project: "group/project",
        key: "DEPLOY_TOKEN",
        filter_environment_scope: "production",
      },
    ],
    [
      "create_project_ci_variable",
      {
        project: "group/project",
        key: "DEPLOY_TOKEN",
        value: "submitted-project-secret",
        masked_and_hidden: true,
      },
    ],
    [
      "update_project_ci_variable",
      {
        project: "group/project",
        key: "DEPLOY_TOKEN",
        value: "updated-project-secret",
        filter_environment_scope: "production",
      },
    ],
    [
      "delete_project_ci_variable",
      {
        project: "group/project",
        key: "DEPLOY_TOKEN",
        filter_environment_scope: "production",
      },
    ],
    ["list_group_ci_variables", { group: "parent/team" }],
    [
      "get_group_ci_variable",
      {
        group: "parent/team",
        key: "DEPLOY_TOKEN",
        filter_environment_scope: "production",
      },
    ],
    [
      "create_group_ci_variable",
      {
        group: "parent/team",
        key: "DEPLOY_TOKEN",
        value: "submitted-group-secret",
        masked_and_hidden: true,
      },
    ],
    [
      "update_group_ci_variable",
      {
        group: "parent/team",
        key: "DEPLOY_TOKEN",
        value: "updated-group-secret",
        filter_environment_scope: "production",
      },
    ],
    [
      "delete_group_ci_variable",
      {
        group: "parent/team",
        key: "DEPLOY_TOKEN",
        filter_environment_scope: "production",
      },
    ],
  ];
  const responses = [];
  for (const [name, arguments_] of callsToMake) {
    const response = await client.callTool({ name, arguments: arguments_ });
    assert.equal(response.isError, undefined, name);
    responses.push(response);
  }

  const combined = JSON.stringify({
    responses,
    calls: calls.map(({ path, options }) => ({
      path,
      method: options?.method,
      query: options?.query,
    })),
  });
  assert.doesNotMatch(
    combined,
    /flat-project-secret|nested-group-secret|mutation-or-read-secret|submitted-project-secret|updated-project-secret|submitted-group-secret|updated-group-secret/,
  );
  assert.deepEqual(responses[0].structuredContent.result.data, [
    {
      key: "PROJECT_TOKEN",
      variable_type: "env_var",
      protected: true,
      masked: true,
      hidden: true,
      raw: false,
      environment_scope: "production",
    },
  ]);
  assert.deepEqual(responses[5].structuredContent.result.data, [
    {
      key: "GROUP_TOKEN",
      variable_type: "file",
      protected: true,
      masked: true,
      hidden: true,
      raw: true,
      environment_scope: "*",
    },
  ]);
  assert.deepEqual(
    calls.find(({ options }) => options?.method === "PUT").options.query,
    {
      "filter[environment_scope]": "production",
    },
  );
  assert.deepEqual(
    calls.find(({ options }) => options?.method === "DELETE").options.query,
    {
      "filter[environment_scope]": "production",
    },
  );
});

test("rejects CI/CD scoped mutations when GitLab resolves a different scope", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (!options.method) {
        return {
          data: {
            key: "DEPLOY_TOKEN",
            value: "must-not-leak",
            environment_scope: "*",
          },
        };
      }
      throw new Error("A scoped mutation must not be sent after a fallback.");
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const name of ["update_group_ci_variable", "delete_group_ci_variable"]) {
    const response = await client.callTool({
      name,
      arguments: {
        group: "parent/team",
        key: "DEPLOY_TOKEN",
        ...(name.startsWith("update") ? { value: "submitted-secret" } : {}),
        filter_environment_scope: "production",
      },
    });
    assert.equal(response.isError, true, name);
    assert.match(
      response.structuredContent.result.message,
      /requested environment scope/i,
    );
    assert.doesNotMatch(
      JSON.stringify(response),
      /must-not-leak|submitted-secret/,
    );
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.method === undefined));
  assert.deepEqual(calls[0].options.query, {
    "filter[environment_scope]": "production",
  });
});

test("guards pipeline variables and governance mutations", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return {
        data: {
          id: 7,
          variables: [
            {
              key: "DEPLOY_TOKEN",
              value: "should-not-return",
              variable_type: "env_var",
            },
          ],
        },
      };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const pipeline = await client.callTool({
    name: "create_pipeline",
    arguments: {
      project: "group/project",
      ref: "main",
      variables: [{ key: "DEPLOY_TOKEN", value: "submitted-secret" }],
    },
  });
  assert.equal(pipeline.isError, undefined);
  assert.doesNotMatch(
    JSON.stringify(pipeline),
    /submitted-secret|should-not-return/,
  );

  const beforeGovernance = calls.length;
  const unacknowledged = await client.callTool({
    name: "unprotect_branch",
    arguments: { project: "group/project", name: "main" },
  });
  assert.equal(unacknowledged.isError, true);
  assert.equal(calls.length, beforeGovernance);
});

test("keeps every protected-branch access rule a separate rule", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    baseUrl: "https://gitlab.example.com",
    token: "token",
    request: async (path, options) => {
      calls.push({ path: String(path), options });
      const requested = String(path);
      if (requested.endsWith("/user")) {
        return { data: { id: 1, username: "contract", is_admin: false } };
      }
      if (requested.includes("/version")) {
        return { data: { version: "17.0.0" } };
      }
      if (requested.includes("/metadata")) {
        return { data: { enterprise: true, version: "17.0.0" } };
      }
      if (requested.includes("personal_access_tokens/self")) {
        return { data: { scopes: ["api"] } };
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // Rules that share no field are the case that regressed: transposing them
  // into `allowed_to_push[][access_level]` / `allowed_to_push[][user_id]` let
  // Rack collapse both into a single merged rule.
  const heterogeneous = {
    project: "group/project",
    name: "main",
    allowed_to_push: [{ access_level: 30 }, { user_id: 77 }],
    allowed_to_merge: [{ access_level: 40 }, { group_id: 12 }],
    allowed_to_unprotect: [{ access_level: 40 }],
    acknowledge_protection_change: true,
  };

  const created = await client.callTool({
    name: "protect_branch",
    arguments: heterogeneous,
  });
  assert.equal(created.isError, undefined);

  const post = calls.find((call) => call.options?.method === "POST");
  assert.deepEqual(post.options.body.allowed_to_push, [
    { access_level: 30 },
    { user_id: 77 },
  ]);
  assert.deepEqual(post.options.body.allowed_to_merge, [
    { access_level: 40 },
    { group_id: 12 },
  ]);
  assert.equal(post.options.body.name, "main");
  // Bracket-notation query keys must not reappear in any form.
  assert.equal(post.options.query, undefined);
  assert.doesNotMatch(JSON.stringify(post.options), /\[\]\[/);

  const updated = await client.callTool({
    name: "update_protected_branch",
    arguments: heterogeneous,
  });
  assert.equal(updated.isError, undefined);

  const put = calls.find((call) => call.options?.method === "PUT");
  assert.deepEqual(put.options.body.allowed_to_push, [
    { access_level: 30 },
    { user_id: 77 },
  ]);
  // The branch name travels in the path on update, never in the payload.
  assert.equal(put.options.body.name, undefined);
  assert.doesNotMatch(JSON.stringify(put.options), /\[\]\[/);
});

test("covers URL files, blob SHAs, account-wide issues, and exact MR patches", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({
        path: path instanceof URL ? path.toString() : path,
        options,
      });
      if (path instanceof URL) {
        return { data: "one\ntwo\nthree\n" };
      }
      if (String(path).endsWith("/raw")) {
        return {
          data: {
            encoding: "base64",
            contentType: "application/octet-stream",
            contentLength: 5,
            content: Buffer.from("hello").toString("base64"),
          },
        };
      }
      if (String(path).endsWith("/merge_requests/7/diffs")) {
        return options.query.page === 1
          ? {
              data: [{ old_path: "other.txt", new_path: "other.txt" }],
              pagination: { nextPage: 2 },
            }
          : {
              data: [
                {
                  old_path: "src/app.js",
                  new_path: "src/app.js",
                  diff: "@@ -1 +1 @@",
                },
              ],
            };
      }
      return { data: [] };
    },
    baseUrl: "https://gitlab.example.com",
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const fileUrl = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
      start_line: 2,
      end_line: 2,
    },
  });
  assert.equal(fileUrl.structuredContent.result.content, "two");
  assert.deepEqual(fileUrl.structuredContent.result.lineRange, {
    start: 2,
    end: 2,
    total: 4,
  });

  const blob = await client.callTool({
    name: "get_blob",
    arguments: {
      project: "group/project",
      blob_sha: "abcdef123456",
    },
  });
  assert.equal(blob.structuredContent.result.content, "hello");
  assert.equal(blob.structuredContent.result.encoding, "utf-8");

  await client.callTool({
    name: "list_global_issues",
    arguments: { per_page: 25 },
  });
  const patch = await client.callTool({
    name: "get_merge_request_file_patch",
    arguments: {
      project: "group/project",
      merge_request_iid: 7,
      path: "src/app.js",
    },
  });
  assert.equal(patch.structuredContent.result.new_path, "src/app.js");

  assert.equal(
    calls[0].path,
    "https://gitlab.example.com/group/project/-/raw/main/README.md",
  );
  assert.equal(
    calls[1].path,
    "/projects/group%2Fproject/repository/blobs/abcdef123456/raw",
  );
  assert.deepEqual(calls[2], {
    path: "/issues",
    options: {
      query: {
        scope: "all",
        per_page: 25,
      },
    },
  });
  assert.equal(calls[3].options.query.page, 1);
  assert.equal(calls[4].options.query.page, 2);
});

test("returns model-readable GitLab errors without throwing protocol errors", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async () => {
      throw new Error("simulated failure");
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "get_project",
    arguments: { project: "group/project" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /simulated failure/);
  assert.deepEqual(result.structuredContent, {
    result: {
      error: "Error",
      message: "simulated failure",
    },
  });
});

test("suppresses upstream error bodies in both MCP representations", async (t) => {
  const leaked = "upstream-secret-value";
  const { client, server } = await connectedPair(() => ({
    request: async () => {
      throw new GitLabApiError("GitLab API returned 400 Bad Request.", {
        status: 400,
        method: "POST",
        path: "/projects/7/variables",
        response: {
          token: leaked,
          nested: {
            password: leaked,
            variables: [{ key: "DEPLOY_TOKEN", value: leaked }],
          },
        },
      });
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "get_project",
    arguments: { project: "group/project" },
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.isError, true);
  assert.doesNotMatch(serialized, new RegExp(leaked));
  assert.deepEqual(result.structuredContent, {
    result: {
      error: "GitLabApiError",
      message: "GitLab API returned 400 Bad Request.",
      status: 400,
      method: "POST",
      path: "/projects/7/variables",
    },
  });
});

test("redacts plural, camelCase, key, credential, and authorization secret fields", async (t) => {
  const leaked = "regression-secret-value";
  const { client, server } = await connectedPair(() => ({
    request: async (path) => {
      // Return runner data with new credential field patterns
      if (String(path).includes("/runners")) {
        return {
          data: [
            {
              id: 1,
              description: "CI runner",
              token: "runner-token",
              authentication_token: leaked,
              private_key: leaked,
              credentials: leaked,
              authorization: leaked,
              authorization_header: `Bearer ${leaked}`,
            },
          ],
        };
      }
      // Return user data with camelCase and auth fields
      if (
        String(path).includes("/users") ||
        String(path).includes("/members")
      ) {
        return {
          data: [
            {
              id: 1,
              name: "bot",
              clientSecret: leaked,
              api_key: leaked,
              sshCredentials: leaked,
            },
          ],
        };
      }
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const runners = await client.callTool({
    name: "list_project_runners",
    arguments: { project: "group/project" },
  });
  const members = await client.callTool({
    name: "list_project_members",
    arguments: { project: "group/project" },
  });

  const combined = JSON.stringify({ runners, members });
  assert.doesNotMatch(
    combined,
    new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  // Legitimate metadata fields must be preserved
  const runnerData =
    runners.structuredContent?.result?.data ??
    runners.structuredContent?.result;
  assert.ok(Array.isArray(runnerData));
  assert.equal(runnerData[0].description, "CI runner");
  const membersData =
    members.structuredContent?.result?.data ??
    members.structuredContent?.result;
  assert.ok(Array.isArray(membersData));
  assert.equal(membersData[0].name, "bot");
});

test("accepts structured array values in pipeline inputs", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { id: 1 } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // Nested maps and sequences should be accepted
  const pipeline = await client.callTool({
    name: "create_pipeline",
    arguments: {
      project: "group/project",
      ref: "main",
      inputs: {
        environment: "production",
        replicas: 3,
        enabled: true,
        regions: ["us-east-1", "eu-west-1"],
        matrix: [
          { os: "linux", arch: "amd64" },
          { os: "linux", arch: "arm64" },
        ],
        nested: { level1: { level2: ["deep-value"] } },
      },
    },
  });
  assert.equal(pipeline.isError, undefined);

  // Verify the structured inputs were forwarded to GitLab
  const body = calls[0].options?.body;
  assert.ok(body, "expected a request body");
  assert.deepEqual(body.inputs, {
    environment: "production",
    replicas: 3,
    enabled: true,
    regions: ["us-east-1", "eu-west-1"],
    matrix: [
      { os: "linux", arch: "amd64" },
      { os: "linux", arch: "arm64" },
    ],
    nested: { level1: { level2: ["deep-value"] } },
  });
});

test("accepts structured values in schedule inputs", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return {
        data: {
          id: 1,
          inputs: [
            { name: "regions", value: ["us-east-1", "eu-west-1"] },
            { name: "config", value: { cpu: 4, memory: "8Gi" } },
          ],
        },
      };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const schedule = await client.callTool({
    name: "create_pipeline_schedule",
    arguments: {
      project: "group/project",
      description: "Test schedule",
      ref: "main",
      cron: "0 2 * * *",
      inputs: [
        { name: "regions", value: ["us-east-1", "eu-west-1"] },
        { name: "config", value: { cpu: 4, memory: "8Gi" } },
        { name: "enabled", value: true },
      ],
    },
  });
  assert.equal(schedule.isError, undefined);

  // Verify the structured inputs were forwarded to GitLab
  const body = calls[0].options?.body;
  assert.ok(body, "expected a request body");
  assert.deepEqual(body.inputs, [
    { name: "regions", value: ["us-east-1", "eu-west-1"] },
    { name: "config", value: { cpu: 4, memory: "8Gi" } },
    { name: "enabled", value: true },
  ]);
});

test("rejects pipeline inputs exceeding nesting depth limit", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { id: 1 } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 6 levels deep exceeds the max depth of 5
  const deep = { a: { b: { c: { d: { e: { f: "too-deep" } } } } } };
  const result = await client.callTool({
    name: "create_pipeline",
    arguments: {
      project: "group/project",
      ref: "main",
      inputs: { nested: deep },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, "request should not have been forwarded");
});

test("rejects pipeline input arrays exceeding length limit", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { id: 1 } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 51 elements exceeds the max array length of 50
  const oversized = Array.from({ length: 51 }, (_, i) => `item-${i}`);
  const result = await client.callTool({
    name: "create_pipeline",
    arguments: {
      project: "group/project",
      ref: "main",
      inputs: { items: oversized },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, "request should not have been forwarded");
});

test("rejects pipeline input objects exceeding key count limit", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { id: 1 } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 21 keys exceeds the max object keys of 20
  const tooManyKeys = {};
  for (let i = 0; i < 21; i++) {
    tooManyKeys[`key${i}`] = `value-${i}`;
  }
  const result = await client.callTool({
    name: "create_pipeline",
    arguments: {
      project: "group/project",
      ref: "main",
      inputs: { config: tooManyKeys },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, "request should not have been forwarded");
});

test("rejects pipeline input strings exceeding length limit", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { id: 1 } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const longString = "x".repeat(10_001);
  const result = await client.callTool({
    name: "create_pipeline",
    arguments: {
      project: "group/project",
      ref: "main",
      inputs: { value: longString },
    },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, "request should not have been forwarded");
});
