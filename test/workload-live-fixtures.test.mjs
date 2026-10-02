import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupMergeRequestFixture,
  cleanupPipelineFixture,
  closeIssue,
  closeMergeRequest,
  createBranchFixture,
  createIssueFixture,
  createMergeRequestFixture,
  createPipelineFixture,
  deleteBranchIfPresent,
  fixtureLabel,
  waitForPipeline,
  waitForPipelineJob,
} from "../scripts/lib/workload-live-fixtures.mjs";

function mockSession(resolver = () => undefined) {
  const calls = [];
  let latestCreatedCommitId;
  return {
    project: 42,
    defaultBranch: "main",
    runId: "RUN with spaces",
    calls,
    async call(name, args = {}) {
      calls.push({ name, args });
      const result = await resolver(name, args, calls);
      if (name === "create_branch" && result === undefined) {
        latestCreatedCommitId ||= "base-tip";
        return {
          name: args.branch,
          commit: { id: latestCreatedCommitId || "base-tip" },
        };
      }
      if (name === "compare_refs" && result === undefined) {
        return {
          commit: { id: latestCreatedCommitId || "base-tip" },
          compare_timeout: false,
        };
      }
      if (name === "create_commit" && result?.id) {
        latestCreatedCommitId = result.id;
      }
      if (name === "list_branches" && latestCreatedCommitId) {
        const data = Array.isArray(result?.data) ? result.data : result;
        if (Array.isArray(data)) {
          return {
            data: data.map((entry) =>
              entry?.name === args.search && !entry?.commit?.id
                ? { ...entry, commit: { id: latestCreatedCommitId } }
                : entry,
            ),
          };
        }
        if (result === undefined) {
          return {
            data: [
              {
                name: args.search,
                commit: { id: latestCreatedCommitId },
              },
            ],
          };
        }
      }
      return result;
    },
  };
}

function callsNamed(session, name) {
  return session.calls.filter((entry) => entry.name === name);
}

test("fixture labels are bounded and repository-safe", () => {
  const session = { runId: "RUN with spaces / unsafe" };
  const label = fixtureLabel(session, "MR Review / Metadata", "Iteration 1");
  assert.match(label, /^[a-z0-9_-]+$/);
  assert.match(label, /^run-with-spaces-unsafe-/);
  assert.ok(label.length <= 110);
});

test("long merge-request fixture labels retain distinct iteration suffixes", async () => {
  let commitSequence = 0;
  let mergeRequestIid = 40;
  const session = mockSession((name) => {
    if (name === "create_commit") {
      commitSequence += 1;
      return { id: `mr-commit-${commitSequence}` };
    }
    if (name === "create_merge_request") {
      mergeRequestIid += 1;
      return { iid: mergeRequestIid, state: "opened" };
    }
    return undefined;
  });
  session.runId = "bench-mu34k6z4-b466826c";

  const first = await createMergeRequestFixture(
    session,
    fixtureLabel(session, "mr.resolve-discussion", 1),
  );
  const second = await createMergeRequestFixture(
    session,
    fixtureLabel(session, "mr.resolve-discussion", 2),
  );

  assert.notEqual(first.base, second.base);
  assert.notEqual(first.source, second.source);
  assert.match(first.base, /discussion-1-base$/);
  assert.match(second.base, /discussion-2-base$/);
  assert.ok(first.base.length <= 57);
  assert.ok(second.base.length <= 57);
});

test("issue and merge-request cleanup is bounded and state-aware", async () => {
  const session = mockSession((name, args) => {
    if (name === "get_merge_request") {
      return { iid: args.merge_request_iid, state: "opened" };
    }
    return undefined;
  });

  await closeIssue(session, 8);
  await closeIssue(session, undefined);
  await closeMergeRequest(session, 9);
  await closeMergeRequest(session, undefined);

  assert.deepEqual(callsNamed(session, "update_issue")[0].args, {
    project: 42,
    issue_iid: 8,
    state_event: "close",
  });
  assert.deepEqual(callsNamed(session, "update_merge_request")[0].args, {
    project: 42,
    merge_request_iid: 9,
    state_event: "close",
  });
});

test("closed merge requests are not mutated during cleanup", async () => {
  const session = mockSession((name) =>
    name === "get_merge_request" ? { state: "closed" } : undefined,
  );
  await closeMergeRequest(session, 11);
  assert.equal(callsNamed(session, "update_merge_request").length, 0);
});

test("branch fixtures create bounded content and delete only an observed branch", async () => {
  const session = mockSession((name, args) => {
    if (name === "create_commit") return { id: "commit-1" };
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  const fixture = await createBranchFixture(session, "Compare Refs");
  assert.equal(fixture.branch, "mcp-bench/compare-refs");
  assert.equal(fixture.commit.id, "commit-1");
  assert.equal(callsNamed(session, "create_branch").length, 1);
  assert.equal(callsNamed(session, "create_commit").length, 1);

  const action = callsNamed(session, "create_commit")[0].args.actions[0];
  assert.equal(action.action, "create");
  assert.equal(action.file_path, "benchmark-fixtures/compare-refs.txt");
  assert.match(action.content, /GitLab MCP benchmark fixture/);

  await deleteBranchIfPresent(session, fixture.branch);
  assert.deepEqual(callsNamed(session, "delete_branch")[0].args, {
    project: 42,
    branch: fixture.branch,
    expected_head_sha: "commit-1",
    acknowledge_branch_deletion: true,
  });
});

test("branch fixtures can omit the commit and missing branches are not deleted", async () => {
  const session = mockSession((name) =>
    name === "list_branches"
      ? {
          data:
            callsNamed(session, "list_branches").length === 1
              ? [
                  {
                    name: "mcp-bench/empty-branch",
                    commit: { id: "base-tip" },
                  },
                ]
              : [],
        }
      : undefined,
  );
  const fixture = await createBranchFixture(session, "empty branch", {
    file: false,
  });
  assert.equal(fixture.commit, undefined);
  assert.equal(callsNamed(session, "create_commit").length, 0);
  await deleteBranchIfPresent(session, fixture.branch);
  await deleteBranchIfPresent(session, undefined);
  assert.equal(callsNamed(session, "delete_branch").length, 0);
});

test("branch fixture setup does not delete a branch when creation fails", async () => {
  const failure = new Error("branch already exists");
  const session = mockSession((name) => {
    if (name === "create_branch") throw failure;
    return undefined;
  });

  await assert.rejects(
    createBranchFixture(session, "colliding branch"),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "list_branches").length, 0);
  assert.equal(callsNamed(session, "delete_branch").length, 0);
});

test("branch fixture setup cleans its branch when commit creation fails", async () => {
  const failure = new Error("commit failed");
  const session = mockSession((name, args) => {
    if (name === "create_commit") throw failure;
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  await assert.rejects(
    createBranchFixture(session, "partial branch"),
    (error) => error === failure,
  );
  assert.deepEqual(callsNamed(session, "delete_branch")[0].args, {
    project: 42,
    branch: "mcp-bench/partial-branch",
    expected_head_sha: "base-tip",
    acknowledge_branch_deletion: true,
  });
});

test("issue fixtures optionally create a benchmark-owned note", async () => {
  const session = mockSession((name) => {
    if (name === "create_issue") return { iid: 21, state: "opened" };
    if (name === "create_issue_note") return { id: 22 };
    return undefined;
  });

  const withNote = await createIssueFixture(session, "inspect-thread", {
    note: true,
  });
  const withoutNote = await createIssueFixture(session, "read-only");

  assert.equal(withNote.issue.iid, 21);
  assert.equal(withNote.note.id, 22);
  assert.equal(withoutNote.note, undefined);
  assert.equal(callsNamed(session, "create_issue").length, 2);
  assert.equal(callsNamed(session, "create_issue_note").length, 1);
});

test("issue fixture setup closes a created issue when note creation fails", async () => {
  const failure = new Error("note failed");
  const session = mockSession((name) => {
    if (name === "create_issue") return { iid: 23, state: "opened" };
    if (name === "create_issue_note") throw failure;
    return undefined;
  });

  await assert.rejects(
    createIssueFixture(session, "partial issue", { note: true }),
    (error) => error === failure,
  );
  assert.deepEqual(callsNamed(session, "update_issue")[0].args, {
    project: 42,
    issue_iid: 23,
    state_event: "close",
  });
});

test("merge-request fixtures create and fully clean their owned state", async () => {
  const session = mockSession((name, args) => {
    if (name === "create_commit") return { id: "mr-commit" };
    if (name === "create_merge_request") return { iid: 31, state: "opened" };
    if (name === "create_merge_request_discussion") return { id: "thread-1" };
    if (name === "get_merge_request") return { iid: 31, state: "opened" };
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  const fixture = await createMergeRequestFixture(session, "Review MR", {
    discussion: true,
  });
  assert.equal(fixture.base, "mcp-bench/review-mr-base");
  assert.equal(fixture.source, "mcp-bench/review-mr-source");
  assert.equal(fixture.baseCreated, true);
  assert.equal(fixture.sourceCreated, true);
  assert.equal(fixture.commit.id, "mr-commit");
  assert.equal(fixture.mergeRequest.iid, 31);
  assert.equal(fixture.discussion.id, "thread-1");

  await cleanupMergeRequestFixture(session, fixture);
  await cleanupMergeRequestFixture(session, undefined);

  assert.equal(callsNamed(session, "update_merge_request").length, 1);
  assert.deepEqual(
    callsNamed(session, "delete_branch").map((entry) => entry.args.branch),
    [fixture.source, fixture.base],
  );
});

test("merge-request setup does not delete branches when base creation fails", async () => {
  const failure = new Error("base already exists");
  const session = mockSession((name) => {
    if (name === "create_branch") throw failure;
    return undefined;
  });

  await assert.rejects(
    createMergeRequestFixture(session, "colliding base"),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "list_branches").length, 0);
  assert.equal(callsNamed(session, "delete_branch").length, 0);
});

test("merge-request setup deletes only its created base when source creation fails", async () => {
  const failure = new Error("source already exists");
  let createBranchCalls = 0;
  const session = mockSession((name, args) => {
    if (name === "create_branch") {
      createBranchCalls += 1;
      if (createBranchCalls === 2) throw failure;
    }
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  await assert.rejects(
    createMergeRequestFixture(session, "colliding source"),
    (error) => error === failure,
  );
  assert.deepEqual(
    callsNamed(session, "delete_branch").map((entry) => entry.args.branch),
    ["mcp-bench/colliding-source-base"],
  );
  assert.deepEqual(
    callsNamed(session, "list_branches").map((entry) => entry.args.search),
    ["mcp-bench/colliding-source-base"],
  );
});

test("merge-request setup cleans all partial state when discussion creation fails", async () => {
  const failure = new Error("discussion failed");
  const session = mockSession((name, args) => {
    if (name === "create_commit") return { id: "mr-commit" };
    if (name === "create_merge_request") return { iid: 32, state: "opened" };
    if (name === "create_merge_request_discussion") throw failure;
    if (name === "get_merge_request") return { iid: 32, state: "opened" };
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  await assert.rejects(
    createMergeRequestFixture(session, "partial mr", { discussion: true }),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "update_merge_request").length, 1);
  assert.deepEqual(
    callsNamed(session, "delete_branch").map((entry) => entry.args.branch),
    ["mcp-bench/partial-mr-source", "mcp-bench/partial-mr-base"],
  );
});

test("merge-request cleanup attempts owned branches even when close fails", async () => {
  const closeFailure = new Error("close failed");
  const session = mockSession((name, args) => {
    if (name === "get_merge_request") throw closeFailure;
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  await assert.rejects(
    cleanupMergeRequestFixture(session, {
      base: "mcp-bench/base",
      source: "mcp-bench/source",
      baseCreated: true,
      sourceCreated: true,
      mergeRequest: { iid: 33 },
    }),
    (error) => error === closeFailure,
  );
  assert.deepEqual(
    callsNamed(session, "delete_branch").map((entry) => entry.args.branch),
    ["mcp-bench/source", "mcp-bench/base"],
  );
});

test("pipeline wait helpers return immediately when the expected state is present", async () => {
  const session = mockSession((name) => {
    if (name === "get_pipeline") return { id: 51, status: "success" };
    if (name === "list_pipeline_jobs") {
      return { data: [{ id: 52, status: "failed" }] };
    }
    return undefined;
  });

  const pipeline = await waitForPipeline(session, 51, ["running", "success"], {
    timeoutMs: 100,
    pollMs: 0,
  });
  const job = await waitForPipelineJob(
    session,
    51,
    (entry) => entry.status === "failed",
    { timeoutMs: 100, pollMs: 0 },
  );

  assert.equal(pipeline.status, "success");
  assert.equal(job.id, 52);
});

test("pipeline fixtures bind the observed pipeline to the created commit", async () => {
  const session = mockSession((name) => {
    if (name === "create_commit") return { id: "pipeline-sha" };
    if (name === "list_pipelines") {
      return { id: 61, sha: "pipeline-sha", status: "pending" };
    }
    return undefined;
  });

  const fixture = await createPipelineFixture(
    session,
    "Failure Pipeline",
    "stages: [test]\n",
  );
  assert.equal(fixture.branch, "mcp-bench/failure-pipeline");
  assert.equal(fixture.branchCreated, true);
  assert.equal(fixture.pipeline.id, 61);
  assert.equal(
    callsNamed(session, "create_commit")[0].args.actions[0].file_path,
    ".gitlab-ci.yml",
  );
  assert.deepEqual(callsNamed(session, "list_pipelines")[0].args, {
    project: 42,
    ref: "mcp-bench/failure-pipeline",
    sha: "pipeline-sha",
    source: "push",
    order_by: "id",
    sort: "desc",
    page: 1,
    per_page: 20,
  });
});

test("pipeline fixture preserves its branch when pipeline discovery remains unavailable", async () => {
  const failure = new Error("pipeline listing forbidden");
  failure.result = { status: 403 };
  const session = mockSession((name) => {
    if (name === "create_commit") return { id: "pipeline-sha" };
    if (name === "list_pipelines") throw failure;
    return undefined;
  });

  await assert.rejects(
    createPipelineFixture(session, "forbidden pipeline", "stages: [test]\n", {
      pollAttempts: 1,
      pollMs: 0,
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors?.[0] === failure &&
      error.errors?.[1] === failure,
  );
  assert.equal(callsNamed(session, "list_pipelines").length, 2);
  assert.equal(callsNamed(session, "delete_branch").length, 0);
});

test("pipeline fixture preserves its branch when no exact push pipeline can be proven", async () => {
  const session = mockSession((name) => {
    if (name === "create_commit") return { id: "owned-pipeline-sha" };
    if (name === "list_pipelines") {
      return { id: 62, sha: "unrelated-sha", status: "running" };
    }
    return undefined;
  });

  await assert.rejects(
    createPipelineFixture(session, "unrelated latest", "stages: [test]\n", {
      pollAttempts: 1,
      pollMs: 0,
    }),
    (error) =>
      error instanceof AggregateError &&
      /No push pipeline appeared/.test(error.errors?.[0]?.message || "") &&
      /pipeline identity is unresolved/.test(error.errors?.[1]?.message || ""),
  );
  assert.equal(callsNamed(session, "get_pipeline").length, 0);
  assert.equal(callsNamed(session, "cancel_pipeline").length, 0);
  assert.equal(callsNamed(session, "delete_branch").length, 0);
});

test("pipeline fixture setup does not delete a branch when creation fails", async () => {
  const failure = new Error("pipeline branch already exists");
  const session = mockSession((name) => {
    if (name === "create_branch") throw failure;
    return undefined;
  });

  await assert.rejects(
    createPipelineFixture(session, "colliding pipeline", "stages: [test]\n"),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "list_branches").length, 0);
  assert.equal(callsNamed(session, "delete_branch").length, 0);
});

test("pipeline fixture setup removes its branch when commit creation fails", async () => {
  const failure = new Error("pipeline commit failed");
  const session = mockSession((name, args) => {
    if (name === "create_commit") throw failure;
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  await assert.rejects(
    createPipelineFixture(session, "partial pipeline", "stages: [test]\n"),
    (error) => error === failure,
  );
  assert.deepEqual(callsNamed(session, "delete_branch")[0].args, {
    project: 42,
    branch: "mcp-bench/partial-pipeline",
    expected_head_sha: "base-tip",
    acknowledge_branch_deletion: true,
  });
});

test("pipeline cleanup cancels active pipelines and removes their owned branch", async () => {
  let pipelineReads = 0;
  const session = mockSession((name, args) => {
    if (name === "get_pipeline") {
      pipelineReads += 1;
      return { id: 71, status: pipelineReads === 1 ? "running" : "canceled" };
    }
    if (name === "cancel_pipeline") return { id: 71, status: "canceling" };
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });
  const fixture = {
    branch: "mcp-bench/active",
    branchCreated: true,
    pipeline: { id: 71 },
  };

  await cleanupPipelineFixture(session, fixture);
  await cleanupPipelineFixture(session, undefined);

  assert.equal(callsNamed(session, "cancel_pipeline").length, 1);
  assert.equal(callsNamed(session, "get_pipeline").length, 2);
  assert.equal(callsNamed(session, "delete_branch").length, 1);
});

test("pipeline cleanup preserves its branch when pipeline inspection fails", async () => {
  const failure = new Error("pipeline lookup failed");
  const session = mockSession((name) => {
    if (name === "get_pipeline") throw failure;
    return undefined;
  });

  await assert.rejects(
    cleanupPipelineFixture(session, {
      branch: "mcp-bench/lookup-failed",
      branchCreated: true,
      pipeline: { id: 72 },
    }),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "delete_branch").length, 0);
});

test("pipeline cleanup leaves terminal pipelines untouched", async () => {
  const session = mockSession((name) =>
    name === "get_pipeline" ? { id: 81, status: "success" } : [],
  );
  await cleanupPipelineFixture(session, {
    branch: "mcp-bench/terminal",
    branchCreated: true,
    pipeline: { id: 81 },
  });
  assert.equal(callsNamed(session, "cancel_pipeline").length, 0);
});
