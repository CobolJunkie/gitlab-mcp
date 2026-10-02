import assert from "node:assert/strict";
import test from "node:test";

import {
  isBenchmarkOwnedBranch,
  isBenchmarkOwnedEnvironment,
  isBenchmarkOwnedIssue,
  isBenchmarkOwnedMergeRequest,
  isBenchmarkOwnedRelease,
  isBenchmarkOwnedSchedule,
  isBenchmarkOwnedTag,
  isBenchmarkOwnedVariable,
  resetStaleBenchmarkFixtures,
} from "../scripts/lib/workload-live-reset.mjs";

const ownedBranch = "mcp-bench/bench-run-scenario";

function listed(data) {
  return {
    data,
    pagination: { page: 1, totalPages: 1, nextPage: null },
  };
}

test("benchmark ownership markers reject nearby user resources", () => {
  assert.equal(isBenchmarkOwnedBranch(ownedBranch), true);
  assert.equal(isBenchmarkOwnedBranch("feature/bench-run-scenario"), false);

  assert.equal(
    isBenchmarkOwnedIssue({
      title: "BENCH fixture bench-run-issue",
      description: "Disposable GitLab MCP benchmark issue fixture.",
    }),
    true,
  );
  assert.equal(
    isBenchmarkOwnedIssue({
      title: "BENCH fixture bench-run-issue",
      description: "user-owned issue",
    }),
    false,
  );

  assert.equal(
    isBenchmarkOwnedMergeRequest({
      title: "Draft: BENCH fixture bench-run-mr",
      description: "Disposable GitLab MCP benchmark fixture.",
      source_branch: `${ownedBranch}-source`,
      target_branch: `${ownedBranch}-base`,
    }),
    true,
  );
  assert.equal(
    isBenchmarkOwnedMergeRequest({
      title: "Draft: BENCH fixture bench-run-mr",
      description: "Disposable GitLab MCP benchmark fixture.",
      source_branch: "feature/user-source",
      target_branch: `${ownedBranch}-base`,
    }),
    false,
  );

  assert.equal(
    isBenchmarkOwnedRelease({
      tag_name: "bench-bench-run-release",
      name: "BENCH bench-bench-run-release",
    }),
    true,
  );
  assert.equal(isBenchmarkOwnedTag({ name: "bench-bench-run-release" }), true);
  assert.equal(isBenchmarkOwnedTag({ name: "bench-user-release" }), false);

  assert.equal(
    isBenchmarkOwnedSchedule(
      {
        description: "BENCH bench-run-schedule",
        ref: "main",
        active: false,
      },
      "main",
    ),
    true,
  );
  assert.equal(
    isBenchmarkOwnedSchedule(
      {
        description: "BENCH bench-run-schedule",
        ref: "main",
        active: true,
      },
      "main",
    ),
    false,
  );

  assert.equal(
    isBenchmarkOwnedVariable({
      key: "BENCHMARK_METADATA_BENCH_RUN_VARIABLE",
      environment_scope: "*",
    }),
    true,
  );
  assert.equal(
    isBenchmarkOwnedVariable({
      key: "BENCHMARK_METADATA_USER_VARIABLE",
      environment_scope: "*",
    }),
    false,
  );

  assert.equal(
    isBenchmarkOwnedEnvironment({ name: "benchmark / bench-run-deployment" }),
    true,
  );
  assert.equal(isBenchmarkOwnedEnvironment({ name: "production" }), false);
});

test("pre-run reset requiesces stale pipelines immediately before branch deletion", async () => {
  const mutations = [];
  const environmentCleanup = [];
  const events = [];
  let ownedBranchPipelineReads = 0;
  const session = {
    project: 15,
    defaultBranch: "main",
    async call(name, args) {
      assert.equal(args.project, 15, `${name} must target the pinned project.`);
      if (name === "list_branches") {
        return listed([
          { name: "main" },
          { name: ownedBranch, commit: { id: "a".repeat(40) } },
          { name: "feature/user" },
        ]);
      }
      if (name === "list_pipelines") {
        if (args.ref === ownedBranch) {
          ownedBranchPipelineReads += 1;
          if (ownedBranchPipelineReads === 1) {
            return listed([
              { id: 31, status: "waiting_for_callback" },
              { id: 32, status: "success" },
              { id: 33, status: "canceling" },
            ]);
          }
          return listed([{ id: 34, status: "running" }]);
        }
        assert.equal(args.ref, "bench-bench-run-release");
        return listed([]);
      }
      if (name === "get_pipeline") {
        assert.equal([31, 33, 34].includes(args.pipeline_id), true);
        return { id: args.pipeline_id, status: "canceled" };
      }
      if (name === "list_merge_requests") {
        return listed([
          {
            iid: 84,
            title: "Draft: BENCH fixture bench-run-mr",
            description: "Disposable GitLab MCP benchmark fixture.",
            source_branch: `${ownedBranch}-source`,
            target_branch: `${ownedBranch}-base`,
          },
          {
            iid: 85,
            title: "User MR",
            description: "user-owned",
            source_branch: "feature/user",
            target_branch: "main",
          },
        ]);
      }
      if (name === "list_issues") {
        return listed([
          {
            iid: 91,
            title: "BENCH fixture bench-run-issue",
            description: "Disposable GitLab MCP benchmark issue fixture.",
          },
          { iid: 92, title: "User issue", description: "user-owned" },
        ]);
      }
      if (name === "list_pipeline_schedules") {
        return listed([
          {
            id: 6,
            description: "BENCH bench-run-schedule",
            ref: "main",
            active: false,
          },
          { id: 7, description: "User schedule", ref: "main", active: false },
        ]);
      }
      if (name === "list_project_ci_variables") {
        return listed([
          {
            key: "BENCHMARK_METADATA_BENCH_RUN_VARIABLE",
            environment_scope: "*",
          },
          { key: "USER_VARIABLE", environment_scope: "*" },
        ]);
      }
      if (name === "list_releases") {
        return listed([
          {
            tag_name: "bench-bench-run-release",
            name: "BENCH bench-bench-run-release",
          },
          { tag_name: "v1.0.0", name: "User release" },
        ]);
      }
      if (name === "list_tags") {
        return listed([
          { name: "bench-bench-run-release" },
          { name: "v1.0.0" },
        ]);
      }
      if (name === "list_environments") {
        return listed([
          { id: 11, name: "benchmark / bench-run-deployment" },
          { id: 12, name: "production" },
        ]);
      }
      events.push(name);
      mutations.push({ name, args });
      return {};
    },
    async cleanupBenchmarkEnvironment(args) {
      events.push("cleanupBenchmarkEnvironment");
      environmentCleanup.push(args);
    },
  };

  const summary = await resetStaleBenchmarkFixtures(session);

  assert.deepEqual(summary, {
    mergeRequests: 1,
    issues: 1,
    schedules: 1,
    variables: 1,
    releases: 1,
    tags: 1,
    environments: 1,
    branches: 1,
  });
  assert.deepEqual(environmentCleanup, [
    { environmentId: 11, environmentName: "benchmark / bench-run-deployment" },
  ]);
  assert.deepEqual(
    mutations.map(({ name }) => name),
    [
      "cancel_pipeline",
      "cancel_pipeline",
      "update_merge_request",
      "update_issue",
      "delete_pipeline_schedule",
      "delete_project_ci_variable",
      "delete_release",
      "delete_tag",
      "cancel_pipeline",
      "delete_branch",
    ],
  );
  assert.equal(ownedBranchPipelineReads, 2);
  assert.ok(
    events.lastIndexOf("cancel_pipeline") < events.indexOf("delete_branch"),
  );
  assert.deepEqual(
    mutations.find(({ name }) => name === "delete_branch")?.args,
    {
      project: 15,
      branch: ownedBranch,
      expected_head_sha: "a".repeat(40),
      acknowledge_branch_deletion: true,
    },
  );
  assert.equal(
    mutations.some(({ args }) => JSON.stringify(args).includes("feature/user")),
    false,
  );
});
