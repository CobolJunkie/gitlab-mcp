import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

const contracts = JSON.parse(
  await readFile(
    new URL("../../docs/gitlab-tool-contracts.json", import.meta.url),
    "utf8",
  ),
);

const STRING_SAMPLES = {
  project: "group/project",
  group: "parent/team",
  path: "src/app.js",
  file_path: "src/app.js",
  previous_path: "src/old.js",
  artifact_path: "reports/result.json",
  branch: "codex/contract",
  source_branch: "codex/source",
  target_branch: "main",
  start_branch: "main",
  ref: "main",
  from: "main",
  to: "next",
  sha: "abcdef123456",
  blob_sha: "abcdef123456",
  search: "contract",
  title: "Contract title",
  body: "Contract body",
  description: "Contract description",
  content: "contract content",
  commit_message: "test: contract",
  merge_commit_message: "Merge contract",
  squash_commit_message: "Squash contract",
  discussion_id: "discussion-1",
  author_email: "contract@example.com",
  author_name: "Contract Test",
  key: "CONTRACT_KEY",
  value: "contract-value",
  name: "thumbsup",
};

function sampleString(name, schema) {
  if (schema.format === "email") {
    return "contract@example.com";
  }
  if (schema.format === "date") {
    return "2026-07-27";
  }
  if (schema.format === "date-time") {
    return "2026-07-27T12:00:00Z";
  }
  if (schema.format === "uri" || schema.format === "url") {
    return "https://gitlab.example.com/group/project/-/blob/main/README.md";
  }
  return STRING_SAMPLES[name] || `${name || "value"}-contract`;
}

function sampleValue(schema, name) {
  if (schema.const !== undefined) {
    return schema.const;
  }
  if (schema.enum) {
    return schema.enum[0];
  }
  if (schema.oneOf) {
    return sampleValue(schema.oneOf[0], name);
  }
  if (schema.anyOf) {
    const candidate = schema.anyOf.find((item) => item.type !== "null");
    return sampleValue(candidate || schema.anyOf[0], name);
  }
  if (schema.type === "object" || schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [
        key,
        sampleValue(value, key),
      ]),
    );
  }
  if (schema.type === "array") {
    return [sampleValue(schema.items || { type: "string" }, name)];
  }
  if (schema.type === "boolean") {
    return true;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (schema.minimum !== undefined) {
      return schema.minimum;
    }
    if (schema.exclusiveMinimum !== undefined) {
      return schema.exclusiveMinimum + 1;
    }
    return 7;
  }
  if (schema.type === "null") {
    return null;
  }
  return sampleString(name, schema);
}

function argumentsFor(tool) {
  const args = sampleValue(tool.inputSchema, tool.name);
  if (tool.name === "search_gitlab") {
    delete args.group;
    args.scope = "issues";
    args.state = "opened";
    args.fields = ["title"];
    args.confidential = true;
    delete args.search_type;
    delete args.include_archived;
    delete args.exclude_forks;
    delete args.regex;
    delete args.num_context_lines;
    delete args.order_by;
    delete args.sort;
  }
  if (tool.name === "fetch_gitlab_file_url") {
    args.url = "https://gitlab.example.com/group/project/-/blob/main/README.md";
  }
  if (tool.name === "download_gitlab_attachment") {
    args.url =
      "https://gitlab.example.com/group/project/-/uploads/hash/file.txt";
  }
  if (tool.name === "revert_commit") {
    args.sha = "b".repeat(40);
    args.expected_head_sha = "a".repeat(40);
    args.dry_run = false;
  }
  if (tool.name === "cherry_pick_commit") {
    args.sha = "b".repeat(40);
    args.expected_head_sha = "a".repeat(40);
    args.message = "Contract cherry-pick";
    args.dry_run = false;
  }
  if (tool.name === "apply_repository_hunks") {
    args.expected_head_sha = "a".repeat(40);
    args.dry_run = false;
    for (const hunk of args.hunks || []) {
      hunk.file_path = "src/app.js";
      hunk.search = "one";
      hunk.replace = "ONE";
      delete hunk.expected_blob_sha;
    }
  }
  if (tool.name === "commit_job_artifact_file") {
    args.source_project = "group/project";
    args.job_id = 1;
    args.artifact_path = "reports/result.json";
    args.target_project = "group/project";
    args.target_branch = "codex/contract";
    args.target_path = "src/app.js";
    args.expected_head_sha = "a".repeat(40);
    args.mode = "update";
    args.commit_message = "test: promote artifact";
  }
  if (["create_file", "update_file", "delete_file"].includes(tool.name)) {
    // Intentionally exercise GitLab's target-branch creation path in the
    // committed route contract instead of relying on generic optional samples.
    args.branch = "codex/contract";
    args.start_branch = "main";
  }
  if (tool.name === "create_commit") {
    delete args.start_sha;
    args.start_branch = "main";
    for (const action of args.actions || []) {
      if (action && action.action !== "create") {
        action.last_commit_id = "last-commit-id";
      }
    }
  }
  if (tool.name === "create_destructive_commit") {
    delete args.force;
    args.start_sha = "a".repeat(40);
  }
  if (tool.name === "delete_branch") {
    args.expected_head_sha = "a".repeat(40);
    args.acknowledge_branch_deletion = true;
  }
  if (
    tool.name === "merge_merge_request" ||
    tool.name === "approve_merge_request"
  ) {
    args.sha = "a".repeat(40);
  }
  if (
    tool.name === "apply_merge_request_suggestion" ||
    tool.name === "batch_apply_merge_request_suggestions"
  ) {
    args.expected_head_sha = "contract-head-sha-000000000000000000000000";
  }
  if (tool.name === "stop_environment" || tool.name === "delete_environment") {
    args.environment_id = 7;
    args.expected_environment_name = "contract";
  }
  if (
    tool.name === "delete_project_label" ||
    tool.name === "delete_group_label"
  ) {
    args.label_id = 7;
    args.expected_label_name = "contract";
  }
  if (
    tool.name === "create_project_milestone" ||
    tool.name === "update_project_milestone" ||
    tool.name === "create_group_milestone" ||
    tool.name === "update_group_milestone"
  ) {
    args.start_date = "2026-09-26";
    args.due_date = "2026-10-03";
  }
  if (
    tool.name === "delete_project_milestone" ||
    tool.name === "delete_group_milestone"
  ) {
    args.milestone_id = 7;
    args.expected_milestone_title = "contract";
  }
  if (tool.name === "get_project_access_token") {
    args.token_id = 7;
  }
  if (tool.name === "create_project_access_token") {
    args.name = "contract";
    args.expires_at = "2026-10-16";
  }
  if (tool.name === "rotate_project_access_token") {
    args.token_id = 7;
    args.expected_token_name = "contract";
    args.expires_at = "2026-10-16";
  }
  if (tool.name === "revoke_project_access_token") {
    args.token_id = 7;
    args.expected_token_name = "contract";
  }
  if (tool.name === "replace_project_access_token_ci_credential") {
    args.old_token_id = 7;
    args.expected_old_token_name = "contract";
    args.replacement_name = "contract-replacement";
    args.replacement_expires_at = "2026-10-16";
    args.ci_project = "group/project";
    args.ci_variable_key = "CONTRACT_KEY";
    args.ci_variable_environment_scope = "*";
  }
  if (
    tool.name === "protect_branch" ||
    tool.name === "update_protected_branch"
  ) {
    for (const field of [
      "allowed_to_push",
      "allowed_to_merge",
      "allowed_to_unprotect",
    ]) {
      for (const entry of args[field] || []) {
        delete entry.id;
        delete entry._destroy;
        delete entry.user_id;
        delete entry.group_id;
        delete entry.deploy_key_id;
      }
    }
  }
  if (tool.name === "protect_tag") {
    for (const entry of args.allowed_to_create || []) {
      delete entry.user_id;
      delete entry.group_id;
      delete entry.deploy_key_id;
    }
  }
  return args;
}

function safetyFor(tool) {
  if (tool.annotations.destructiveHint) {
    return "destructive";
  }
  return tool.annotations.readOnlyHint ? "read" : "write";
}

function normalizedCall(path, options = {}) {
  return {
    method: options.method || "GET",
    path: path instanceof URL ? path.toString() : path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.body ? { body: options.body } : {}),
    ...(options.responseType ? { responseType: options.responseType } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  };
}

function callSignature(call) {
  return [
    `${call.method} ${call.path}`,
    call.query ? `query=${JSON.stringify(call.query)}` : undefined,
    call.body ? `body=${JSON.stringify(call.body)}` : undefined,
    call.responseType ? `responseType=${call.responseType}` : undefined,
    call.maxBytes ? `maxBytes=${call.maxBytes}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function accessTokenMetadata(id = 7, name = "contract") {
  return {
    id,
    user_id: 8,
    name,
    scopes: ["api"],
    active: true,
    revoked: false,
    access_level: 40,
  };
}

function responseFor(
  path,
  options = {},
  activeToolName,
  suggestionMutationCompleted = false,
  hunkMutationCompleted = false,
  artifactMutationCompleted = false,
  revertMutationCompleted = false,
  cherryPickMutationCompleted = false,
  branchDeletionCompleted = false,
  tagDeletionCompleted = false,
) {
  const route = String(path);
  if (route === "/user") {
    return { data: { id: 7, username: "contract-user" } };
  }
  if (route === "/version") {
    return { data: { version: "18.2.0", revision: "contract" } };
  }
  if (route === "/metadata") {
    return {
      data: {
        version: "18.2.0",
        revision: "contract",
        enterprise: true,
      },
    };
  }
  if (route.includes("/merge_requests/") && route.endsWith("/discussions")) {
    const suggestionApplied =
      suggestionMutationCompleted &&
      (activeToolName === "apply_merge_request_suggestion" ||
        activeToolName === "batch_apply_merge_request_suggestions");
    return {
      data: [
        {
          id: "disc-contract",
          individual_note: false,
          notes: [
            {
              id: 1,
              type: "DiffNote",
              body: "contract",
              system: false,
              noteable_id: 1,
              noteable_type: "MergeRequest",
              project_id: 12,
              suggestions: [
                {
                  id: 1,
                  from_line: 10,
                  to_line: 10,
                  appliable: !suggestionApplied,
                  applied: suggestionApplied,
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
  if (/\/merge_requests\/\d+$/.test(route)) {
    const headSha =
      suggestionMutationCompleted &&
      (activeToolName === "apply_merge_request_suggestion" ||
        activeToolName === "batch_apply_merge_request_suggestions")
        ? "contract-applied-head-0000000000000000000000"
        : "contract-head-sha-000000000000000000000000";
    return {
      data: {
        diff_refs: {
          head_sha: headSha,
          base_sha: "contract-base",
          start_sha: "contract-start",
        },
      },
    };
  }
  if (
    route.includes("/repository/commits/") &&
    (activeToolName === "apply_merge_request_suggestion" ||
      activeToolName === "batch_apply_merge_request_suggestions")
  ) {
    return {
      data: {
        id: "contract-applied-head-0000000000000000000000",
        parent_ids: ["contract-head-sha-000000000000000000000000"],
      },
    };
  }
  if (
    activeToolName === "revert_commit" &&
    route === "/projects/group%2Fproject/repository/merge_base"
  ) {
    return {
      data: {
        id: "b".repeat(40),
      },
    };
  }
  if (
    activeToolName === "delete_branch" &&
    route === "/projects/group%2Fproject/repository/branches"
  ) {
    return { data: [], pagination: {} };
  }
  if (
    activeToolName === "delete_tag" &&
    route === "/projects/group%2Fproject/repository/tags/tag_name-contract"
  ) {
    if (tagDeletionCompleted && !options.method) {
      throw new GitLabApiError("Tag not found.", {
        status: 404,
        method: "GET",
        path: route,
      });
    }
    return {
      data: {
        name: "tag_name-contract",
        target: "a".repeat(40),
        release: null,
      },
    };
  }
  if (
    activeToolName === "delete_tag" &&
    route === "/projects/group%2Fproject/repository/tags" &&
    tagDeletionCompleted
  ) {
    return { data: [], pagination: {} };
  }
  if (route.includes("/repository/branches/")) {
    if (activeToolName === "delete_branch" && branchDeletionCompleted) {
      throw new GitLabApiError("Branch not found.", {
        status: 404,
        method: "GET",
        path: route,
      });
    }
    let branchCommitId = "a".repeat(40);
    if (
      (activeToolName === "revert_commit" && revertMutationCompleted) ||
      (activeToolName === "cherry_pick_commit" && cherryPickMutationCompleted)
    ) {
      branchCommitId = "c".repeat(40);
    } else if (
      (activeToolName === "apply_repository_hunks" && hunkMutationCompleted) ||
      (activeToolName === "commit_job_artifact_file" &&
        artifactMutationCompleted)
    ) {
      branchCommitId = 7;
    }
    return {
      data: {
        commit: {
          id: branchCommitId,
        },
      },
    };
  }
  if (route === "/personal_access_tokens/self") {
    return { data: { active: true, scopes: ["api"] } };
  }
  if (route.endsWith("/access_tokens") && options.method === "POST") {
    const id =
      activeToolName === "replace_project_access_token_ci_credential" ? 8 : 17;
    const name =
      activeToolName === "replace_project_access_token_ci_credential"
        ? "contract-replacement"
        : "contract";
    return {
      data: {
        ...accessTokenMetadata(id, name),
        token: "contract-one-time-token",
      },
    };
  }
  if (route.endsWith("/access_tokens/7/rotate")) {
    return {
      data: {
        ...accessTokenMetadata(19, "contract"),
        token: "contract-one-time-token",
      },
    };
  }
  if (route.endsWith("/access_tokens/7")) {
    if (options.method === "DELETE") return { data: undefined };
    return { data: accessTokenMetadata() };
  }
  if (route.endsWith("/access_tokens")) {
    return { data: [], pagination: {} };
  }
  if (/\/merge_requests\/\d+\/diffs$/.test(route)) {
    return {
      data: [
        {
          old_path: "src/app.js",
          new_path: "src/app.js",
          diff: "@@ -1 +1 @@",
        },
      ],
      pagination: {},
    };
  }
  if (/\/milestones\/7$/.test(route)) {
    return {
      data: {
        id: 7,
        title: "contract",
      },
    };
  }
  if (route.endsWith("/environments/7/stop")) {
    return {
      data: {
        id: 7,
        name: "contract",
        state: "stopped",
      },
    };
  }
  if (route.endsWith("/environments/7")) {
    return {
      data: {
        id: 7,
        name: "contract",
        state:
          activeToolName === "delete_environment" ? "stopped" : "available",
      },
    };
  }
  if (
    (activeToolName === "apply_repository_hunks" ||
      activeToolName === "commit_job_artifact_file") &&
    /\/repository\/commits\/7$/.test(route) &&
    !options.method
  ) {
    return {
      data: {
        id: 7,
        parent_ids: ["a".repeat(40)],
      },
    };
  }
  if (
    (activeToolName === "revert_commit" ||
      activeToolName === "cherry_pick_commit") &&
    route ===
      `/projects/group%2Fproject/repository/commits/${"c".repeat(40)}` &&
    !options.method
  ) {
    return {
      data: {
        id: "c".repeat(40),
        short_id: "cccccccc",
        title: "Contract cherry-pick",
        message: "Contract cherry-pick",
        parent_ids: ["a".repeat(40)],
      },
    };
  }
  if (
    activeToolName === "cherry_pick_commit" &&
    route ===
      `/projects/group%2Fproject/repository/commits/${"b".repeat(40)}` &&
    !options.method
  ) {
    return {
      data: {
        id: "b".repeat(40),
        parent_ids: ["d".repeat(40)],
      },
    };
  }
  if (
    activeToolName === "cherry_pick_commit" &&
    route ===
      `/projects/group%2Fproject/repository/commits/${"c".repeat(40)}/diff`
  ) {
    return {
      data: [
        {
          old_path: "src/app.js",
          new_path: "src/app.js",
          diff: "@@ -1 +1 @@\\n-old\\n+new",
        },
      ],
      pagination: {},
    };
  }
  if (
    activeToolName === "cherry_pick_commit" &&
    route ===
      "/projects/group%2Fproject/repository/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/cherry_pick" &&
    options.method === "POST"
  ) {
    if (options.body?.dry_run === true) {
      return { data: { dry_run: "success" } };
    }
    return { data: { id: "c".repeat(40) } };
  }
  if (
    activeToolName === "revert_commit" &&
    route ===
      `/projects/group%2Fproject/repository/commits/${"c".repeat(40)}` &&
    !options.method
  ) {
    return {
      data: {
        id: "c".repeat(40),
        parent_ids: ["a".repeat(40)],
      },
    };
  }
  if (
    activeToolName === "revert_commit" &&
    route ===
      "/projects/group%2Fproject/repository/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/revert" &&
    options.method === "POST"
  ) {
    if (options.body?.dry_run === true) {
      return { data: { dry_run: "success" } };
    }
    return {
      data: {
        id: "c".repeat(40),
      },
    };
  }
  if (
    options.responseType === "text" ||
    route.includes("/repository/files/") ||
    route.includes("/repository/blobs/")
  ) {
    if (options.responseType === "text") {
      return { data: "one\ntwo\nthree\n" };
    }
    return {
      data: {
        encoding: "base64",
        content: Buffer.from("one\ntwo\nthree\n").toString("base64"),
        blob_id: "4cb29ea38f70d7c61b2a3a25b02e3bdf44905402",
        last_commit_id: "last-commit-id",
      },
    };
  }
  if (options.responseType === "binary") {
    return {
      data: {
        encoding: "base64",
        contentType: "application/octet-stream",
        contentLength: 8,
        content: Buffer.from("contract").toString("base64"),
      },
    };
  }
  if (/\/hooks\/\d+\/events$/.test(route)) {
    return {
      data: [
        {
          id: options.query?.per_page ? 1 : 7,
          trigger: "push_hooks",
          url: "https://example.com/hook",
          response_status: "200",
          request_headers: { "content-type": "application/json" },
          response_body: "OK",
          execution_duration: 1.5,
        },
      ],
      pagination: {},
    };
  }
  if (
    route.includes("/variables/") &&
    options.query?.["filter[environment_scope]"]
  ) {
    return {
      data: {
        key: "CONTRACT_KEY",
        variable_type: "env_var",
        protected: true,
        masked: true,
        hidden: true,
        raw: true,
        environment_scope: options.query["filter[environment_scope]"],
        description: "Contract description",
      },
    };
  }
  if (activeToolName === "list_deployments" && route.endsWith("/deployments")) {
    return {
      data: [],
      pagination: { page: 1, perPage: 100, totalPages: 1 },
    };
  }
  return {
    data: {
      id: 7,
      iid: 7,
      name: "contract",
      username: "contract-user",
    },
    pagination: {},
  };
}

test("invokes every registered tool against its explicit route and safety contract", async (t) => {
  const calls = [];
  let activeToolName;
  let suggestionMutationCompleted = false;
  let hunkMutationCompleted = false;
  let artifactMutationCompleted = false;
  let revertMutationCompleted = false;
  let cherryPickMutationCompleted = false;
  let branchDeletionCompleted = false;
  let tagDeletionCompleted = false;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      baseUrl: "https://gitlab.example.com",
      token: "contract-token",
      request: async (path, options) => {
        calls.push(normalizedCall(path, options));
        const response = responseFor(
          path,
          options,
          activeToolName,
          suggestionMutationCompleted,
          hunkMutationCompleted,
          artifactMutationCompleted,
          revertMutationCompleted,
          cherryPickMutationCompleted,
          branchDeletionCompleted,
          tagDeletionCompleted,
        );
        if (
          String(path) === "/suggestions/1/apply" ||
          String(path) === "/suggestions/batch_apply"
        ) {
          suggestionMutationCompleted = true;
        }
        if (
          activeToolName === "apply_repository_hunks" &&
          String(path) === "/projects/group%2Fproject/repository/commits" &&
          options?.method === "POST"
        ) {
          hunkMutationCompleted = true;
        }
        if (
          activeToolName === "commit_job_artifact_file" &&
          String(path) === "/projects/group%2Fproject/repository/commits" &&
          options?.method === "POST"
        ) {
          artifactMutationCompleted = true;
        }
        if (
          activeToolName === "cherry_pick_commit" &&
          String(path) ===
            "/projects/group%2Fproject/repository/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/cherry_pick" &&
          options?.method === "POST" &&
          options.body?.dry_run !== true
        ) {
          cherryPickMutationCompleted = true;
        }
        if (
          activeToolName === "revert_commit" &&
          String(path) ===
            "/projects/group%2Fproject/repository/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/revert" &&
          options?.method === "POST" &&
          options.body?.dry_run !== true
        ) {
          revertMutationCompleted = true;
        }
        if (
          activeToolName === "delete_branch" &&
          String(path).includes("/repository/branches/") &&
          options?.method === "DELETE"
        ) {
          branchDeletionCompleted = true;
        }
        if (
          activeToolName === "delete_tag" &&
          String(path).includes("/repository/tags/") &&
          options?.method === "DELETE"
        ) {
          tagDeletionCompleted = true;
        }
        return response;
      },
    }),
  });
  const client = new Client({ name: "inventory-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const actual = {};
  for (const tool of listed.tools) {
    for (const annotation of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ]) {
      assert.equal(
        typeof tool.annotations[annotation],
        "boolean",
        `${tool.name} must explicitly classify ${annotation}`,
      );
    }
    const properties = tool.inputSchema.properties || {};
    if (properties.page) {
      assert.equal(properties.page.minimum, 1, `${tool.name}.page minimum`);
    }
    if (properties.per_page) {
      assert.equal(
        properties.per_page.minimum,
        1,
        `${tool.name}.per_page minimum`,
      );
      assert.equal(
        properties.per_page.maximum,
        100,
        `${tool.name}.per_page maximum`,
      );
    }
    calls.length = 0;
    activeToolName = tool.name;
    suggestionMutationCompleted = false;
    hunkMutationCompleted = false;
    artifactMutationCompleted = false;
    branchDeletionCompleted = false;
    tagDeletionCompleted = false;
    const result = await client.callTool({
      name: tool.name,
      arguments: argumentsFor(tool),
    });
    assert.equal(
      result.isError,
      undefined,
      `${tool.name} did not complete its contract invocation: ${result.content?.[0]?.text}`,
    );
    actual[tool.name] = [
      safetyFor(tool),
      ...calls.map((call) => callSignature(call)),
    ];
  }

  if (process.env.PRINT_TOOL_CONTRACTS === "true") {
    console.log(JSON.stringify(actual, null, 2));
    return;
  }
  assert.deepEqual(actual, contracts);
});
