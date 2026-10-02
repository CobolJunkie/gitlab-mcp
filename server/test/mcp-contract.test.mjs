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
    175,
    `expected 175 tools, got ${listed.tools.length}`,
  );
  for (const name of [
    "get_runtime_info",
    "get_gitlab_capabilities",
    "list_groups",
    "list_group_projects",
    "search_gitlab",
    "search_projects",
    "get_project_member",
    "list_project_labels",
    "get_project_label",
    "create_project_label",
    "update_project_label",
    "delete_project_label",
    "list_group_labels",
    "get_group_label",
    "create_group_label",
    "update_group_label",
    "delete_group_label",
    "create_project_milestone",
    "update_project_milestone",
    "delete_project_milestone",
    "create_group_milestone",
    "update_group_milestone",
    "delete_group_milestone",
    "get_blob",
    "get_file",
    "fetch_gitlab_file_url",
    "download_gitlab_attachment",
    "stop_environment",
    "delete_environment",
    "get_project_access_token_capabilities",
    "list_project_access_tokens",
    "get_project_access_token",
    "create_project_access_token",
    "rotate_project_access_token",
    "revoke_project_access_token",
    "replace_project_access_token_ci_credential",
    "create_file",
    "create_branch",
    "revert_commit",
    "cherry_pick_commit",
    "apply_repository_hunks",
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
    "commit_job_artifact_file",
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
  const pipelineStatuses =
    byName.get("list_pipelines").inputSchema.properties.status.enum;
  assert.ok(pipelineStatuses.includes("waiting_for_callback"));
  assert.ok(pipelineStatuses.includes("canceling"));

  assert.equal(
    byName.get("merge_merge_request").annotations.destructiveHint,
    true,
  );
});

test("repository file CRUD discloses target-branch creation semantics", async (t) => {
  const { client, server } = await connectedPair(() => ({
    request: async () => ({ data: {} }),
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

  for (const name of ["create_file", "update_file", "delete_file"]) {
    const fileTool = byName.get(name);
    assert.match(
      fileTool.description,
      /start_branch.*create the target branch/i,
    );
    assert.match(
      fileTool.inputSchema.properties.start_branch.description,
      /base branch.*create the target branch/i,
    );
  }
});

test("list_pipelines forwards current transitional statuses unchanged", async (t) => {
  for (const status of ["waiting_for_callback", "canceling"]) {
    const calls = [];
    const { client, server } = await connectedPair(() => ({
      request: async (path, options = {}) => {
        calls.push({ path, options });
        return { data: [], pagination: {} };
      },
    }));
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "list_pipelines",
      arguments: {
        project: "group/project",
        status,
      },
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/projects/group%2Fproject/pipelines");
    assert.equal(calls[0].options.query.status, status);
  }
});

test("release asset-link contracts support partial updates and GitLab URL schemes", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { data: { id: 1 } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const createTool = byName.get("create_release_asset_link");
  const updateTool = byName.get("update_release_asset_link");
  const createRequired = new Set(createTool.inputSchema.required);
  const updateRequired = new Set(updateTool.inputSchema.required);

  assert.equal(createRequired.has("name"), true);
  assert.equal(createRequired.has("url"), true);
  assert.equal(updateRequired.has("name"), false);
  assert.equal(updateRequired.has("url"), false);
  assert.match(createTool.description, /HTTP, HTTPS, or FTP/u);
  assert.match(updateTool.description, /at least one of name or url/iu);

  const common = {
    project: "group/project",
    tag_name: "v1.0.0",
    link_id: 1,
  };
  const assetPath = "/projects/group%2Fproject/releases/v1.0.0/assets/links/1";

  const rename = await client.callTool({
    name: "update_release_asset_link",
    arguments: { ...common, name: "renamed" },
  });
  assert.equal(rename.isError, undefined);
  assert.deepEqual(calls.at(-1), {
    path: assetPath,
    options: { method: "PUT", body: { name: "renamed" } },
  });

  const retarget = await client.callTool({
    name: "update_release_asset_link",
    arguments: { ...common, url: "ftp://downloads.example.com/release.bin" },
  });
  assert.equal(retarget.isError, undefined);
  assert.deepEqual(calls.at(-1), {
    path: assetPath,
    options: {
      method: "PUT",
      body: { url: "ftp://downloads.example.com/release.bin" },
    },
  });

  const beforeInvalid = calls.length;
  const emptyUpdate = await client.callTool({
    name: "update_release_asset_link",
    arguments: common,
  });
  assert.equal(emptyUpdate.isError, true);
  assert.match(emptyUpdate.content[0].text, /at least one of name or url/iu);
  assert.equal(calls.length, beforeInvalid);

  const dedicatedCreate = await client.callTool({
    name: "create_release_asset_link",
    arguments: {
      project: "group/project",
      tag_name: "v1.0.0",
      name: "binary",
      url: "ftp://downloads.example.com/release.bin",
    },
  });
  assert.equal(dedicatedCreate.isError, undefined);

  const nestedCreate = await client.callTool({
    name: "create_release",
    arguments: {
      project: "group/project",
      tag_name: "v1.0.0",
      assets: {
        links: [
          {
            name: "binary",
            url: "ftp://downloads.example.com/release.bin",
          },
        ],
      },
    },
  });
  assert.equal(nestedCreate.isError, undefined);

  const beforeUnsupported = calls.length;
  for (const [name, argumentsValue] of [
    [
      "create_release_asset_link",
      {
        project: "group/project",
        tag_name: "v1.0.0",
        name: "email",
        url: "mailto:release@example.com",
      },
    ],
    [
      "create_release",
      {
        project: "group/project",
        tag_name: "v1.0.0",
        assets: {
          links: [{ name: "email", url: "mailto:release@example.com" }],
        },
      },
    ],
  ]) {
    const result = await client.callTool({
      name,
      arguments: argumentsValue,
    });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, beforeUnsupported);
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

test("preserves empty label arrays as GitLab clear-all strings", async (t) => {
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

  const issueResult = await client.callTool({
    name: "update_issue",
    arguments: {
      project: "group/project",
      issue_iid: 1,
      labels: [],
    },
  });
  const mergeRequestResult = await client.callTool({
    name: "update_merge_request",
    arguments: {
      project: "group/project",
      merge_request_iid: 2,
      labels: [],
    },
  });

  assert.equal(issueResult.isError, undefined);
  assert.equal(mergeRequestResult.isError, undefined);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/issues/1",
      options: { method: "PUT", body: { labels: "" } },
    },
    {
      path: "/projects/group%2Fproject/merge_requests/2",
      options: { method: "PUT", body: { labels: "" } },
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

test("requires file guards for non-force destructive update and move actions", async (t) => {
  const calls = [];
  const startSha = "a".repeat(40);
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

  const unguardedActions = [
    {
      action: "update",
      file_path: "fixture.txt",
      content: "updated",
    },
    {
      action: "move",
      file_path: "moved.txt",
      previous_path: "fixture.txt",
    },
  ];
  for (const action of unguardedActions) {
    const result = await client.callTool({
      name: "create_destructive_commit",
      arguments: {
        project: "group/project",
        branch: "codex/test",
        commit_message: "test: reject unguarded destructive mutation",
        start_sha: startSha,
        actions: [action],
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires last_commit_id/);
  }
  assert.deepEqual(calls, []);

  const forced = await client.callTool({
    name: "create_destructive_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: force reviewed history replacement",
      start_sha: startSha,
      force: true,
      actions: [
        {
          action: "update",
          file_path: "fixture.txt",
          content: "forced update",
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
          commit_message: "test: force reviewed history replacement",
          actions: [
            {
              action: "update",
              file_path: "fixture.txt",
              content: "forced update",
            },
          ],
          start_sha: startSha,
          force: true,
        },
      },
    },
  ]);
});

test("forwards destructive file guards so GitLab can reject stale state after branch preflight", async (t) => {
  const calls = [];
  const startSha = "a".repeat(40);
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (String(path).endsWith("/repository/branches/codex%2Ftest")) {
        return { data: { commit: { id: startSha } } };
      }
      if (String(path).endsWith("/repository/commits")) {
        throw new GitLabApiError("GitLab rejected stale file state.", {
          status: 400,
          method: "POST",
          path,
          response: {
            message: "last_commit_id does not match current file state",
          },
        });
      }
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "create_destructive_commit",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      commit_message: "test: preserve destructive file guards",
      start_sha: startSha,
      actions: [
        {
          action: "update",
          file_path: "fixture.txt",
          content: "updated",
          last_commit_id: "reviewed-update-commit",
        },
        {
          action: "move",
          file_path: "moved.txt",
          previous_path: "other.txt",
          last_commit_id: "reviewed-move-commit",
        },
      ],
    },
  });

  assert.equal(result.isError, true);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].path,
    "/projects/group%2Fproject/repository/branches/codex%2Ftest",
  );
  assert.deepEqual(calls[1], {
    path: "/projects/group%2Fproject/repository/commits",
    options: {
      method: "POST",
      body: {
        branch: "codex/test",
        commit_message: "test: preserve destructive file guards",
        actions: [
          {
            action: "update",
            file_path: "fixture.txt",
            content: "updated",
            last_commit_id: "reviewed-update-commit",
          },
          {
            action: "move",
            file_path: "moved.txt",
            previous_path: "other.txt",
            last_commit_id: "reviewed-move-commit",
          },
        ],
      },
    },
  });
});

test("delete_branch requires a reviewed head and explicit acknowledgement", async (t) => {
  let apiCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async () => {
      apiCalls += 1;
      return { data: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const argumentsValue of [
    {
      project: "group/project",
      branch: "topic",
      acknowledge_branch_deletion: true,
    },
    {
      project: "group/project",
      branch: "topic",
      expected_head_sha: "not-a-full-sha",
      acknowledge_branch_deletion: true,
    },
    {
      project: "group/project",
      branch: "topic",
      expected_head_sha: "a".repeat(40),
    },
  ]) {
    const result = await client.callTool({
      name: "delete_branch",
      arguments: argumentsValue,
    });
    assert.equal(result.isError, true);
  }

  assert.equal(apiCalls, 0);
});

test("delete_branch reports an initially absent branch as confirmed no-change", async (t) => {
  let apiCalls = 0;
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic`;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      apiCalls += 1;
      assert.notEqual(options.method, "DELETE");
      if (path === branchesPath) {
        assert.deepEqual(options.query, {
          regex: "^topic$",
          page: 1,
          per_page: 1,
        });
        return { data: [], pagination: {} };
      }
      assert.equal(path, branchPath);
      throw new GitLabApiError("GitLab API returned 404.", {
        status: 404,
        method: "GET",
        path,
      });
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "delete_branch",
    arguments: {
      project: "group/project",
      branch: "topic",
      expected_head_sha: "a".repeat(40),
      acknowledge_branch_deletion: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.result, {
    branch: "topic",
    expected_head_sha: "a".repeat(40),
    state: "absent",
    outcome: "already_absent",
    changed: false,
    atomicity: "preflight_guarded_non_atomic",
  });
  assert.equal(apiCalls, 2);
});

test("delete_branch escapes branch names in exact absence corroboration", async (t) => {
  const branch = "topic.$";
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic.%24`;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (path === branchPath) {
        throw new GitLabApiError("GitLab API returned 404.", {
          status: 404,
          method: "GET",
          path,
        });
      }
      assert.equal(path, branchesPath);
      assert.deepEqual(options.query, {
        regex: "^topic\\.\\$$",
        page: 1,
        per_page: 1,
      });
      return { data: [], pagination: {} };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "delete_branch",
    arguments: {
      project: "group/project",
      branch,
      expected_head_sha: "a".repeat(40),
      acknowledge_branch_deletion: true,
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.outcome, "already_absent");
});

test("delete_branch does not mask repository-level 404s as confirmed branch absence", async (t) => {
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic`;
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      if (path === branchPath) {
        throw new GitLabApiError("GitLab API returned 404.", {
          status: 404,
          method: "GET",
          path,
          response: { message: "404 Branch Not Found" },
        });
      }
      assert.equal(path, branchesPath);
      throw new GitLabApiError("GitLab API returned 404.", {
        status: 404,
        method: "GET",
        path,
        response: { message: "404 Project Not Found" },
      });
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "delete_branch",
    arguments: {
      project: "group/project",
      branch: "topic",
      expected_head_sha: "a".repeat(40),
      acknowledge_branch_deletion: true,
    },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(calls, [
    { path: branchPath, method: "GET" },
    { path: branchesPath, method: "GET" },
  ]);
});

test("delete_branch does not treat an empty successful postflight as proof of absence", async (t) => {
  const expectedHead = "a".repeat(40);
  const branchPath = "/projects/group%2Fproject/repository/branches/topic";

  for (const deleteStatus of ["success", "not-found"]) {
    let branchReads = 0;
    const { client, server } = await connectedPair(() => ({
      request: async (path, options = {}) => {
        assert.equal(path, branchPath);
        if (options.method === "DELETE") {
          if (deleteStatus === "not-found") {
            throw new GitLabApiError("GitLab API returned 404.", {
              status: 404,
              method: "DELETE",
              path,
            });
          }
          return { data: null };
        }
        branchReads += 1;
        if (branchReads <= 2) {
          return { data: { commit: { id: expectedHead } } };
        }
        return { data: null };
      },
    }));
    try {
      const result = await client.callTool({
        name: "delete_branch",
        arguments: {
          project: "group/project",
          branch: "topic",
          expected_head_sha: expectedHead,
          acknowledge_branch_deletion: true,
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /empty postflight response/u);
      assert.equal(branchReads, 3);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("delete_branch rechecks the reviewed head and verifies confirmed absence", async (t) => {
  const expectedHead = "A".repeat(40);
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic`;
  const calls = [];
  let deleted = false;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === branchesPath) return { data: [], pagination: {} };
      assert.equal(path, branchPath);
      if (options.method === "DELETE") {
        deleted = true;
        return { data: null };
      }
      if (deleted) {
        throw new GitLabApiError("GitLab API returned 404.", {
          status: 404,
          method: "GET",
          path,
        });
      }
      return {
        data: { name: "topic", commit: { id: expectedHead.toLowerCase() } },
      };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "delete_branch",
    arguments: {
      project: "group/project",
      branch: "topic",
      expected_head_sha: expectedHead,
      acknowledge_branch_deletion: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.result, {
    branch: "topic",
    expected_head_sha: expectedHead,
    state: "absent",
    outcome: "deleted",
    changed: true,
    atomicity: "preflight_guarded_non_atomic",
  });
  assert.deepEqual(
    calls.map(({ path, options }) => ({
      path,
      method: options.method || "GET",
    })),
    [
      { path: branchPath, method: "GET" },
      { path: branchPath, method: "GET" },
      { path: branchPath, method: "DELETE" },
      { path: branchPath, method: "GET" },
      { path: branchesPath, method: "GET" },
    ],
  );
});

test("delete_branch fails closed when the reviewed branch is stale or disappears before deletion", async (t) => {
  const expectedHead = "a".repeat(40);
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic`;
  let mode = "stale";
  let branchReads = 0;
  let deleteCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (path === branchesPath) {
        return {
          data:
            mode === "reappeared"
              ? [{ name: "topic", commit: { id: "b".repeat(40) } }]
              : [],
          pagination: {},
        };
      }
      assert.equal(path, branchPath);
      if (options.method === "DELETE") {
        deleteCalls += 1;
        return { data: null };
      }
      branchReads += 1;
      if (mode === "stale") {
        return { data: { commit: { id: "b".repeat(40) } } };
      }
      if (branchReads === 1) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (mode === "advanced") {
        return { data: { commit: { id: "b".repeat(40) } } };
      }
      throw new GitLabApiError("GitLab API returned 404.", {
        status: 404,
        method: "GET",
        path,
      });
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const args = {
    project: "group/project",
    branch: "topic",
    expected_head_sha: expectedHead,
    acknowledge_branch_deletion: true,
  };
  const stale = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /expected_head_sha/u);
  assert.equal(deleteCalls, 0);

  mode = "advanced";
  branchReads = 0;
  const advanced = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(advanced.isError, true);
  assert.match(advanced.content[0].text, /expected_head_sha/u);
  assert.equal(deleteCalls, 0);

  mode = "disappeared";
  branchReads = 0;
  const disappeared = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(disappeared.isError, undefined);
  assert.equal(
    disappeared.structuredContent.result.outcome,
    "already_absent_after_preflight",
  );
  assert.equal(disappeared.structuredContent.result.changed, false);
  assert.equal(deleteCalls, 0);

  mode = "reappeared";
  branchReads = 0;
  const reappeared = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(reappeared.isError, true);
  assert.match(reappeared.content[0].text, /branch is visible again/u);
  assert.equal(deleteCalls, 0);
});

test("delete_branch preserves GitLab deletion failures and reports ambiguous postconditions", async (t) => {
  const expectedHead = "a".repeat(40);
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic`;
  let mode = "forbidden";
  let deleted = false;
  let deleteCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (path === branchesPath) return { data: [], pagination: {} };
      assert.equal(path, branchPath);
      if (options.method === "DELETE") {
        deleteCalls += 1;
        if (mode === "forbidden" || mode === "protected") {
          const status = mode === "forbidden" ? 403 : 405;
          throw new GitLabApiError(`GitLab API returned ${status}.`, {
            status,
            method: "DELETE",
            path,
          });
        }
        deleted = true;
        if (mode === "delete-missing" || mode === "delete-missing-present") {
          throw new GitLabApiError("GitLab API returned 404.", {
            status: 404,
            method: "DELETE",
            path,
          });
        }
        return { data: null };
      }
      if (!deleted) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (mode === "delete-missing") {
        throw new GitLabApiError("GitLab API returned 404.", {
          status: 404,
          method: "GET",
          path,
        });
      }
      if (mode === "ambiguous") {
        throw new Error("postflight connection reset");
      }
      return { data: { commit: { id: "b".repeat(40) } } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const args = {
    project: "group/project",
    branch: "topic",
    expected_head_sha: expectedHead,
    acknowledge_branch_deletion: true,
  };
  const forbidden = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(forbidden.isError, true);
  assert.equal(deleteCalls, 1);

  mode = "protected";
  deleted = false;
  const protectedBranch = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(protectedBranch.isError, true);
  assert.equal(deleteCalls, 2);

  mode = "delete-missing";
  deleted = false;
  const alreadyAbsent = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(alreadyAbsent.isError, undefined);
  assert.equal(alreadyAbsent.structuredContent.result.changed, false);
  assert.equal(
    alreadyAbsent.structuredContent.result.outcome,
    "already_absent_after_preflight",
  );
  assert.equal(deleteCalls, 3);

  mode = "delete-missing-present";
  deleted = false;
  const conflictingNotFound = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(conflictingNotFound.isError, true);
  assert.match(
    conflictingNotFound.content[0].text,
    /returned 404.*still present|recreated concurrently/u,
  );
  assert.equal(deleteCalls, 4);

  mode = "ambiguous";
  deleted = false;
  const ambiguous = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /postcondition is ambiguous/u);
  assert.equal(deleteCalls, 5);

  mode = "present";
  deleted = false;
  const present = await client.callTool({
    name: "delete_branch",
    arguments: args,
  });
  assert.equal(present.isError, true);
  assert.match(
    present.content[0].text,
    /still present|recreated concurrently/u,
  );
  assert.equal(deleteCalls, 6);
});

test("delete_branch keeps repository-verification failures ambiguous after delete attempts", async (t) => {
  const expectedHead = "a".repeat(40);
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic`;

  for (const deleteOutcome of ["not-found", "accepted"]) {
    let branchReads = 0;
    let deleteCalls = 0;
    const { client, server } = await connectedPair(() => ({
      request: async (path, options = {}) => {
        if (path === branchesPath) {
          throw new GitLabApiError("GitLab API returned 404.", {
            status: 404,
            method: "GET",
            path,
            response: { message: "404 Project Not Found" },
          });
        }
        assert.equal(path, branchPath);
        if (options.method === "DELETE") {
          deleteCalls += 1;
          if (deleteOutcome === "not-found") {
            throw new GitLabApiError("GitLab API returned 404.", {
              status: 404,
              method: "DELETE",
              path,
            });
          }
          return { data: null };
        }
        branchReads += 1;
        if (branchReads <= 2) {
          return { data: { commit: { id: expectedHead } } };
        }
        throw new GitLabApiError("GitLab API returned 404.", {
          status: 404,
          method: "GET",
          path,
        });
      },
    }));
    try {
      const result = await client.callTool({
        name: "delete_branch",
        arguments: {
          project: "group/project",
          branch: "topic",
          expected_head_sha: expectedHead,
          acknowledge_branch_deletion: true,
        },
      });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /repository readability could not be confirmed/u,
      );
      assert.equal(deleteCalls, 1);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("delete_branch treats response-loss and server failures as mutation-ambiguous", async () => {
  const expectedHead = "a".repeat(40);
  const branchesPath = "/projects/group%2Fproject/repository/branches";
  const branchPath = `${branchesPath}/topic`;
  const scenarios = [
    {
      name: "transport-loss-absent",
      deleteError: new Error("delete connection reset"),
      postflight: "absent",
      expectedMessage: /currently confirmed absent/u,
    },
    {
      name: "http-408-absent",
      deleteError: new GitLabApiError("GitLab API returned 408.", {
        status: 408,
        method: "DELETE",
        path: branchPath,
      }),
      postflight: "absent",
      expectedMessage: /currently confirmed absent/u,
    },
    {
      name: "http-503-present",
      deleteError: new GitLabApiError("GitLab API returned 503.", {
        status: 503,
        method: "DELETE",
        path: branchPath,
      }),
      postflight: "present",
      expectedMessage: /currently present|recreated concurrently/u,
    },
    {
      name: "http-500-postflight-failure",
      deleteError: new GitLabApiError("GitLab API returned 500.", {
        status: 500,
        method: "DELETE",
        path: branchPath,
      }),
      postflight: "error",
      expectedMessage: /postflight verification failed/u,
    },
  ];

  for (const scenario of scenarios) {
    let branchReads = 0;
    let deleteCalls = 0;
    let confirmationCalls = 0;
    const { client, server } = await connectedPair(() => ({
      request: async (path, options = {}) => {
        if (path === branchesPath) {
          confirmationCalls += 1;
          assert.deepEqual(options.query, {
            regex: "^topic$",
            page: 1,
            per_page: 1,
          });
          return { data: [], pagination: {} };
        }
        assert.equal(path, branchPath);
        if (options.method === "DELETE") {
          deleteCalls += 1;
          throw scenario.deleteError;
        }
        branchReads += 1;
        if (branchReads <= 2) {
          return { data: { commit: { id: expectedHead } } };
        }
        if (scenario.postflight === "absent") {
          throw new GitLabApiError("GitLab API returned 404.", {
            status: 404,
            method: "GET",
            path,
          });
        }
        if (scenario.postflight === "error") {
          throw new Error("postflight connection reset");
        }
        return { data: { commit: { id: "b".repeat(40) } } };
      },
    }));
    try {
      const result = await client.callTool({
        name: "delete_branch",
        arguments: {
          project: "group/project",
          branch: "topic",
          expected_head_sha: expectedHead,
          acknowledge_branch_deletion: true,
        },
      });
      assert.equal(result.isError, true, scenario.name);
      assert.match(
        result.content[0].text,
        /did not provide a definitive DELETE response/u,
        scenario.name,
      );
      assert.match(
        result.content[0].text,
        scenario.expectedMessage,
        scenario.name,
      );
      assert.equal(deleteCalls, 1, scenario.name);
      assert.equal(branchReads, 3, scenario.name);
      assert.equal(
        confirmationCalls,
        scenario.postflight === "absent" ? 1 : 0,
        scenario.name,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("apply_repository_hunks commits exact guarded replacements atomically", async (t) => {
  const calls = [];
  const expectedHead = "a".repeat(40);
  const firstBlob = "b".repeat(40);
  const secondBlob = "c".repeat(40);
  let mutationCompleted = false;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return {
          data: {
            commit: { id: mutationCompleted ? "new-commit" : expectedHead },
          },
        };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("const value = 1;\n").toString("base64"),
            blob_id: firstBlob,
            last_commit_id: "last-a",
          },
        };
      }
      if (path.endsWith("/repository/files/src%2Fb.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("export const flag = false;\n").toString(
              "base64",
            ),
            blob_id: secondBlob,
            last_commit_id: "last-b",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCompleted = true;
        return { data: { id: "new-commit", short_id: "new" } };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits/new-commit" &&
        !options.method
      ) {
        return { data: { id: "new-commit", parent_ids: [expectedHead] } };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: atomic hunks",
      hunks: [
        {
          file_path: "src/a.js",
          search: "value = 1",
          replace: "value = 2",
          expected_blob_sha: firstBlob,
        },
        {
          file_path: "src/b.js",
          search: "flag = false",
          replace: "flag = true",
          expected_blob_sha: secondBlob,
        },
      ],
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.result.changed_paths, [
    "src/a.js",
    "src/b.js",
  ]);
  assert.equal(result.structuredContent.result.hunk_count, 2);
  assert.equal(calls.length, 7);
  assert.equal(
    calls[3].path,
    "/projects/group%2Fproject/repository/branches/codex%2Ftest",
  );
  assert.deepEqual(calls[4], {
    path: "/projects/group%2Fproject/repository/commits",
    options: {
      method: "POST",
      body: {
        branch: "codex/test",
        commit_message: "test: atomic hunks",
        actions: [
          {
            action: "update",
            file_path: "src/a.js",
            content: "const value = 2;\n",
            encoding: "text",
            last_commit_id: "last-a",
          },
          {
            action: "update",
            file_path: "src/b.js",
            content: "export const flag = true;\n",
            encoding: "text",
            last_commit_id: "last-b",
          },
        ],
      },
    },
  });
  assert.equal(
    calls[5].path,
    "/projects/group%2Fproject/repository/commits/new-commit",
  );
  assert.equal(
    calls[6].path,
    "/projects/group%2Fproject/repository/branches/codex%2Ftest",
  );
});

test("apply_repository_hunks fails closed on stale head, stale blob, ambiguous context, and unsafe paths", async (t) => {
  const expectedHead = "a".repeat(40);
  let mode = "stale-head";
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return {
          data: {
            commit: {
              id: mode === "stale-head" ? "d".repeat(40) : expectedHead,
            },
          },
        };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("same same\n").toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCalls += 1;
        return { data: { id: "unexpected" } };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const baseArguments = {
    project: "group/project",
    branch: "codex/test",
    expected_head_sha: expectedHead,
    commit_message: "test: reject unsafe hunk",
    hunks: [{ file_path: "src/a.js", search: "same", replace: "changed" }],
  };

  const staleHead = await client.callTool({
    name: "apply_repository_hunks",
    arguments: baseArguments,
  });
  assert.equal(staleHead.isError, true);
  assert.match(staleHead.content[0].text, /expected_head_sha/);

  mode = "stale-blob";
  const staleBlob = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      ...baseArguments,
      hunks: [
        {
          ...baseArguments.hunks[0],
          expected_blob_sha: "c".repeat(40),
        },
      ],
    },
  });
  assert.equal(staleBlob.isError, true);
  assert.match(staleBlob.content[0].text, /expected_blob_sha/);

  mode = "ambiguous";
  const ambiguous = await client.callTool({
    name: "apply_repository_hunks",
    arguments: baseArguments,
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /matches more than once/);

  mode = "unsafe";
  const unsafe = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      ...baseArguments,
      hunks: [{ file_path: "../src/a.js", search: "same", replace: "changed" }],
    },
  });
  assert.equal(unsafe.isError, true);
  assert.match(unsafe.content[0].text, /Unsafe repository patch path/);
  assert.equal(mutationCalls, 0);
});

test("apply_repository_hunks rejects overlapping contexts and non-relative paths", async (t) => {
  const expectedHead = "a".repeat(40);
  let content = "aaa\n";
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (options.method === "POST") mutationCalls += 1;
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const baseArguments = {
    project: "group/project",
    branch: "codex/test",
    expected_head_sha: expectedHead,
    commit_message: "test: reject ambiguous hunk",
  };

  const overlapping = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      ...baseArguments,
      hunks: [{ file_path: "src/a.js", search: "aa", replace: "b" }],
    },
  });
  assert.equal(overlapping.isError, true);
  assert.match(overlapping.content[0].text, /matches more than once/);

  content = "safe\n";
  for (const filePath of ["/src/a.js", "src//a.js", "src/a.js/"]) {
    const unsafe = await client.callTool({
      name: "apply_repository_hunks",
      arguments: {
        ...baseArguments,
        hunks: [{ file_path: filePath, search: "safe", replace: "SAFE" }],
      },
    });
    assert.equal(unsafe.isError, true);
    assert.match(unsafe.content[0].text, /Unsafe repository patch path/);
  }
  assert.equal(mutationCalls, 0);
});

test("apply_repository_hunks reports a concurrent-parent mismatch after mutation", async (t) => {
  const expectedHead = "a".repeat(40);
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("before\n").toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCalls += 1;
        return { data: { id: "new-commit" } };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits/new-commit" &&
        !options.method
      ) {
        return {
          data: { id: "new-commit", parent_ids: ["d".repeat(40)] },
        };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: detect parent drift",
      hunks: [{ file_path: "src/a.js", search: "before", replace: "after" }],
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /does not directly descend/);
  assert.match(result.content[0].text, /branch may have changed concurrently/i);
  assert.equal(mutationCalls, 1);
});

test("apply_repository_hunks reports ambiguous postflight reads after mutation", async (t) => {
  const expectedHead = "a".repeat(40);
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("before\n").toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCalls += 1;
        return { data: { id: "new-commit" } };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits/new-commit" &&
        !options.method
      ) {
        throw new Error("postflight unavailable");
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: ambiguous postflight",
      hunks: [{ file_path: "src/a.js", search: "before", replace: "after" }],
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /postcondition is ambiguous/);
  assert.match(result.content[0].text, /branch may have changed/i);
  assert.equal(mutationCalls, 1);
});

test("apply_repository_hunks reports a concurrent branch advance after mutation", async (t) => {
  const expectedHead = "a".repeat(40);
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return {
          data: {
            commit: {
              id: mutationCalls > 0 ? "d".repeat(40) : expectedHead,
            },
          },
        };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("before\n").toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCalls += 1;
        return { data: { id: "new-commit" } };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits/new-commit" &&
        !options.method
      ) {
        return { data: { id: "new-commit", parent_ids: [expectedHead] } };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: detect follow-on branch drift",
      hunks: [{ file_path: "src/a.js", search: "before", replace: "after" }],
    },
  });

  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /no longer points at the resulting commit/,
  );
  assert.match(result.content[0].text, /branch changed concurrently/i);
  assert.equal(mutationCalls, 1);
});

test("apply_repository_hunks accepts valid U+FFFD and rejects malformed UTF-8 bytes", async (t) => {
  const expectedHead = "a".repeat(40);
  let mode = "valid";
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return {
          data: {
            commit: { id: mutationCalls > 0 ? "new-commit" : expectedHead },
          },
        };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        const bytes =
          mode === "valid"
            ? Buffer.from("before \uFFFD after\n", "utf8")
            : Buffer.from([
                0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, 0x20, 0xc3, 0x28,
              ]);
        return {
          data: {
            encoding: "base64",
            content: bytes.toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCalls += 1;
        return { data: { id: "new-commit" } };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits/new-commit" &&
        !options.method
      ) {
        return { data: { id: "new-commit", parent_ids: [expectedHead] } };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const valid = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: valid replacement char",
      hunks: [
        {
          file_path: "src/a.js",
          search: "before",
          replace: "BEFORE",
        },
      ],
    },
  });
  assert.equal(valid.isError, undefined);
  assert.equal(mutationCalls, 1);

  mode = "invalid";
  mutationCalls = 0;
  const invalid = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: invalid utf8",
      hunks: [
        {
          file_path: "src/a.js",
          search: "before",
          replace: "BEFORE",
        },
      ],
    },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /not valid UTF-8/);
  assert.equal(mutationCalls, 0);
});

test("repository reads accept valid U+FFFD and reject malformed UTF-8 bytes", async (t) => {
  let mode = "valid";
  const validBytes = Buffer.from("\uFEFFbefore \uFFFD after\n", "utf8");
  const invalidBytes = Buffer.from([
    0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, 0x20, 0xc3, 0x28,
  ]);
  const currentBytes = () =>
    mode.startsWith("valid") ? validBytes : invalidBytes;
  const blobIdFor = (bytes, algorithm = "sha1") =>
    createHash(algorithm)
      .update(`blob ${bytes.length}\0`, "utf8")
      .update(bytes)
      .digest("hex");
  const contentSha256For = (bytes) =>
    createHash("sha256").update(bytes).digest("hex");

  const { client, server } = await connectedPair(() => ({
    baseUrl: "https://gitlab.example.com",
    request: async (path, options = {}) => {
      const bytes = currentBytes();
      if (path instanceof URL || String(path).endsWith("/raw")) {
        assert.equal(options.responseType, "binary");
        if (!(path instanceof URL) && String(path).endsWith("/raw")) {
          assert.equal(options.maxBytes, 1_000_000);
        }
        if (mode === "missing-raw-content") {
          return { data: { encoding: "base64" } };
        }
        const rawBytes =
          mode === "wrong-raw" ? Buffer.from("wrong", "utf8") : bytes;
        return {
          data: {
            encoding: "base64",
            contentType: "text/plain",
            contentLength: rawBytes.length,
            content: rawBytes.toString("base64"),
          },
        };
      }
      if (String(path).includes("/repository/files/README.md")) {
        const fileBytes = [
          "normalized-invalid",
          "invalid-blob-id",
          "missing-raw-content",
          "wrong-raw",
        ].includes(mode)
          ? Buffer.from([0x28])
          : mode === "same-length-normalized-invalid"
            ? Buffer.from("before ((", "utf8")
            : bytes;
        return {
          data: {
            encoding: "base64",
            content: fileBytes.toString("base64"),
            content_sha256: contentSha256For(fileBytes),
            size: bytes.length,
            blob_id:
              mode === "invalid-blob-id"
                ? "not-a-blob"
                : blobIdFor(bytes, mode === "valid-sha256" ? "sha256" : "sha1"),
          },
        };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const validBlob = await client.callTool({
    name: "get_blob",
    arguments: { project: "group/project", blob_sha: "abcdef123456" },
  });
  assert.equal(validBlob.isError, undefined);
  assert.equal(
    validBlob.structuredContent.result.content,
    "\uFEFFbefore \uFFFD after\n",
  );
  assert.equal(validBlob.structuredContent.result.encoding, "utf-8");

  const validFile = await client.callTool({
    name: "get_file",
    arguments: {
      project: "group/project",
      path: "README.md",
      start_line: 1,
      end_line: 1,
    },
  });
  assert.equal(validFile.isError, undefined);
  assert.equal(
    validFile.structuredContent.result.content,
    "\uFEFFbefore \uFFFD after",
  );
  assert.equal(validFile.structuredContent.result.encoding, "utf-8");

  const validUrl = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
    },
  });
  assert.equal(validUrl.isError, undefined);
  assert.equal(
    validUrl.structuredContent.result.content,
    "\uFEFFbefore \uFFFD after\n",
  );

  mode = "valid-sha256";

  const validSha256File = await client.callTool({
    name: "get_file",
    arguments: { project: "group/project", path: "README.md" },
  });
  assert.equal(validSha256File.isError, undefined);
  assert.equal(
    validSha256File.structuredContent.result.content,
    "\uFEFFbefore \uFFFD after\n",
  );

  mode = "invalid";

  const invalidBlob = await client.callTool({
    name: "get_blob",
    arguments: { project: "group/project", blob_sha: "abcdef123456" },
  });
  assert.equal(invalidBlob.isError, undefined);
  assert.equal(invalidBlob.structuredContent.result.encoding, "base64");
  assert.equal(
    invalidBlob.structuredContent.result.content,
    invalidBytes.toString("base64"),
  );

  const invalidFile = await client.callTool({
    name: "get_file",
    arguments: { project: "group/project", path: "README.md" },
  });
  assert.equal(invalidFile.isError, undefined);
  assert.equal(invalidFile.structuredContent.result.encoding, "base64");
  assert.equal(
    invalidFile.structuredContent.result.content,
    invalidBytes.toString("base64"),
  );

  const invalidFileRange = await client.callTool({
    name: "get_file",
    arguments: {
      project: "group/project",
      path: "README.md",
      start_line: 1,
    },
  });
  assert.equal(invalidFileRange.isError, true);
  assert.match(
    invalidFileRange.content[0].text,
    /Line ranges require UTF-8 text content/u,
  );

  const invalidUrl = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
    },
  });
  assert.equal(invalidUrl.isError, true);
  assert.match(invalidUrl.content[0].text, /did not return valid UTF-8 text/u);

  mode = "normalized-invalid";

  const recoveredInvalidFile = await client.callTool({
    name: "get_file",
    arguments: { project: "group/project", path: "README.md" },
  });
  assert.equal(recoveredInvalidFile.isError, undefined);
  assert.equal(
    recoveredInvalidFile.structuredContent.result.encoding,
    "base64",
  );
  assert.equal(
    recoveredInvalidFile.structuredContent.result.content,
    invalidBytes.toString("base64"),
  );
  assert.equal(
    recoveredInvalidFile.structuredContent.result.content_sha256,
    contentSha256For(invalidBytes),
  );

  const recoveredInvalidFileRaw = await client.callTool({
    name: "get_file",
    arguments: {
      project: "group/project",
      path: "README.md",
      decode_text: false,
    },
  });
  assert.equal(recoveredInvalidFileRaw.isError, undefined);
  assert.equal(
    recoveredInvalidFileRaw.structuredContent.result.encoding,
    "base64",
  );
  assert.equal(
    recoveredInvalidFileRaw.structuredContent.result.content,
    invalidBytes.toString("base64"),
  );

  mode = "same-length-normalized-invalid";

  const recoveredSameLengthInvalidFile = await client.callTool({
    name: "get_file",
    arguments: { project: "group/project", path: "README.md" },
  });
  assert.equal(recoveredSameLengthInvalidFile.isError, undefined);
  assert.equal(
    recoveredSameLengthInvalidFile.structuredContent.result.encoding,
    "base64",
  );
  assert.equal(
    recoveredSameLengthInvalidFile.structuredContent.result.content,
    invalidBytes.toString("base64"),
  );

  mode = "invalid-blob-id";

  const invalidBlobIdFile = await client.callTool({
    name: "get_file",
    arguments: { project: "group/project", path: "README.md" },
  });
  assert.equal(invalidBlobIdFile.isError, true);
  assert.match(
    invalidBlobIdFile.content[0].text,
    /no valid blob_id is available for exact recovery/u,
  );

  mode = "missing-raw-content";

  const missingRawContentFile = await client.callTool({
    name: "get_file",
    arguments: { project: "group/project", path: "README.md" },
  });
  assert.equal(missingRawContentFile.isError, true);
  assert.match(
    missingRawContentFile.content[0].text,
    /raw blob recovery did not return base64 content/u,
  );

  mode = "wrong-raw";

  const wrongRawFile = await client.callTool({
    name: "get_file",
    arguments: { project: "group/project", path: "README.md" },
  });
  assert.equal(wrongRawFile.isError, true);
  assert.match(
    wrongRawFile.content[0].text,
    /raw blob recovery did not match the authoritative blob/u,
  );
});

test("apply_repository_hunks preflights every file before one atomic commit", async (t) => {
  const expectedHead = "a".repeat(40);
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("alpha\n").toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (path.endsWith("/repository/files/src%2Fb.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("beta beta\n").toString("base64"),
            blob_id: "c".repeat(40),
            last_commit_id: "last-b",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCalls += 1;
        return { data: { id: "unexpected" } };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: atomic preflight",
      hunks: [
        { file_path: "src/a.js", search: "alpha", replace: "ALPHA" },
        { file_path: "src/b.js", search: "beta", replace: "BETA" },
      ],
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /matches more than once/);
  assert.equal(mutationCalls, 0);
});

test("apply_repository_hunks rejects branch drift after file preflight", async (t) => {
  const expectedHead = "a".repeat(40);
  let branchReads = 0;
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        branchReads += 1;
        return {
          data: {
            commit: {
              id: branchReads === 1 ? expectedHead : "d".repeat(40),
            },
          },
        };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("before\n").toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (
        path === "/projects/group%2Fproject/repository/commits" &&
        options.method === "POST"
      ) {
        mutationCalls += 1;
        return { data: { id: "unexpected" } };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: reject branch drift",
      hunks: [{ file_path: "src/a.js", search: "before", replace: "after" }],
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_head_sha/);
  assert.equal(branchReads, 2);
  assert.equal(mutationCalls, 0);
});

test("apply_repository_hunks dry-run validates without mutating", async (t) => {
  const expectedHead = "a".repeat(40);
  let mutationCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest"
      ) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (path.endsWith("/repository/files/src%2Fa.js")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("before\n").toString("base64"),
            blob_id: "b".repeat(40),
            last_commit_id: "last-a",
          },
        };
      }
      if (options.method === "POST") mutationCalls += 1;
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "apply_repository_hunks",
    arguments: {
      project: "group/project",
      branch: "codex/test",
      expected_head_sha: expectedHead,
      commit_message: "test: dry run",
      dry_run: true,
      hunks: [{ file_path: "src/a.js", search: "before", replace: "after" }],
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.dry_run, true);
  assert.deepEqual(result.structuredContent.result.changed_paths, ["src/a.js"]);
  assert.equal(mutationCalls, 0);
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

test("create_commit rejects start_sha when the target branch already exists", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest" &&
        !options.method
      ) {
        return {
          data: {
            name: "codex/test",
            commit: { id: "a".repeat(40) },
          },
        };
      }
      throw new Error(
        "create_commit must not submit after existing-branch preflight",
      );
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
      commit_message: "test: reject existing branch start sha",
      start_sha: "a".repeat(40),
      actions: [{ action: "create", file_path: "test.txt", content: "hello" }],
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /only valid when creating a new branch/);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    "/projects/group%2Fproject/repository/branches/codex%2Ftest",
  );
});

test("create_commit rejects invalid start_sha values", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (
        path === "/projects/group%2Fproject/repository/branches/codex%2Ftest" &&
        !options.method
      ) {
        throw new GitLabApiError("GitLab API returned 404 Not Found.", {
          status: 404,
          method: "GET",
          path,
          response: {},
        });
      }
      return { data: { id: "new-commit" } };
    },
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
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].path,
    "/projects/group%2Fproject/repository/branches/codex%2Ftest",
  );
  assert.deepEqual(calls[1], {
    path: "/projects/group%2Fproject/repository/commits",
    options: {
      method: "POST",
      body: {
        branch: "codex/test",
        commit_message: "test: valid sha",
        actions: [
          { action: "create", file_path: "test.txt", content: "hello" },
        ],
        start_sha: "a".repeat(40),
      },
    },
  });
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
const HEAD_SHA_APPLIED = "def456abc789";
const HEAD_SHA_OTHER = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/** Standard MR metadata with a head SHA. */
function mrMetadata(headSha = HEAD_SHA) {
  return {
    data: {
      diff_refs: { head_sha: headSha, base_sha: "base", start_sha: "start" },
    },
  };
}

/** Discussions containing two valid suggestions. */
function discussionsWithSuggestions(appliedIds = []) {
  const applied = new Set(appliedIds);
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
                appliable: !applied.has(5),
                applied: applied.has(5),
                from_content: "old",
                to_content: "new",
              },
              {
                id: 6,
                from_line: 20,
                to_line: 20,
                appliable: !applied.has(6),
                applied: applied.has(6),
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
  let mutationCompleted = false;
  return {
    calls,
    factory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        // Route: MR metadata
        if (path === "/projects/group%2Fproject/merge_requests/1") {
          return mrMetadata(mutationCompleted ? HEAD_SHA_APPLIED : HEAD_SHA);
        }
        // Route: discussions
        if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
          return discussionsWithSuggestions(mutationCompleted ? [5, 6] : []);
        }
        if (
          path ===
          `/projects/group%2Fproject/repository/commits/${HEAD_SHA_APPLIED}`
        ) {
          return {
            data: {
              id: HEAD_SHA_APPLIED,
              parent_ids: [HEAD_SHA],
            },
          };
        }
        // Everything else goes to the final handler
        const response = await finalHandler(path, options);
        if (
          path === "/suggestions/5/apply" ||
          path === "/suggestions/batch_apply"
        ) {
          mutationCompleted = true;
        }
        return response;
      },
    }),
  };
}

test("suggestion workflows accept valid U+FFFD and reject malformed UTF-8", async (t) => {
  const path = "src/app.js";
  const validBefore = "\uFEFFold \uFFFD\nthree\n";
  const validAfter = "\uFEFFnew \uFFFD\nthree\n";
  const malformedBytes = Buffer.concat([
    Buffer.from("\uFEFFold ", "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("\nthree\n", "utf8"),
  ]);

  for (const workflow of [
    {
      name: "apply_merge_request_suggestion",
      mutationPath: "/suggestions/5/apply",
      arguments: {
        project: "group/project",
        merge_request_iid: 1,
        suggestion_id: 5,
        expected_head_sha: HEAD_SHA,
        acknowledge: true,
      },
    },
    {
      name: "batch_apply_merge_request_suggestions",
      mutationPath: "/suggestions/batch_apply",
      arguments: {
        project: "group/project",
        merge_request_iid: 1,
        ids: [5],
        expected_head_sha: HEAD_SHA,
        acknowledge: true,
      },
    },
  ]) {
    for (const mode of ["valid", "malformed"]) {
      await t.test(`${workflow.name} ${mode} source`, async (t) => {
        let mutationCompleted = false;
        const { client, server } = await connectedPair(() => ({
          request: async (requestPath, options = {}) => {
            if (requestPath === "/projects/group%2Fproject/merge_requests/1") {
              return mrMetadata(
                mutationCompleted ? HEAD_SHA_APPLIED : HEAD_SHA,
              );
            }
            if (
              requestPath ===
              "/projects/group%2Fproject/merge_requests/1/discussions"
            ) {
              return {
                data: [
                  {
                    id: "utf8-source",
                    notes: [
                      {
                        id: 100,
                        position: {
                          new_path: path,
                          old_path: path,
                          head_sha: mutationCompleted
                            ? HEAD_SHA_APPLIED
                            : HEAD_SHA,
                        },
                        suggestions: [
                          {
                            id: 5,
                            from_line: 1,
                            to_line: 1,
                            appliable: !mutationCompleted,
                            applied: mutationCompleted,
                            from_content: "\uFEFFold \uFFFD\n",
                            to_content: "\uFEFFnew \uFFFD\n",
                          },
                        ],
                      },
                    ],
                  },
                ],
              };
            }
            if (
              requestPath ===
              "/projects/group%2Fproject/repository/files/src%2Fapp.js"
            ) {
              const bytes =
                mode === "malformed"
                  ? malformedBytes
                  : Buffer.from(
                      mutationCompleted ? validAfter : validBefore,
                      "utf8",
                    );
              return {
                data: {
                  encoding: "base64",
                  content: bytes.toString("base64"),
                  size: bytes.length,
                },
              };
            }
            if (
              requestPath ===
              `/projects/group%2Fproject/repository/commits/${HEAD_SHA_APPLIED}`
            ) {
              return {
                data: {
                  id: HEAD_SHA_APPLIED,
                  parent_ids: [HEAD_SHA],
                },
              };
            }
            if (requestPath === workflow.mutationPath) {
              mutationCompleted = true;
              const applied = { id: 5, applicable: false, applied: true };
              return {
                data:
                  workflow.name === "batch_apply_merge_request_suggestions"
                    ? [applied]
                    : applied,
              };
            }
            assert.fail(
              `Unexpected request ${options.method || "GET"} ${requestPath}`,
            );
          },
        }));
        t.after(async () => {
          await client.close();
          await server.close();
        });

        const result = await client.callTool({
          name: workflow.name,
          arguments: workflow.arguments,
        });

        if (mode === "valid") {
          assert.equal(result.isError, undefined);
          assert.equal(mutationCompleted, true);
          const resultValue = result.structuredContent.result;
          const applied = Array.isArray(resultValue)
            ? resultValue[0]
            : resultValue;
          assert.equal(applied.applied, true);
          assert.equal(applied.post_apply_verified, true);
          assert.equal(applied.head_sha, HEAD_SHA_APPLIED);
        } else {
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /not valid UTF-8 text/u);
          assert.equal(mutationCompleted, false);
        }
      });
    }
  }
});

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
  assert.equal(result.structuredContent.result.post_apply_verified, true);
  assert.equal(result.structuredContent.result.previous_head_sha, HEAD_SHA);
  assert.equal(result.structuredContent.result.head_sha, HEAD_SHA_APPLIED);
  // Preflight MR/discussions, apply, then postflight MR/commit/discussions.
  assert.equal(calls.length, 6);
  assert.equal(calls[0].path, "/projects/group%2Fproject/merge_requests/1");
  assert.equal(
    calls[1].path,
    "/projects/group%2Fproject/merge_requests/1/discussions",
  );
  assert.equal(calls[2].path, "/suggestions/5/apply");
  assert.deepEqual(calls[2].options, { method: "PUT", body: {} });
  assert.equal(calls[3].path, "/projects/group%2Fproject/merge_requests/1");
  assert.equal(
    calls[4].path,
    `/projects/group%2Fproject/repository/commits/${HEAD_SHA_APPLIED}`,
  );
  assert.equal(
    calls[5].path,
    "/projects/group%2Fproject/merge_requests/1/discussions",
  );
});

test("apply_merge_request_suggestion returns verified applied state when GitLab's immediate response is stale", async (t) => {
  const { factory } = suggestionClientFactory(async () => ({
    data: {
      id: 5,
      applicable: false,
      applied: false,
    },
  }));
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
  assert.equal(result.structuredContent.result.post_apply_verified, true);
  assert.equal(result.structuredContent.result.head_sha, HEAD_SHA_APPLIED);
});

test("apply_merge_request_suggestion rejects adjacent control-flow context outside the replacement range", async (t) => {
  const calls = [];
  const path = "scripts/lib/workload-live-fixtures.mjs";
  const sourceLines = [
    "      if (NONTERMINAL_PIPELINE_STATES.has(current.status)) {",
    "        try {",
    '          await session.call("cancel_pipeline", {',
    "            project: session.project,",
    "            pipeline_id: fixture.pipeline.id,",
    "          });",
    "        } catch (error) {",
    "          if (!isNotFound(error)) throw error;",
    "        }",
    "      }",
    "    });",
  ];
  const fromContent = sourceLines.slice(1).join("\n") + "\n";
  const toContent =
    [
      sourceLines[0],
      "        try {",
      '          await session.call("cancel_pipeline", {',
      "            project: session.project,",
      "            pipeline_id: fixture.pipeline.id,",
      "          });",
      "        } catch (error) {",
      "          if (isNotFound(error)) return;",
      "          throw error;",
      "        }",
      "      }",
    ].join("\n") + "\n";
  const source = sourceLines.join("\n") + "\n";

  const { client, server } = await connectedPair(() => ({
    request: async (requestPath, options) => {
      calls.push({ path: requestPath, options });
      if (requestPath === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata();
      }
      if (
        requestPath === "/projects/group%2Fproject/merge_requests/1/discussions"
      ) {
        return {
          data: [
            {
              id: "historical-control-flow",
              notes: [
                {
                  id: 100,
                  position: {
                    new_path: path,
                    old_path: path,
                    head_sha: HEAD_SHA,
                  },
                  suggestions: [
                    {
                      id: 5,
                      from_line: 2,
                      to_line: 11,
                      appliable: true,
                      applied: false,
                      from_content: fromContent,
                      to_content: toContent,
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      if (
        requestPath ===
        "/projects/group%2Fproject/repository/files/scripts%2Flib%2Fworkload-live-fixtures.mjs"
      ) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from(source, "utf8").toString("base64"),
            size: Buffer.byteLength(source),
          },
        };
      }
      assert.fail(
        `Unexpected request after suggestion preflight: ${requestPath}`,
      );
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
  assert.match(
    result.content[0].text,
    /duplicates unchanged source context immediately before/,
  );
  assert.equal(calls.length, 3);
  assert.equal(
    calls.some(
      ({ path: requestPath }) => requestPath === "/suggestions/5/apply",
    ),
    false,
  );
});

test("apply_merge_request_suggestion reports ambiguous post-apply branch changes", async (t) => {
  const calls = [];
  let mutationCompleted = false;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata(mutationCompleted ? HEAD_SHA_OTHER : HEAD_SHA);
      }
      if (path === "/projects/group%2Fproject/merge_requests/1/discussions") {
        return discussionsWithSuggestions();
      }
      if (
        path ===
        `/projects/group%2Fproject/repository/commits/${HEAD_SHA_OTHER}`
      ) {
        return {
          data: {
            id: HEAD_SHA_OTHER,
            parent_ids: ["concurrent-head"],
          },
        };
      }
      if (path === "/suggestions/5/apply") {
        mutationCompleted = true;
        return { data: { id: 5, applicable: false, applied: false } };
      }
      assert.fail(`Unexpected request: ${path}`);
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
  assert.match(result.content[0].text, /postcondition is ambiguous/);
  assert.match(result.content[0].text, /concurrent change/i);
  assert.equal(calls.length, 5);
});

test("apply_merge_request_suggestion rejects a malformed post-apply file", async (t) => {
  const calls = [];
  let mutationCompleted = false;
  const path = "src/app.js";
  const original = "one\nold\nthree\n";
  const malformed = "one\nold\nnew\nthree\n";

  const { client, server } = await connectedPair(() => ({
    request: async (requestPath, options) => {
      calls.push({ path: requestPath, options });
      if (requestPath === "/projects/group%2Fproject/merge_requests/1") {
        return mrMetadata(mutationCompleted ? HEAD_SHA_APPLIED : HEAD_SHA);
      }
      if (
        requestPath === "/projects/group%2Fproject/merge_requests/1/discussions"
      ) {
        return {
          data: [
            {
              id: "content-verification",
              notes: [
                {
                  id: 100,
                  position: { new_path: path, old_path: path },
                  suggestions: [
                    {
                      id: 5,
                      from_line: 2,
                      to_line: 2,
                      appliable: !mutationCompleted,
                      applied: mutationCompleted,
                      from_content: "old\n",
                      to_content: "new\n",
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      if (
        requestPath ===
        "/projects/group%2Fproject/repository/files/src%2Fapp.js"
      ) {
        const content =
          options?.query?.ref === HEAD_SHA_APPLIED ? malformed : original;
        return {
          data: {
            encoding: "base64",
            content: Buffer.from(content, "utf8").toString("base64"),
            size: Buffer.byteLength(content),
          },
        };
      }
      if (
        requestPath ===
        `/projects/group%2Fproject/repository/commits/${HEAD_SHA_APPLIED}`
      ) {
        return {
          data: { id: HEAD_SHA_APPLIED, parent_ids: [HEAD_SHA] },
        };
      }
      if (requestPath === "/suggestions/5/apply") {
        mutationCompleted = true;
        return { data: { id: 5, applicable: false, applied: false } };
      }
      assert.fail(`Unexpected request: ${requestPath}`);
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
  assert.match(result.content[0].text, /resulting file does not match/);
  assert.match(result.content[0].text, /branch may have changed/i);
  assert.equal(
    calls.some(
      ({ path: requestPath, options }) =>
        requestPath ===
          "/projects/group%2Fproject/repository/files/src%2Fapp.js" &&
        options?.query?.ref === HEAD_SHA_APPLIED,
    ),
    true,
  );
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
  for (const suggestion of result.structuredContent.result) {
    assert.equal(suggestion.applied, true);
    assert.equal(suggestion.post_apply_verified, true);
    assert.equal(suggestion.previous_head_sha, HEAD_SHA);
    assert.equal(suggestion.head_sha, HEAD_SHA_APPLIED);
  }
  // Preflight MR/discussions, batch apply, then postflight MR/commit/discussions.
  assert.equal(calls.length, 6);
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
  assert.equal(calls[3].path, "/projects/group%2Fproject/merge_requests/1");
  assert.equal(
    calls[4].path,
    `/projects/group%2Fproject/repository/commits/${HEAD_SHA_APPLIED}`,
  );
  assert.equal(
    calls[5].path,
    "/projects/group%2Fproject/merge_requests/1/discussions",
  );
});

test("batch_apply_merge_request_suggestions preserves array shape for one suggestion", async (t) => {
  const { factory } = suggestionClientFactory(async () => ({
    data: [{ id: 5, applicable: true, applied: true }],
  }));
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
      ids: [5],
      expected_head_sha: HEAD_SHA,
      acknowledge: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(Array.isArray(result.structuredContent.result), true);
  assert.equal(result.structuredContent.result.length, 1);
  assert.equal(result.structuredContent.result[0].id, 5);
  assert.equal(result.structuredContent.result[0].applied, true);
  assert.equal(result.structuredContent.result[0].post_apply_verified, true);
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
      if (path === "/metadata") {
        return { data: { enterprise: true } };
      }
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
    { path: "/metadata", options: undefined },
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

test("rejects invalid GitLab search combinations before search dispatch", async (t) => {
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

  const invalidArguments = [
    {
      project: "group/project",
      scope: "projects",
      search: "contract",
    },
    {
      group: "parent/team",
      project: "group/project",
      scope: "issues",
      search: "contract",
    },
    {
      scope: "snippet_titles",
      search: "contract",
      search_type: "advanced",
    },
    {
      group: "parent/team",
      scope: "snippet_titles",
      search: "contract",
    },
    {
      project: "group/project",
      scope: "snippet_titles",
      search: "contract",
    },
    {
      project: "group/project",
      scope: "milestones",
      search: "contract",
      state: "opened",
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      state: "merged",
    },
    {
      project: "group/project",
      scope: "work_items",
      search: "contract",
      state: "merged",
    },
    {
      project: "group/project",
      scope: "milestones",
      search: "contract",
      fields: ["title"],
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      fields: [],
    },
    {
      project: "group/project",
      scope: "milestones",
      search: "contract",
      confidential: true,
    },
    {
      project: "group/project",
      scope: "milestones",
      search: "contract",
      include_archived: true,
    },
    {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "zoekt",
      exclude_forks: true,
    },
    {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      regex: true,
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      search_type: "zoekt",
    },
    {
      group: "parent/team",
      scope: "blobs",
      search: "contract",
      search_type: "basic",
    },
    {
      scope: "wiki_blobs",
      search: "contract",
      search_type: "basic",
    },
    {
      group: "parent/team",
      scope: "commits",
      search: "contract",
      search_type: "basic",
    },
    {
      scope: "notes",
      search: "contract",
      search_type: "basic",
    },
    {
      group: "parent/team",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      exclude_forks: true,
    },
    {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "basic",
      regex: true,
    },
    {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "basic",
      num_context_lines: 1,
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      search_type: "advanced",
      num_context_lines: 1,
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      order_by: "bogus",
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      order_by: "title",
    },
    {
      project: "group/project",
      scope: "milestones",
      search: "contract",
      order_by: "created_at",
      sort: "asc",
    },
    {
      project: "group/project",
      scope: "commits",
      search: "contract",
      sort: "asc",
    },
    {
      project: "group/project",
      scope: "notes",
      search: "contract",
      sort: "desc",
    },
    {
      scope: "users",
      search: "contract",
      include_archived: true,
    },
    {
      scope: "snippet_titles",
      search: "contract",
      include_archived: false,
    },
  ];

  for (const arguments_ of invalidArguments) {
    const result = await client.callTool({
      name: "search_gitlab",
      arguments: arguments_,
    });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(calls, []);
});

test("routes the supported GitLab search location/scope matrix", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/metadata") {
        return { data: { enterprise: true } };
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const premiumNonProjectScopes = new Set([
    "commits",
    "blobs",
    "wiki_blobs",
    "notes",
  ]);
  const matrix = [
    {
      location: {},
      path: "/search",
      scopes: [
        "projects",
        "issues",
        "work_items",
        "merge_requests",
        "milestones",
        "users",
        "commits",
        "blobs",
        "wiki_blobs",
        "notes",
        "snippet_titles",
      ],
    },
    {
      location: { group: "parent/team" },
      path: "/groups/parent%2Fteam/search",
      scopes: [
        "projects",
        "issues",
        "work_items",
        "merge_requests",
        "milestones",
        "users",
        "commits",
        "blobs",
        "wiki_blobs",
        "notes",
      ],
    },
    {
      location: { project: "group/project" },
      path: "/projects/group%2Fproject/search",
      scopes: [
        "issues",
        "work_items",
        "merge_requests",
        "milestones",
        "users",
        "commits",
        "blobs",
        "wiki_blobs",
        "notes",
      ],
    },
  ];

  for (const { location, path, scopes } of matrix) {
    const start = calls.length;
    for (const scope of scopes) {
      const result = await client.callTool({
        name: "search_gitlab",
        arguments: { ...location, scope, search: "contract" },
      });
      assert.equal(result.isError, undefined, `${path} scope=${scope}`);
    }
    assert.deepEqual(
      calls.slice(start).map((call) => call.path),
      scopes.flatMap((scope) =>
        location.project === undefined && premiumNonProjectScopes.has(scope)
          ? ["/metadata", path]
          : [path],
      ),
    );
  }
});

test("routes supported explicit basic GitLab search backends", async (t) => {
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

  for (const arguments_ of [
    {
      group: "parent/team",
      scope: "issues",
      search: "contract",
      search_type: "basic",
    },
    {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "basic",
    },
    {
      project: "group/project",
      scope: "wiki_blobs",
      search: "contract",
      search_type: "basic",
    },
    {
      project: "group/project",
      scope: "commits",
      search: "contract",
      search_type: "basic",
    },
    {
      project: "group/project",
      scope: "notes",
      search: "contract",
      search_type: "basic",
    },
  ]) {
    const result = await client.callTool({
      name: "search_gitlab",
      arguments: arguments_,
    });
    assert.equal(result.isError, undefined);
  }

  assert.deepEqual(
    calls.map(({ path, options }) => ({ path, query: options?.query })),
    [
      {
        path: "/groups/parent%2Fteam/search",
        query: {
          search: "contract",
          scope: "issues",
          search_type: "basic",
        },
      },
      ...["blobs", "wiki_blobs", "commits", "notes"].map((scope) => ({
        path: "/projects/group%2Fproject/search",
        query: {
          search: "contract",
          scope,
          search_type: "basic",
        },
      })),
    ],
  );
});

test("routes supported GitLab search state filters and ordering", async (t) => {
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

  for (const arguments_ of [
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      state: "opened",
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      state: "all",
    },
    {
      project: "group/project",
      scope: "work_items",
      search: "contract",
      state: "closed",
    },
    {
      project: "group/project",
      scope: "work_items",
      search: "contract",
      state: "all",
    },
    {
      project: "group/project",
      scope: "merge_requests",
      search: "contract",
      state: "merged",
      order_by: "created_at",
      sort: "asc",
    },
    {
      project: "group/project",
      scope: "merge_requests",
      search: "contract",
      state: "all",
    },
  ]) {
    const result = await client.callTool({
      name: "search_gitlab",
      arguments: arguments_,
    });
    assert.equal(result.isError, undefined);
  }

  const standaloneSort = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "issues",
      search: "contract",
      sort: "asc",
    },
  });
  assert.equal(standaloneSort.isError, true);

  assert.deepEqual(
    calls.map(({ path, options }) => ({ path, query: options?.query })),
    [
      {
        path: "/projects/group%2Fproject/search",
        query: { search: "contract", scope: "issues", state: "opened" },
      },
      {
        path: "/projects/group%2Fproject/search",
        query: { search: "contract", scope: "issues", state: "all" },
      },
      {
        path: "/projects/group%2Fproject/search",
        query: { search: "contract", scope: "work_items", state: "closed" },
      },
      {
        path: "/projects/group%2Fproject/search",
        query: { search: "contract", scope: "work_items", state: "all" },
      },
      {
        path: "/projects/group%2Fproject/search",
        query: {
          search: "contract",
          scope: "merge_requests",
          state: "merged",
          order_by: "created_at",
          sort: "asc",
        },
      },
      {
        path: "/projects/group%2Fproject/search",
        query: { search: "contract", scope: "merge_requests", state: "all" },
      },
    ],
  );
});

test("preflights GitLab version-gated search filters", async (t) => {
  const calls = [];
  let versionValue = "18.11.2-ee";
  let versionFailure = false;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/metadata") {
        return { data: { enterprise: true } };
      }
      if (path === "/version") {
        if (versionFailure) throw new Error("version unavailable");
        return { data: { version: versionValue } };
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const supportedContext = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      num_context_lines: 2,
    },
  });
  assert.equal(supportedContext.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
    {
      path: "/projects/group%2Fproject/search",
      options: {
        query: {
          search: "contract",
          scope: "blobs",
          search_type: "advanced",
          num_context_lines: 2,
        },
      },
    },
  ]);

  calls.length = 0;
  const supportedArchived = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "projects",
      search: "contract",
      include_archived: true,
    },
  });
  assert.equal(supportedArchived.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/version", options: undefined },
    {
      path: "/groups/parent%2Fteam/search",
      options: {
        query: {
          search: "contract",
          scope: "projects",
          include_archived: true,
        },
      },
    },
  ]);

  calls.length = 0;
  const supportedExact = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "blobs",
      search: "contract",
      search_type: "zoekt",
      exclude_forks: true,
      regex: true,
    },
  });
  assert.equal(supportedExact.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
    {
      path: "/groups/parent%2Fteam/search",
      options: {
        query: {
          search: "contract",
          scope: "blobs",
          search_type: "zoekt",
          exclude_forks: true,
          regex: true,
        },
      },
    },
  ]);

  calls.length = 0;
  versionValue = "18.6.9-ee";
  const unsupportedArchived = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "projects",
      search: "contract",
      include_archived: true,
    },
  });
  assert.equal(unsupportedArchived.isError, true);
  assert.deepEqual(calls, [{ path: "/version", options: undefined }]);

  calls.length = 0;
  const unsupportedForkExclusion = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "blobs",
      search: "contract",
      search_type: "zoekt",
      exclude_forks: true,
    },
  });
  assert.equal(unsupportedForkExclusion.isError, true);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
  ]);

  calls.length = 0;
  versionValue = "18.8.9-ee";
  const unsupportedRegex = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "blobs",
      search: "contract",
      search_type: "zoekt",
      regex: true,
    },
  });
  assert.equal(unsupportedRegex.isError, true);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
  ]);

  calls.length = 0;
  versionValue = "18.10.9-ee";
  const unsupportedContext = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      num_context_lines: 2,
    },
  });
  assert.equal(unsupportedContext.isError, true);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
  ]);

  calls.length = 0;
  versionValue = "18.11.2-ee";
  const affectedAdvancedZeroContext = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      num_context_lines: 0,
    },
  });
  assert.equal(affectedAdvancedZeroContext.isError, true);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
  ]);

  calls.length = 0;
  const unaffectedExactZeroContext = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "blobs",
      search: "contract",
      search_type: "zoekt",
      num_context_lines: 0,
    },
  });
  assert.equal(unaffectedExactZeroContext.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
    {
      path: "/groups/parent%2Fteam/search",
      options: {
        query: {
          search: "contract",
          scope: "blobs",
          search_type: "zoekt",
          num_context_lines: 0,
        },
      },
    },
  ]);

  calls.length = 0;
  versionValue = "18.11.4-ee";
  const fixedEighteenElevenZeroContext = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      num_context_lines: 0,
    },
  });
  assert.equal(fixedEighteenElevenZeroContext.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
    {
      path: "/projects/group%2Fproject/search",
      options: {
        query: {
          search: "contract",
          scope: "blobs",
          search_type: "advanced",
          num_context_lines: 0,
        },
      },
    },
  ]);

  calls.length = 0;
  versionValue = "19.0.0-ee";
  const affectedNineteenZeroContext = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      num_context_lines: 0,
    },
  });
  assert.equal(affectedNineteenZeroContext.isError, true);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
  ]);

  calls.length = 0;
  versionValue = "19.0.1-ee";
  const fixedNineteenZeroContext = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "advanced",
      num_context_lines: 0,
    },
  });
  assert.equal(fixedNineteenZeroContext.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    { path: "/version", options: undefined },
    {
      path: "/projects/group%2Fproject/search",
      options: {
        query: {
          search: "contract",
          scope: "blobs",
          search_type: "advanced",
          num_context_lines: 0,
        },
      },
    },
  ]);

  calls.length = 0;
  versionFailure = true;
  const unavailableVersion = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "projects",
      search: "contract",
      include_archived: true,
    },
  });
  assert.equal(unavailableVersion.isError, true);
  assert.deepEqual(calls, [{ path: "/version", options: undefined }]);
  versionFailure = false;

  calls.length = 0;
  versionValue = "unknown-version";
  const unknownVersion = await client.callTool({
    name: "search_gitlab",
    arguments: {
      group: "parent/team",
      scope: "projects",
      search: "contract",
      include_archived: true,
    },
  });
  assert.equal(unknownVersion.isError, true);
  assert.deepEqual(calls, [{ path: "/version", options: undefined }]);

  calls.length = 0;
  versionValue = "18.11.2-ee";
  const createdAtSorted = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "issues",
      search: "contract",
      order_by: "created_at",
      sort: "desc",
    },
  });
  assert.equal(createdAtSorted.isError, undefined);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/search",
      options: {
        query: {
          search: "contract",
          scope: "issues",
          order_by: "created_at",
          sort: "desc",
        },
      },
    },
  ]);
});

test("preflights tier-gated GitLab search capabilities", async (t) => {
  const calls = [];
  let enterpriseValue = true;
  let metadataFailure = false;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/metadata") {
        if (metadataFailure) throw new Error("metadata unavailable");
        return {
          data:
            enterpriseValue === undefined
              ? {}
              : { enterprise: enterpriseValue },
        };
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const supported = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "issues",
      search: "contract",
      fields: ["title"],
    },
  });
  assert.equal(supported.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    {
      path: "/projects/group%2Fproject/search",
      options: {
        query: {
          search: "contract",
          scope: "issues",
          "fields[]": ["title"],
        },
      },
    },
  ]);

  calls.length = 0;
  const supportedAdvanced = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "issues",
      search: "contract",
      search_type: "advanced",
    },
  });
  assert.equal(supportedAdvanced.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    {
      path: "/projects/group%2Fproject/search",
      options: {
        query: {
          search: "contract",
          scope: "issues",
          search_type: "advanced",
        },
      },
    },
  ]);

  calls.length = 0;
  const supportedInstanceRepositoryScope = await client.callTool({
    name: "search_gitlab",
    arguments: {
      scope: "blobs",
      search: "contract",
    },
  });
  assert.equal(supportedInstanceRepositoryScope.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/metadata", options: undefined },
    {
      path: "/search",
      options: {
        query: {
          search: "contract",
          scope: "blobs",
        },
      },
    },
  ]);

  calls.length = 0;
  enterpriseValue = false;
  for (const arguments_ of [
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      fields: ["title"],
    },
    {
      project: "group/project",
      scope: "issues",
      search: "contract",
      search_type: "advanced",
    },
    {
      project: "group/project",
      scope: "blobs",
      search: "contract",
      search_type: "zoekt",
    },
    {
      scope: "blobs",
      search: "contract",
    },
    {
      group: "parent/team",
      scope: "commits",
      search: "contract",
    },
  ]) {
    const communityEdition = await client.callTool({
      name: "search_gitlab",
      arguments: arguments_,
    });
    assert.equal(communityEdition.isError, true);
    assert.deepEqual(calls, [{ path: "/metadata", options: undefined }]);
    calls.length = 0;
  }

  enterpriseValue = undefined;
  const unknownEdition = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "merge_requests",
      search: "contract",
      fields: ["title"],
    },
  });
  assert.equal(unknownEdition.isError, true);
  assert.deepEqual(calls, [{ path: "/metadata", options: undefined }]);

  calls.length = 0;
  metadataFailure = true;
  const unavailableMetadata = await client.callTool({
    name: "search_gitlab",
    arguments: {
      project: "group/project",
      scope: "issues",
      search: "contract",
      fields: ["title"],
    },
  });
  assert.equal(unavailableMetadata.isError, true);
  assert.deepEqual(calls, [{ path: "/metadata", options: undefined }]);
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

test("forwards pipeline schedule refs unchanged and fails closed on invalid refs", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path, options) => {
      calls.push({ path: String(path), options });
      if (options?.body?.ref === "ambiguous") {
        throw new GitLabApiError("GitLab API returned 400 Bad Request.", {
          status: 400,
          method: "PUT",
          path: String(path),
        });
      }
      return { data: { id: 1, ref: options?.body?.ref } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const ref of ["main", "refs/heads/main", "refs/tags/main"]) {
    const result = await client.callTool({
      name: "update_pipeline_schedule",
      arguments: {
        project: "group/project",
        pipeline_schedule_id: 1,
        ref,
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.result.ref, ref);
  }

  const ambiguous = await client.callTool({
    name: "update_pipeline_schedule",
    arguments: {
      project: "group/project",
      pipeline_schedule_id: 1,
      ref: "ambiguous",
    },
  });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.structuredContent.result.status, 400);

  const callsBeforeInvalidInput = calls.length;
  const invalid = await client.callTool({
    name: "update_pipeline_schedule",
    arguments: {
      project: "group/project",
      pipeline_schedule_id: 1,
      ref: "",
    },
  });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, callsBeforeInvalidInput);

  assert.deepEqual(
    calls.map(({ path, options }) => ({
      path,
      method: options?.method,
      ref: options?.body?.ref,
    })),
    ["main", "refs/heads/main", "refs/tags/main", "ambiguous"].map((ref) => ({
      path: "/projects/group%2Fproject/pipeline_schedules/1",
      method: "PUT",
      ref,
    })),
  );
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

  const patch = calls.find((call) => call.options?.method === "PATCH");
  assert.deepEqual(patch.options.body.allowed_to_push, [
    { access_level: 30 },
    { user_id: 77 },
  ]);
  // The branch name travels in the path on update, never in the payload.
  assert.equal(patch.options.body.name, undefined);
  assert.doesNotMatch(JSON.stringify(patch.options), /\[\]\[/);
});

test("updates protected-branch access records without replacing unrelated policy", async (t) => {
  const calls = [];
  const current = {
    push_access_levels: [
      { id: 11, access_level: 30 },
      { id: 12, user_id: 77 },
    ],
    merge_access_levels: [{ id: 21, access_level: 40 }],
    unprotect_access_levels: [
      { id: 31, access_level: 40 },
      { id: 32, user_id: 88 },
    ],
  };
  const { client, server } = await connectedPair(() => ({
    baseUrl: "https://gitlab.example.com",
    token: "token",
    request: async (path, options = {}) => {
      calls.push({ path: String(path), options });
      const requested = String(path);
      if (requested.endsWith("/user")) {
        return { data: { id: 1, username: "contract", is_admin: false } };
      }
      if (requested.includes("/version")) {
        return { data: { version: "18.11.2" } };
      }
      if (requested.includes("/metadata")) {
        return { data: { enterprise: true, version: "18.11.2" } };
      }
      if (requested.includes("personal_access_tokens/self")) {
        return { data: { scopes: ["api"] } };
      }
      if (
        requested.endsWith("/protected_branches/main") &&
        options.method === undefined
      ) {
        return { data: current };
      }
      if (
        requested.endsWith("/protected_branches/main") &&
        options.method === "PATCH"
      ) {
        return { data: { name: "main" } };
      }
      return { data: [] };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const updated = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_push: [
        { id: 11, access_level: 0 },
        { id: 12, _destroy: true },
        { group_id: 55 },
      ],
      allowed_to_unprotect: [{ id: 32, _destroy: true }],
      allow_force_push: true,
      acknowledge_protection_change: true,
    },
  });
  assert.equal(updated.isError, undefined);

  const firstPatch = calls.find((call) => call.options?.method === "PATCH");
  assert.deepEqual(firstPatch.options.body, {
    allow_force_push: true,
    allowed_to_push: [
      { id: 11, access_level: 0 },
      { id: 12, _destroy: true },
      { group_id: 55 },
    ],
    allowed_to_unprotect: [{ id: 32, _destroy: true }],
  });
  assert.equal(firstPatch.options.body.allowed_to_merge, undefined);

  const scalarStart = calls.length;
  const scalarOnly = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      code_owner_approval_required: true,
      acknowledge_protection_change: true,
    },
  });
  assert.equal(scalarOnly.isError, undefined);
  const scalarPatch = calls
    .slice(scalarStart)
    .find((call) => call.options?.method === "PATCH");
  assert.deepEqual(scalarPatch.options.body, {
    code_owner_approval_required: true,
  });

  const patchCountBeforeStale = calls.filter(
    (call) => call.options?.method === "PATCH",
  ).length;
  const stale = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_push: [{ id: 999, access_level: 40 }],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(stale.isError, true);
  assert.equal(
    calls.filter((call) => call.options?.method === "PATCH").length,
    patchCountBeforeStale,
  );

  const patchCountBeforeDuplicate = calls.filter(
    (call) => call.options?.method === "PATCH",
  ).length;
  const duplicate = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_push: [
        { id: 11, access_level: 40 },
        { id: 11, _destroy: true },
      ],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(duplicate.isError, true);
  assert.equal(
    calls.filter((call) => call.options?.method === "PATCH").length,
    patchCountBeforeDuplicate,
  );

  const patchCountBeforeLockout = calls.filter(
    (call) => call.options?.method === "PATCH",
  ).length;
  const lockout = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_unprotect: [
        { id: 31, _destroy: true },
        { id: 32, _destroy: true },
      ],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(lockout.isError, true);
  assert.equal(
    calls.filter((call) => call.options?.method === "PATCH").length,
    patchCountBeforeLockout,
  );

  const callsBeforeMalformedDelete = calls.length;
  const malformedDelete = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_push: [{ _destroy: true }],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(malformedDelete.isError, true);
  assert.equal(calls.length, callsBeforeMalformedDelete);

  const callsBeforeDeleteWithFields = calls.length;
  const deleteWithFields = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_push: [{ id: 11, _destroy: true, access_level: 30 }],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(deleteWithFields.isError, true);
  assert.equal(calls.length, callsBeforeDeleteWithFields);

  const callsBeforeEmptyMutation = calls.length;
  const emptyMutation = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_push: [],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(emptyMutation.isError, true);
  assert.equal(calls.length, callsBeforeEmptyMutation);

  const callsBeforeNoOp = calls.length;
  const noOp = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      acknowledge_protection_change: true,
    },
  });
  assert.equal(noOp.isError, true);
  assert.equal(calls.length, callsBeforeNoOp);
});

test("constrains protected-ref access rules to GitLab-valid selectors and levels", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    baseUrl: "https://gitlab.example.com",
    token: "token",
    request: async (path, options = {}) => {
      calls.push({ path: String(path), options });
      const requested = String(path);
      if (requested.endsWith("/user")) {
        return { data: { id: 1, username: "contract", is_admin: true } };
      }
      if (requested.includes("/version")) {
        return { data: { version: "18.11.2" } };
      }
      if (requested.includes("/metadata")) {
        return { data: { enterprise: false, version: "18.11.2" } };
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

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const selectorAlternatives = (toolName, field) => {
    const items = byName.get(toolName).inputSchema.properties[field].items;
    const alternatives = items.anyOf || items.oneOf;
    assert.ok(Array.isArray(alternatives), `${toolName}.${field}`);
    assert.ok(
      alternatives.every(
        (alternative) => alternative.additionalProperties === false,
      ),
      `${toolName}.${field} must advertise strict selector objects`,
    );
    return alternatives;
  };
  const selectorNames = (toolName, field) =>
    selectorAlternatives(toolName, field).map((alternative) => {
      const required = new Set(alternative.required || []);
      if (required.has("_destroy")) {
        assert.equal(required.has("id"), true);
        return "_destroy";
      }
      return ["access_level", "user_id", "group_id", "deploy_key_id"].find(
        (name) => required.has(name),
      );
    });
  const literalValues = (schema) => {
    if (schema.const !== undefined) return [schema.const];
    if (Array.isArray(schema.enum)) return schema.enum;
    for (const keyword of ["anyOf", "oneOf"]) {
      if (Array.isArray(schema[keyword])) {
        return schema[keyword].flatMap(literalValues);
      }
    }
    return [];
  };
  const advertisedLevels = (toolName, field) => {
    const accessAlternative = selectorAlternatives(toolName, field).find(
      (alternative) => alternative.required?.includes("access_level"),
    );
    return literalValues(accessAlternative.properties.access_level).sort(
      (left, right) => left - right,
    );
  };

  assert.deepEqual(selectorNames("protect_branch", "allowed_to_push"), [
    "access_level",
    "user_id",
    "group_id",
    "deploy_key_id",
  ]);
  assert.deepEqual(selectorNames("protect_branch", "allowed_to_merge"), [
    "access_level",
    "user_id",
    "group_id",
  ]);
  assert.deepEqual(selectorNames("protect_branch", "allowed_to_unprotect"), [
    "access_level",
    "user_id",
    "group_id",
  ]);
  assert.deepEqual(
    selectorNames("update_protected_branch", "allowed_to_push"),
    ["access_level", "user_id", "group_id", "deploy_key_id", "_destroy"],
  );
  assert.deepEqual(
    selectorNames("update_protected_branch", "allowed_to_merge"),
    ["access_level", "user_id", "group_id", "_destroy"],
  );
  assert.deepEqual(
    selectorNames("update_protected_branch", "allowed_to_unprotect"),
    ["access_level", "user_id", "group_id", "_destroy"],
  );
  assert.deepEqual(selectorNames("protect_tag", "allowed_to_create"), [
    "access_level",
    "user_id",
    "group_id",
    "deploy_key_id",
  ]);
  assert.deepEqual(
    advertisedLevels("protect_branch", "allowed_to_push"),
    [0, 30, 40, 60],
  );
  assert.deepEqual(
    advertisedLevels("protect_branch", "allowed_to_merge"),
    [0, 30, 40, 60],
  );
  assert.deepEqual(
    advertisedLevels("protect_branch", "allowed_to_unprotect"),
    [30, 40, 60],
  );
  assert.deepEqual(
    advertisedLevels("update_protected_branch", "allowed_to_push"),
    [0, 30, 40, 60],
  );
  assert.deepEqual(
    advertisedLevels("update_protected_branch", "allowed_to_merge"),
    [0, 30, 40, 60],
  );
  assert.deepEqual(
    advertisedLevels("update_protected_branch", "allowed_to_unprotect"),
    [30, 40, 60],
  );
  assert.deepEqual(
    advertisedLevels("protect_tag", "allowed_to_create"),
    [0, 30, 40],
  );
  assert.deepEqual(
    literalValues(
      byName.get("protect_tag").inputSchema.properties.create_access_level,
    ).sort((left, right) => left - right),
    [0, 30, 40],
  );

  for (const access_level of [0, 30, 40, 60]) {
    const result = await client.callTool({
      name: "protect_branch",
      arguments: {
        project: "group/project",
        name: `level-${access_level}`,
        allowed_to_push: [{ access_level }],
        allowed_to_merge: [{ access_level }],
        allowed_to_unprotect: [
          { access_level: access_level === 0 ? 30 : access_level },
        ],
        acknowledge_protection_change: true,
      },
    });
    assert.equal(result.isError, undefined);
  }

  const branchSelectorStart = calls.length;
  const branchSelectors = await client.callTool({
    name: "protect_branch",
    arguments: {
      project: "group/project",
      name: "selector-forms",
      allowed_to_push: [{ user_id: 7 }, { group_id: 8 }, { deploy_key_id: 9 }],
      allowed_to_merge: [{ user_id: 10 }, { group_id: 11 }],
      allowed_to_unprotect: [{ user_id: 12 }, { group_id: 13 }],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(branchSelectors.isError, undefined);
  const branchSelectorPost = calls
    .slice(branchSelectorStart)
    .find((call) => call.options?.method === "POST");
  assert.deepEqual(branchSelectorPost.options.body.allowed_to_push, [
    { user_id: 7 },
    { group_id: 8 },
    { deploy_key_id: 9 },
  ]);
  assert.deepEqual(branchSelectorPost.options.body.allowed_to_merge, [
    { user_id: 10 },
    { group_id: 11 },
  ]);
  assert.deepEqual(branchSelectorPost.options.body.allowed_to_unprotect, [
    { user_id: 12 },
    { group_id: 13 },
  ]);

  const mutationSelectorStart = calls.length;
  const mutationSelectors = await client.callTool({
    name: "update_protected_branch",
    arguments: {
      project: "group/project",
      name: "main",
      allowed_to_push: [
        { deploy_key_id: 14 },
        { user_id: 15 },
        { group_id: 16 },
      ],
      allowed_to_merge: [{ user_id: 17 }, { group_id: 18 }],
      allowed_to_unprotect: [{ user_id: 19 }, { group_id: 20 }],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(mutationSelectors.isError, undefined);
  const mutationSelectorPatch = calls
    .slice(mutationSelectorStart)
    .find((call) => call.options?.method === "PATCH");
  assert.deepEqual(mutationSelectorPatch.options.body.allowed_to_push, [
    { deploy_key_id: 14 },
    { user_id: 15 },
    { group_id: 16 },
  ]);
  assert.deepEqual(mutationSelectorPatch.options.body.allowed_to_merge, [
    { user_id: 17 },
    { group_id: 18 },
  ]);
  assert.deepEqual(mutationSelectorPatch.options.body.allowed_to_unprotect, [
    { user_id: 19 },
    { group_id: 20 },
  ]);

  for (const access_level of [0, 30, 40]) {
    const result = await client.callTool({
      name: "protect_tag",
      arguments: {
        project: "group/project",
        name: `tag-level-${access_level}`,
        create_access_level: access_level,
        allowed_to_create: [{ access_level }],
        acknowledge_protection_change: true,
      },
    });
    assert.equal(result.isError, undefined);
  }

  const tagSelectorStart = calls.length;
  const tagSelectors = await client.callTool({
    name: "protect_tag",
    arguments: {
      project: "group/project",
      name: "tag-selector-forms",
      allowed_to_create: [
        { user_id: 21 },
        { group_id: 22 },
        { deploy_key_id: 23 },
      ],
      acknowledge_protection_change: true,
    },
  });
  assert.equal(tagSelectors.isError, undefined);
  const tagSelectorPost = calls
    .slice(tagSelectorStart)
    .find((call) => call.options?.method === "POST");
  assert.deepEqual(tagSelectorPost.options.body.allowed_to_create, [
    { user_id: 21 },
    { group_id: 22 },
    { deploy_key_id: 23 },
  ]);

  const assertRejectedBeforeRequest = async (name, arguments_) => {
    const before = calls.length;
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.equal(calls.length, before);
  };

  const branchBase = {
    project: "group/project",
    name: "invalid",
    allowed_to_unprotect: [{ access_level: 40 }],
    acknowledge_protection_change: true,
  };
  await assertRejectedBeforeRequest("protect_branch", {
    ...branchBase,
    allowed_to_push: [{ access_level: 17 }],
  });
  await assertRejectedBeforeRequest("protect_branch", {
    ...branchBase,
    allowed_to_merge: [{ deploy_key_id: 7 }],
  });
  await assertRejectedBeforeRequest("protect_branch", {
    ...branchBase,
    allowed_to_unprotect: [{ access_level: 0 }],
  });
  await assertRejectedBeforeRequest("protect_branch", {
    ...branchBase,
    allowed_to_push: [{ access_level: 30, user_id: 7 }],
  });
  await assertRejectedBeforeRequest("update_protected_branch", {
    project: "group/project",
    name: "main",
    allowed_to_unprotect: [{ id: 31, access_level: 0 }],
    acknowledge_protection_change: true,
  });
  await assertRejectedBeforeRequest("update_protected_branch", {
    project: "group/project",
    name: "main",
    allowed_to_merge: [{ deploy_key_id: 24 }],
    acknowledge_protection_change: true,
  });
  await assertRejectedBeforeRequest("protect_tag", {
    project: "group/project",
    name: "invalid-tag",
    create_access_level: 60,
    acknowledge_protection_change: true,
  });
  await assertRejectedBeforeRequest("protect_tag", {
    project: "group/project",
    name: "invalid-tag-rule-level",
    allowed_to_create: [{ access_level: 17 }],
    acknowledge_protection_change: true,
  });
  await assertRejectedBeforeRequest("protect_tag", {
    project: "group/project",
    name: "invalid-tag-rule",
    allowed_to_create: [{ access_level: 40, group_id: 7 }],
    acknowledge_protection_change: true,
  });
});

test("repository line ranges reject starts beyond EOF coherently", async (t) => {
  const text = "one\ntwo\nthree";
  const encoded = Buffer.from(text).toString("base64");
  const { client, server } = await connectedPair(() => ({
    request: async (path) => {
      if (path instanceof URL) {
        const content = path.pathname.endsWith("/EMPTY.txt") ? "" : text;
        return {
          data: {
            encoding: "base64",
            contentType: "text/plain",
            contentLength: Buffer.byteLength(content),
            content: Buffer.from(content).toString("base64"),
          },
        };
      }
      if (String(path).includes("/repository/files/EMPTY.txt")) {
        return {
          data: {
            encoding: "base64",
            content: "",
          },
        };
      }
      if (String(path).includes("/repository/files/README.md")) {
        return {
          data: {
            encoding: "base64",
            content: encoded,
          },
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

  const exactlyAtEof = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
      start_line: 3,
    },
  });
  assert.equal(exactlyAtEof.isError, undefined);
  assert.equal(exactlyAtEof.structuredContent.result.content, "three");
  assert.deepEqual(exactlyAtEof.structuredContent.result.lineRange, {
    start: 3,
    end: 3,
    total: 3,
  });

  const openEnded = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
      start_line: 2,
    },
  });
  assert.equal(openEnded.isError, undefined);
  assert.equal(openEnded.structuredContent.result.content, "two\nthree");
  assert.deepEqual(openEnded.structuredContent.result.lineRange, {
    start: 2,
    end: 3,
    total: 3,
  });

  const clampedEnd = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
      start_line: 1,
      end_line: 99,
    },
  });
  assert.equal(clampedEnd.isError, undefined);
  assert.equal(clampedEnd.structuredContent.result.content, text);
  assert.deepEqual(clampedEnd.structuredContent.result.lineRange, {
    start: 1,
    end: 3,
    total: 3,
  });

  const onePastEof = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
      start_line: 4,
    },
  });
  assert.equal(onePastEof.isError, true);
  assert.match(
    onePastEof.structuredContent.result.message,
    /start_line 4 exceeds file line count 3/u,
  );

  const inverted = await client.callTool({
    name: "fetch_gitlab_file_url",
    arguments: {
      url: "https://gitlab.example.com/group/project/-/blob/main/README.md",
      start_line: 3,
      end_line: 2,
    },
  });
  assert.equal(inverted.isError, true);
  assert.match(
    inverted.structuredContent.result.message,
    /end_line must be greater than or equal to start_line/u,
  );

  const repositoryFile = await client.callTool({
    name: "get_file",
    arguments: {
      project: "group/project",
      path: "README.md",
      start_line: 3,
    },
  });
  assert.equal(repositoryFile.isError, undefined);
  assert.equal(repositoryFile.structuredContent.result.content, "three");
  assert.deepEqual(repositoryFile.structuredContent.result.lineRange, {
    start: 3,
    end: 3,
    total: 3,
  });

  const repositoryFileBeyondEof = await client.callTool({
    name: "get_file",
    arguments: {
      project: "group/project",
      path: "README.md",
      start_line: 4,
    },
  });
  assert.equal(repositoryFileBeyondEof.isError, true);
  assert.match(
    repositoryFileBeyondEof.structuredContent.result.message,
    /start_line 4 exceeds file line count 3/u,
  );

  for (const [name, arguments_] of [
    [
      "fetch_gitlab_file_url",
      {
        url: "https://gitlab.example.com/group/project/-/blob/main/EMPTY.txt",
        start_line: 1,
      },
    ],
    [
      "get_file",
      {
        project: "group/project",
        path: "EMPTY.txt",
        start_line: 1,
      },
    ],
  ]) {
    const emptyFile = await client.callTool({ name, arguments: arguments_ });
    assert.equal(emptyFile.isError, undefined);
    assert.equal(emptyFile.structuredContent.result.content, "");
    assert.deepEqual(emptyFile.structuredContent.result.lineRange, {
      start: 1,
      end: 1,
      total: 1,
    });
  }

  const emptyFileWithoutRange = await client.callTool({
    name: "get_file",
    arguments: {
      project: "group/project",
      path: "EMPTY.txt",
    },
  });
  assert.equal(emptyFileWithoutRange.isError, undefined);
  assert.equal(emptyFileWithoutRange.structuredContent.result.content, "");
  assert.equal(
    emptyFileWithoutRange.structuredContent.result.encoding,
    "base64",
  );
  assert.equal(
    emptyFileWithoutRange.structuredContent.result.lineRange,
    undefined,
  );
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
        const content = "one\ntwo\nthree\n";
        return {
          data: {
            encoding: "base64",
            contentType: "text/plain",
            contentLength: Buffer.byteLength(content),
            content: Buffer.from(content).toString("base64"),
          },
        };
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
