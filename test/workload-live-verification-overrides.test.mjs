import assert from "node:assert/strict";
import test from "node:test";

import { applyVerificationWorkloadOverrides } from "../scripts/lib/workload-live-verification-overrides.mjs";
import { isBenchmarkOwnedIssue } from "../scripts/lib/workload-live-reset.mjs";

const OVERRIDDEN_IDS = [
  "context.resolve-project",
  "context.capabilities",
  "context.identity",
  "repository.inspect-tree-file",
  "issues.create",
  "mr.merge-readiness",
  "ci.retry-failed",
];

function baseSession() {
  return {
    project: 42,
    projectPath: "group/disposable",
    defaultBranch: "main",
    runId: "bench-verify",
    measured(_observe, operation) {
      return operation();
    },
  };
}

test("verification overrides replace every targeted weak handler", () => {
  const oldHandlers = Object.fromEntries(
    OVERRIDDEN_IDS.map((id) => [id, { marker: `old:${id}` }]),
  );
  oldHandlers["safety.timeout"] = { marker: "keep" };

  const handlers = applyVerificationWorkloadOverrides(
    baseSession(),
    oldHandlers,
  );

  for (const id of OVERRIDDEN_IDS) {
    assert.notEqual(handlers[id].marker, `old:${id}`);
    assert.equal(typeof handlers[id].execute, "function");
    assert.equal(typeof handlers[id].verifyFinalState, "function");
  }
  assert.equal(handlers["safety.timeout"].marker, "keep");
});

test("project resolution needs only the authoritative disposable project to be visible", async () => {
  const session = {
    ...baseSession(),
    async call(name) {
      if (name === "search_projects") {
        return {
          data: [
            {
              id: 42,
              path_with_namespace: "group/disposable",
              default_branch: "main",
            },
          ],
        };
      }
      if (name === "get_project") {
        return {
          id: 42,
          path_with_namespace: "group/disposable",
          default_branch: "main",
        };
      }
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handler = applyVerificationWorkloadOverrides(session, {
    "context.resolve-project": { marker: "old" },
  })["context.resolve-project"];

  await handler.execute({ observe: () => {} });
  assert.equal((await handler.verifyFinalState()).verified, true);
});

test("repository inspection rejects a tree that omits README.md", async () => {
  let fetched = false;
  const session = {
    ...baseSession(),
    async call(name) {
      if (name === "list_repository_tree") return { data: [] };
      if (name === "get_file") {
        fetched = true;
        return { content: "unexpected" };
      }
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handler = applyVerificationWorkloadOverrides(session, {
    "repository.inspect-tree-file": { marker: "old" },
  })["repository.inspect-tree-file"];

  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /did not include README\.md/,
  );
  assert.equal(fetched, false);
});

test("issue creation uses crash-recoverable ownership markers and requires the unique title", async () => {
  let createdIssue;
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      if (name === "create_issue") {
        createdIssue = {
          iid: 17,
          title: args.title,
          description: args.description,
        };
        return createdIssue;
      }
      if (name === "get_issue") {
        return { iid: 17, state: "opened", title: "wrong title" };
      }
      if (name === "update_issue") return { iid: 17, state: "closed" };
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handler = applyVerificationWorkloadOverrides(session, {
    "issues.create": { marker: "old" },
  })["issues.create"];

  await handler.execute({ observe: () => {}, iteration: 3 });
  assert.equal(isBenchmarkOwnedIssue(createdIssue), true);
  assert.equal((await handler.verifyFinalState()).verified, false);
  await handler.cleanup();
});

test("pipeline retry requires a new job on the exact original pipeline", async () => {
  let listJobCalls = 0;
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      if (name === "create_branch") return { name: args.branch };
      if (name === "create_commit") return { id: "retry-sha" };
      if (name === "list_pipelines") {
        return { id: 61, sha: "retry-sha", status: "failed" };
      }
      if (name === "get_pipeline") return { id: 61, status: "failed" };
      if (name === "list_pipeline_jobs") {
        listJobCalls += 1;
        return listJobCalls === 1
          ? { data: [{ id: 101, status: "failed" }] }
          : {
              data: [
                { id: 101, status: "failed" },
                { id: 102, status: "pending" },
              ],
            };
      }
      if (name === "retry_pipeline") return { id: 61, status: "pending" };
      if (name === "list_branches") {
        return { data: [{ name: args.search, commit: { id: "retry-sha" } }] };
      }
      if (name === "delete_branch") return {};
      assert.fail(`Unexpected tool call: ${name} ${JSON.stringify(args)}`);
    },
  };
  const handler = applyVerificationWorkloadOverrides(session, {
    "ci.retry-failed": { marker: "old" },
  })["ci.retry-failed"];

  await handler.setup({ iteration: 1 });
  await handler.execute({ observe: () => {} });
  assert.equal((await handler.verifyFinalState()).verified, true);
  await handler.cleanup();
});

test("capability workflow rejects an unverified capability envelope", async () => {
  const session = {
    ...baseSession(),
    async call(name) {
      assert.equal(name, "get_gitlab_capabilities");
      return { schemaVersion: 1, capabilities: {}, probes: {} };
    },
  };
  const handler = applyVerificationWorkloadOverrides(session, {
    "context.capabilities": { marker: "old" },
  })["context.capabilities"];

  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /undefined/,
  );
});
