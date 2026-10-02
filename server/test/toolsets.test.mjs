import assert from "node:assert/strict";
import test from "node:test";

import { registerGitLabTools } from "../src/tools.mjs";
import {
  GITLAB_TOOLSETS,
  resolveToolsetSelection,
} from "../src/tools/toolsets.mjs";

function captureRegistration(options = {}) {
  const registered = [];
  let assignments;
  let selection;
  registerGitLabTools(
    {
      registerTool(name, config) {
        registered.push({ name, config });
      },
    },
    {
      clientFactory: () => {
        throw new Error("Toolset registration tests must not call GitLab.");
      },
      ...options,
      registeredToolsetObserver(value, resolvedSelection) {
        assignments = value;
        selection = resolvedSelection;
      },
    },
  );
  return { assignments, registered, selection };
}

function namesOf(registration) {
  return registration.registered.map(({ name }) => name).sort();
}

test("default and all preserve the complete canonical tool surface", () => {
  const defaultRegistration = captureRegistration({ toolsets: "default" });
  const allRegistration = captureRegistration({ toolsets: "all" });

  assert.equal(defaultRegistration.selection.mode, "all");
  assert.deepEqual(defaultRegistration.selection.toolsets, GITLAB_TOOLSETS);
  assert.equal(defaultRegistration.registered.length, 175);
  assert.deepEqual(namesOf(defaultRegistration), namesOf(allRegistration));
});

test("context is intentionally small and sufficient for identity and project context", () => {
  const registration = captureRegistration({ toolsets: "context" });

  assert.deepEqual(namesOf(registration), [
    "get_current_user",
    "get_gitlab_capabilities",
    "get_project",
    "get_runtime_info",
    "search_projects",
  ]);
});

test("explicit toolsets expose the deterministic bounded union", () => {
  const registration = captureRegistration({
    toolsets: "repository, context,repository",
  });
  const names = namesOf(registration);

  assert.equal(registration.selection.mode, "explicit");
  assert.deepEqual(registration.selection.toolsets, ["context", "repository"]);
  assert.ok(names.includes("get_project"));
  assert.ok(names.includes("get_file"));
  assert.ok(names.includes("create_commit"));
  assert.equal(names.includes("list_issues"), false);
  assert.equal(names.includes("search_gitlab"), false);
});

test("read-only filtering always wins over selected toolsets", () => {
  const registration = captureRegistration({
    toolsets: "issues",
    readOnly: true,
  });
  const names = namesOf(registration);

  assert.ok(names.includes("list_issues"));
  assert.equal(names.includes("create_issue"), false);
  assert.ok(
    registration.registered.every(
      ({ config }) => config.annotations.readOnlyHint === true,
    ),
  );
});

test("every canonical tool has exactly one explicit primary toolset", () => {
  const { assignments } = captureRegistration({ toolsets: "all" });
  const entries = Object.entries(assignments);

  assert.equal(entries.length, 175);
  for (const [, toolset] of entries) {
    assert.ok(GITLAB_TOOLSETS.includes(toolset));
  }
  assert.equal(assignments.get_runtime_info, "context");
  assert.equal(assignments.get_current_user, "context");
  assert.equal(assignments.search_gitlab, "platform");
  assert.equal(assignments.get_file, "repository");
  assert.equal(assignments.cherry_pick_commit, "repository");
  assert.equal(assignments.list_issues, "issues");
  assert.equal(assignments.list_merge_requests, "merge_requests");
  assert.equal(assignments.list_pipelines, "ci");
  assert.equal(assignments.create_project_milestone, "platform");
  assert.equal(assignments.delete_group_milestone, "platform");
  assert.equal(assignments.list_protected_branches, "governance");
  assert.equal(assignments.get_project_access_token_capabilities, "governance");
  assert.equal(assignments.list_project_access_tokens, "governance");
  assert.equal(assignments.get_project_access_token, "governance");
  assert.equal(assignments.create_project_access_token, "governance");
  assert.equal(assignments.rotate_project_access_token, "governance");
  assert.equal(assignments.revoke_project_access_token, "governance");
  assert.equal(
    assignments.replace_project_access_token_ci_credential,
    "governance",
  );
  assert.equal(assignments.list_releases, "releases");
  assert.equal(assignments.list_environments, "deployments");
  assert.equal(assignments.stop_environment, "deployments");
  assert.equal(assignments.delete_environment, "deployments");
  assert.equal(assignments.list_project_ci_variables, "variables");
  assert.equal(assignments.list_project_webhooks, "webhooks");
});

test("invalid and ambiguous toolset configuration fails clearly", () => {
  assert.throws(
    () => resolveToolsetSelection("context,unknown"),
    /Unknown GitLab MCP toolset: unknown/,
  );
  assert.throws(
    () => resolveToolsetSelection("all,context"),
    /cannot be combined with explicit toolsets/,
  );
  assert.throws(
    () => resolveToolsetSelection("context,,ci"),
    /contains an empty name/,
  );
  assert.throws(
    () => resolveToolsetSelection([]),
    /selection must not be empty/,
  );
  assert.throws(
    () => resolveToolsetSelection(["context", 42]),
    /entries must be strings/,
  );
});
