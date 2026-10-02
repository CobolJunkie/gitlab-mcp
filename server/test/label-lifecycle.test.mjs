import assert from "node:assert/strict";
import test from "node:test";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { registerPlatformTools } from "../src/tools/platform-tools.mjs";

const PROJECT = "group/project";
const GROUP = "parent/team";

function registeredTools() {
  const tools = new Map();
  registerPlatformTools((name, config, handler) => {
    tools.set(name, { config, handler });
  });
  return tools;
}

function apiError(status, method, path) {
  return new GitLabApiError(`GitLab API returned ${status}.`, {
    status,
    method,
    path,
  });
}

test("label lifecycle tools expose expected safety annotations", () => {
  const tools = registeredTools();

  for (const name of [
    "list_project_labels",
    "get_project_label",
    "list_group_labels",
    "get_group_label",
  ]) {
    assert.equal(tools.get(name).config.annotations.readOnlyHint, true);
  }
  for (const name of [
    "create_project_label",
    "update_project_label",
    "create_group_label",
    "update_group_label",
  ]) {
    assert.equal(tools.get(name).config.annotations.readOnlyHint, false);
    assert.equal(tools.get(name).config.annotations.destructiveHint, false);
  }
  for (const name of ["delete_project_label", "delete_group_label"]) {
    assert.equal(tools.get(name).config.annotations.destructiveHint, true);
    assert.ok(
      tools.get(name).config.inputSchema.acknowledge_label_deletion,
      `${name} must require destructive acknowledgement`,
    );
  }
});

test("project label lifecycle preserves scoped names and project metadata", async () => {
  const tools = registeredTools();
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return {
        data: {
          id: 7,
          name: options.body?.new_name ?? options.body?.name ?? "priority::P1",
          color: options.body?.color ?? "#6699cc",
          description: options.body?.description ?? "High priority",
          priority: options.body?.priority ?? 0,
          archived: options.body?.archived ?? false,
        },
        pagination: {},
      };
    },
  };

  await tools.get("list_project_labels").handler(client, {
    project: PROJECT,
    search: "priority::",
    include_ancestor_groups: false,
    page: 1,
    per_page: 100,
  });
  await tools.get("get_project_label").handler(client, {
    project: PROJECT,
    label_id: "priority::P1",
    include_ancestor_groups: false,
  });
  const created = await tools.get("create_project_label").handler(client, {
    project: PROJECT,
    name: "priority::P1",
    color: "#6699cc",
    description: "High priority",
    priority: 0,
    archived: false,
  });
  const updated = await tools.get("update_project_label").handler(client, {
    project: PROJECT,
    label_id: 7,
    new_name: "priority::P0",
    description: "",
    priority: null,
    archived: true,
  });

  assert.equal(created.name, "priority::P1");
  assert.equal(updated.name, "priority::P0");
  assert.deepEqual(calls[0], {
    path: "/projects/group%2Fproject/labels",
    options: {
      query: {
        search: "priority::",
        include_ancestor_groups: false,
        page: 1,
        per_page: 100,
      },
    },
  });
  assert.equal(
    calls[1].path,
    "/projects/group%2Fproject/labels/priority%3A%3AP1",
  );
  assert.deepEqual(calls[3].options.body, {
    new_name: "priority::P0",
    description: "",
    priority: null,
    archived: true,
  });
});

test("group label lifecycle preserves scoped names without project-only priority", async () => {
  const tools = registeredTools();
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return {
        data: {
          id: 7,
          name: options.body?.new_name ?? options.body?.name ?? "status::ready",
          archived: options.body?.archived ?? false,
        },
        pagination: {},
      };
    },
  };

  await tools.get("list_group_labels").handler(client, {
    group: GROUP,
    search: "status::",
    include_descendant_groups: true,
    only_group_labels: true,
    archived: false,
    page: 1,
    per_page: 100,
  });
  await tools.get("get_group_label").handler(client, {
    group: GROUP,
    label_id: "status::ready",
    include_descendant_groups: true,
    only_group_labels: true,
  });
  const created = await tools.get("create_group_label").handler(client, {
    group: GROUP,
    name: "status::ready",
    color: "#6699cc",
    description: "Ready",
    archived: false,
  });
  const updated = await tools.get("update_group_label").handler(client, {
    group: GROUP,
    label_id: 7,
    new_name: "status::in-review",
    archived: true,
  });

  assert.equal(created.name, "status::ready");
  assert.equal(updated.name, "status::in-review");
  assert.equal(calls[1].path, "/groups/parent%2Fteam/labels/status%3A%3Aready");
  assert.deepEqual(calls[3].options.body, {
    new_name: "status::in-review",
    archived: true,
  });
});

test("label deletion preflights exact numeric ID and name before mutation", async () => {
  const tools = registeredTools();

  for (const [toolName, scopeKey, scopeValue, basePath] of [
    [
      "delete_project_label",
      "project",
      PROJECT,
      "/projects/group%2Fproject/labels/7",
    ],
    ["delete_group_label", "group", GROUP, "/groups/parent%2Fteam/labels/7"],
  ]) {
    const calls = [];
    const client = {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        return { data: { id: 7, name: "status::done" } };
      },
    };
    const result = await tools.get(toolName).handler(client, {
      [scopeKey]: scopeValue,
      label_id: 7,
      expected_label_name: "status::done",
      acknowledge_label_deletion: true,
    });

    assert.deepEqual(
      calls.map(({ path, options }) => [path, options.method ?? "GET"]),
      [
        [basePath, "GET"],
        [basePath, "DELETE"],
      ],
    );
    assert.equal(result.label_name, "status::done");
    assert.equal(result.outcome, "deleted");
  }
});

test("label deletion fails closed for stale or mismatched targets", async () => {
  const tools = registeredTools();
  const deleteProject = tools.get("delete_project_label").handler;

  const staleCalls = [];
  await assert.rejects(
    deleteProject(
      {
        request: async (path, options = {}) => {
          staleCalls.push({ path, options });
          throw apiError(404, "GET", path);
        },
      },
      {
        project: PROJECT,
        label_id: 7,
        expected_label_name: "status::done",
        acknowledge_label_deletion: true,
      },
    ),
    (error) => error instanceof GitLabApiError && error.status === 404,
  );
  assert.equal(staleCalls.length, 1);

  const mismatchCalls = [];
  await assert.rejects(
    deleteProject(
      {
        request: async (path, options = {}) => {
          mismatchCalls.push({ path, options });
          return { data: { id: 7, name: "status::ready" } };
        },
      },
      {
        project: PROJECT,
        label_id: 7,
        expected_label_name: "status::done",
        acknowledge_label_deletion: true,
      },
    ),
    /expected name.*status::done.*status::ready/u,
  );
  assert.equal(mismatchCalls.length, 1);
});

test("label mutations preserve GitLab duplicate, permission, and unsupported-field errors", async () => {
  const tools = registeredTools();
  const cases = [
    [
      "create_project_label",
      400,
      { project: PROJECT, name: "type::bug", color: "#6699cc" },
    ],
    [
      "update_project_label",
      403,
      { project: PROJECT, label_id: 7, color: "#6699cc" },
    ],
    [
      "create_group_label",
      403,
      { group: GROUP, name: "type::bug", color: "#6699cc" },
    ],
    ["update_group_label", 400, { group: GROUP, label_id: 7, archived: true }],
  ];

  for (const [toolName, status, args] of cases) {
    const expected = apiError(status, "POST", "/labels");
    await assert.rejects(
      tools.get(toolName).handler(
        {
          request: async () => {
            throw expected;
          },
        },
        args,
      ),
      (error) => error === expected,
    );
  }
});

test("label updates reject empty mutation bodies before dispatch", async () => {
  const tools = registeredTools();
  for (const [toolName, args] of [
    ["update_project_label", { project: PROJECT, label_id: 7 }],
    ["update_group_label", { group: GROUP, label_id: 7 }],
  ]) {
    let calls = 0;
    await assert.rejects(
      tools.get(toolName).handler(
        {
          request: async () => {
            calls += 1;
            return { data: {} };
          },
        },
        args,
      ),
      /requires at least one mutable field/u,
    );
    assert.equal(calls, 0);
  }
});
