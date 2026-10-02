import assert from "node:assert/strict";
import test from "node:test";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { registerPlatformTools } from "../src/tools/platform-tools.mjs";
import { sanitizeMcpResponse } from "../src/tools/responses.mjs";

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

test("milestone lifecycle tools expose expected safety annotations", () => {
  const tools = registeredTools();
  for (const name of [
    "create_project_milestone",
    "update_project_milestone",
    "create_group_milestone",
    "update_group_milestone",
  ]) {
    assert.equal(tools.get(name).config.annotations.readOnlyHint, false);
    assert.equal(tools.get(name).config.annotations.destructiveHint, false);
  }
  for (const name of ["delete_project_milestone", "delete_group_milestone"]) {
    assert.equal(tools.get(name).config.annotations.destructiveHint, true);
    assert.ok(
      tools.get(name).config.inputSchema.acknowledge_milestone_deletion,
      `${name} must require destructive acknowledgement`,
    );
  }
});

test("project milestone lifecycle forwards bounded metadata and state transitions", async () => {
  const tools = registeredTools();
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return {
        data: {
          id: 7,
          title: options.body?.title ?? "Release train",
          description: options.body?.description ?? "Dogfooding",
          start_date: options.body?.start_date ?? "2026-09-26",
          due_date: options.body?.due_date ?? "2026-10-03",
          state: options.body?.state_event === "close" ? "closed" : "active",
        },
      };
    },
  };

  const created = await tools.get("create_project_milestone").handler(client, {
    project: PROJECT,
    title: "Release train",
    description: "Dogfooding",
    start_date: "2026-09-26",
    due_date: "2026-10-03",
  });
  const updated = await tools.get("update_project_milestone").handler(client, {
    project: PROJECT,
    milestone_id: 7,
    description: "",
    due_date: "2026-10-10",
    state_event: "close",
  });

  assert.equal(created.title, "Release train");
  assert.equal(updated.state, "closed");
  assert.deepEqual(calls[0], {
    path: "/projects/group%2Fproject/milestones",
    options: {
      method: "POST",
      body: {
        title: "Release train",
        description: "Dogfooding",
        start_date: "2026-09-26",
        due_date: "2026-10-03",
      },
    },
  });
  assert.deepEqual(calls[1], {
    path: "/projects/group%2Fproject/milestones/7",
    options: {
      method: "PUT",
      body: {
        description: "",
        due_date: "2026-10-10",
        state_event: "close",
      },
    },
  });
});

test("group milestone lifecycle uses the group scope and activate transition", async () => {
  const tools = registeredTools();
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return {
        data: {
          id: 9,
          title: options.body?.title ?? "Group train",
          state: options.body?.state_event === "activate" ? "active" : "closed",
        },
      };
    },
  };

  await tools.get("create_group_milestone").handler(client, {
    group: GROUP,
    title: "Group train",
  });
  const updated = await tools.get("update_group_milestone").handler(client, {
    group: GROUP,
    milestone_id: 9,
    state_event: "activate",
  });

  assert.equal(updated.state, "active");
  assert.equal(calls[0].path, "/groups/parent%2Fteam/milestones");
  assert.deepEqual(calls[1], {
    path: "/groups/parent%2Fteam/milestones/9",
    options: { method: "PUT", body: { state_event: "activate" } },
  });
});

test("milestone deletion preflights exact numeric ID and title before mutation", async () => {
  const tools = registeredTools();
  for (const [toolName, scopeKey, scopeValue, basePath] of [
    [
      "delete_project_milestone",
      "project",
      PROJECT,
      "/projects/group%2Fproject/milestones/7",
    ],
    [
      "delete_group_milestone",
      "group",
      GROUP,
      "/groups/parent%2Fteam/milestones/7",
    ],
  ]) {
    const calls = [];
    const client = {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        return { data: { id: 7, title: "Release train" } };
      },
    };
    const result = await tools.get(toolName).handler(client, {
      [scopeKey]: scopeValue,
      milestone_id: 7,
      expected_milestone_title: "Release train",
      acknowledge_milestone_deletion: true,
    });
    assert.deepEqual(
      calls.map(({ path, options }) => [path, options.method ?? "GET"]),
      [
        [basePath, "GET"],
        [basePath, "DELETE"],
      ],
    );
    assert.equal(result.milestone_title, "Release train");
    assert.equal(result.outcome, "deleted");
  }
});

test("milestone deletion fails closed for stale, wrong-ID, or mismatched targets", async () => {
  const tools = registeredTools();
  const deleteProject = tools.get("delete_project_milestone").handler;

  let calls = 0;
  await assert.rejects(
    deleteProject(
      {
        request: async (path) => {
          calls += 1;
          throw apiError(404, "GET", path);
        },
      },
      {
        project: PROJECT,
        milestone_id: 7,
        expected_milestone_title: "Release train",
        acknowledge_milestone_deletion: true,
      },
    ),
    (error) => error instanceof GitLabApiError && error.status === 404,
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    deleteProject(
      {
        request: async () => {
          calls += 1;
          return { data: { id: 8, title: "Release train" } };
        },
      },
      {
        project: PROJECT,
        milestone_id: 7,
        expected_milestone_title: "Release train",
        acknowledge_milestone_deletion: true,
      },
    ),
    /unexpected milestone ID/u,
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    deleteProject(
      {
        request: async () => {
          calls += 1;
          return { data: { id: 7, title: "Other train" } };
        },
      },
      {
        project: PROJECT,
        milestone_id: 7,
        expected_milestone_title: "Release train",
        acknowledge_milestone_deletion: true,
      },
    ),
    /expected title.*Release train.*Other train/u,
  );
  assert.equal(calls, 1);
});

test("group milestone deletion fails closed when the target is outside the requested scope", async () => {
  const tools = registeredTools();
  const calls = [];

  await assert.rejects(
    tools.get("delete_group_milestone").handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          throw apiError(404, "GET", path);
        },
      },
      {
        group: GROUP,
        milestone_id: 7,
        expected_milestone_title: "Release train",
        acknowledge_milestone_deletion: true,
      },
    ),
    (error) => error instanceof GitLabApiError && error.status === 404,
  );

  assert.deepEqual(
    calls.map(({ path, options }) => [path, options.method ?? "GET"]),
    [["/groups/parent%2Fteam/milestones/7", "GET"]],
  );
});

test("repeated milestone deletion stops at the second preflight without another DELETE", async () => {
  const tools = registeredTools();
  const deleteProject = tools.get("delete_project_milestone").handler;
  const calls = [];
  let deleted = false;
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (options.method === "DELETE") {
        deleted = true;
        return { data: undefined };
      }
      if (deleted) {
        throw apiError(404, "GET", path);
      }
      return { data: { id: 7, title: "Release train" } };
    },
  };
  const args = {
    project: PROJECT,
    milestone_id: 7,
    expected_milestone_title: "Release train",
    acknowledge_milestone_deletion: true,
  };

  await deleteProject(client, args);
  await assert.rejects(
    deleteProject(client, args),
    (error) => error instanceof GitLabApiError && error.status === 404,
  );

  assert.deepEqual(
    calls.map(({ options }) => options.method ?? "GET"),
    ["GET", "DELETE", "GET"],
  );
});

test("unsupported group milestone endpoints preserve GitLab capability evidence", async () => {
  const tools = registeredTools();
  const expected = apiError(404, "POST", "/groups/parent%2Fteam/milestones");

  await assert.rejects(
    tools.get("create_group_milestone").handler(
      {
        request: async () => {
          throw expected;
        },
      },
      {
        group: GROUP,
        title: "Release train",
      },
    ),
    (error) => error === expected,
  );
});

test("milestone-shaped responses use the shared MCP sanitizer boundary", () => {
  const sanitized = sanitizeMcpResponse({
    id: 7,
    title: "Release train",
    description: "Dogfooding",
    token: "secret-token",
    private_token: "private-secret",
    nested: {
      access_token: "nested-secret",
      state: "active",
    },
  });

  assert.deepEqual(sanitized, {
    id: 7,
    title: "Release train",
    description: "Dogfooding",
    nested: {
      state: "active",
    },
  });
});

test("milestone mutations preserve GitLab permission and unsupported-field errors", async () => {
  const tools = registeredTools();
  const cases = [
    [
      "create_project_milestone",
      403,
      { project: PROJECT, title: "Release train" },
    ],
    [
      "update_project_milestone",
      400,
      { project: PROJECT, milestone_id: 7, state_event: "close" },
    ],
    ["create_group_milestone", 403, { group: GROUP, title: "Release train" }],
    [
      "update_group_milestone",
      400,
      { group: GROUP, milestone_id: 7, description: "Updated" },
    ],
  ];
  for (const [toolName, status, args] of cases) {
    const expected = apiError(status, "POST", "/milestones");
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

test("milestone updates reject empty mutation bodies before dispatch", async () => {
  const tools = registeredTools();
  for (const [toolName, args] of [
    ["update_project_milestone", { project: PROJECT, milestone_id: 7 }],
    ["update_group_milestone", { group: GROUP, milestone_id: 7 }],
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

test("milestone date schemas reject impossible calendar dates", () => {
  const tools = registeredTools();
  for (const name of ["create_project_milestone", "create_group_milestone"]) {
    const schema = tools.get(name).config.inputSchema.start_date;
    assert.equal(schema.safeParse("2026-02-28").success, true);
    assert.equal(schema.safeParse("2026-02-30").success, false);
    assert.equal(schema.safeParse("26-02-28").success, false);
  }
});
