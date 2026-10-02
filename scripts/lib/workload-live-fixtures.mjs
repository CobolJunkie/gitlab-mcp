import assert from "node:assert/strict";

import { quiescePipelinesForRef } from "./workload-live-pipeline-quiescence.mjs";
import { isTerminalPipelineStatus } from "./workload-live-pipeline-status.mjs";
import { waitForComparedBranchTip } from "./workload-live-ref-readiness.mjs";

function trimBoundaryHyphens(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

function slug(value) {
  const normalized = trimBoundaryHyphens(
    String(value || "fixture")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-"),
  );
  return normalized.length >= 43
    ? `${normalized.slice(0, 29)}-${normalized.slice(-12)}`
    : normalized;
}

function isNotFound(error) {
  return error?.result?.status === 404 || error?.status === 404;
}

function pipelineRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  return result?.sha ? [result] : [];
}

async function runCleanupOperations(label, operations) {
  const errors = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${label} encountered multiple failures.`);
  }
}

async function rethrowAfterSetupCleanup(error, label, cleanup) {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `${label} setup failed and cleanup could not be completed.`,
    );
  }
  throw error;
}

export function fixtureLabel(session, scenarioId, suffix = "") {
  const tail = suffix ? `-${slug(suffix)}` : "";
  return `${slug(session.runId)}-${slug(scenarioId)}${tail}`.slice(0, 110);
}

export async function closeIssue(session, issueIid) {
  if (!issueIid) return;
  let current;
  try {
    current = await session.call("get_issue", {
      project: session.project,
      issue_iid: issueIid,
    });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (current?.state === "closed") return;
  try {
    await session.call("update_issue", {
      project: session.project,
      issue_iid: issueIid,
      state_event: "close",
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function closeMergeRequest(session, mergeRequestIid) {
  if (!mergeRequestIid) return;
  let current;
  try {
    current = await session.call("get_merge_request", {
      project: session.project,
      merge_request_iid: mergeRequestIid,
    });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (current?.state !== "opened") return;
  try {
    await session.call("update_merge_request", {
      project: session.project,
      merge_request_iid: mergeRequestIid,
      state_event: "close",
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function deleteBranchIfPresent(session, branch) {
  if (!branch) return;
  const branches = await session.call("list_branches", {
    project: session.project,
    search: branch,
    page: 1,
    per_page: 100,
  });
  const rows = Array.isArray(branches?.data) ? branches.data : branches;
  const current = Array.isArray(rows)
    ? rows.find((entry) => entry.name === branch)
    : undefined;
  if (current) {
    await quiescePipelinesForRef(session, branch);
    try {
      await session.call("delete_branch", {
        project: session.project,
        branch,
        expected_head_sha: current.commit?.id,
        acknowledge_branch_deletion: true,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function waitForCreatedBranch(
  session,
  branch,
  expectedCommitId,
  { timeoutMs = 30_000, pollMs = 500 } = {},
) {
  if (!expectedCommitId) return;
  const deadline = Date.now() + timeoutMs;
  let observedCommitId;
  while (Date.now() < deadline) {
    const branches = await session.call("list_branches", {
      project: session.project,
      search: branch,
      page: 1,
      per_page: 100,
    });
    const rows = Array.isArray(branches?.data) ? branches.data : branches;
    const current = Array.isArray(rows)
      ? rows.find((entry) => entry?.name === branch)
      : undefined;
    observedCommitId = current?.commit?.id;
    if (observedCommitId === expectedCommitId) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `Benchmark branch ${branch} did not become visible at expected tip before timeout; last observed tip ${observedCommitId ?? "missing"}.`,
  );
}

export async function createBranchFixture(
  session,
  label,
  { file = true } = {},
) {
  const branch = `mcp-bench/${slug(label)}`;
  let branchCreated = false;
  try {
    const createdBranch = await session.call("create_branch", {
      project: session.project,
      branch,
      ref: session.defaultBranch,
    });
    branchCreated = true;
    await waitForCreatedBranch(session, branch, createdBranch?.commit?.id);
    let commit;
    if (file) {
      commit = await session.call("create_commit", {
        project: session.project,
        branch,
        commit_message: `benchmark: prepare ${slug(label)}`,
        actions: [
          {
            action: "create",
            file_path: `benchmark-fixtures/${slug(label)}.txt`,
            content: `GitLab MCP benchmark fixture ${label}\n`,
          },
        ],
      });
      await waitForCreatedBranch(session, branch, commit?.id);
    }
    return { branch, commit };
  } catch (error) {
    if (!branchCreated) throw error;
    return rethrowAfterSetupCleanup(error, "Branch fixture", () =>
      deleteBranchIfPresent(session, branch),
    );
  }
}

export async function createMergeRequestFixture(
  session,
  label,
  { discussion = false, draft = true } = {},
) {
  const fixture = {
    base: `mcp-bench/${slug(label)}-base`,
    source: `mcp-bench/${slug(label)}-source`,
    baseCreated: false,
    sourceCreated: false,
  };
  try {
    const createdBase = await session.call("create_branch", {
      project: session.project,
      branch: fixture.base,
      ref: session.defaultBranch,
    });
    fixture.baseCreated = true;
    const baseCommitId = createdBase?.commit?.id;
    const createdSource = await session.call("create_branch", {
      project: session.project,
      branch: fixture.source,
      ref: baseCommitId || fixture.base,
    });
    fixture.sourceCreated = true;
    await waitForComparedBranchTip(
      session,
      fixture.base,
      fixture.source,
      createdSource?.commit?.id || baseCommitId,
    );
    fixture.commit = await session.call("create_commit", {
      project: session.project,
      branch: fixture.source,
      commit_message: `benchmark: prepare MR ${slug(label)}`,
      actions: [
        {
          action: "create",
          file_path: `benchmark-fixtures/${slug(label)}.txt`,
          content: `GitLab MCP benchmark MR fixture ${label}\n`,
        },
      ],
    });
    await waitForComparedBranchTip(
      session,
      fixture.base,
      fixture.source,
      fixture.commit?.id,
    );
    fixture.mergeRequest = await session.call("create_merge_request", {
      project: session.project,
      source_branch: fixture.source,
      target_branch: fixture.base,
      title: `${draft ? "Draft: " : ""}BENCH fixture ${label}`,
      description: "Disposable GitLab MCP benchmark fixture.",
      draft,
    });
    if (discussion) {
      fixture.discussion = await session.call(
        "create_merge_request_discussion",
        {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
          body: `Disposable benchmark discussion ${label}`,
        },
      );
    }
    return fixture;
  } catch (error) {
    return rethrowAfterSetupCleanup(error, "Merge-request fixture", () =>
      cleanupMergeRequestFixture(session, fixture),
    );
  }
}

export async function cleanupMergeRequestFixture(session, fixture) {
  if (!fixture) return;
  const operations = [
    () => closeMergeRequest(session, fixture.mergeRequest?.iid),
  ];
  if (fixture.sourceCreated === true) {
    operations.push(() => deleteBranchIfPresent(session, fixture.source));
  }
  if (fixture.baseCreated === true) {
    operations.push(() => deleteBranchIfPresent(session, fixture.base));
  }
  await runCleanupOperations("Merge-request fixture cleanup", operations);
}

export async function createIssueFixture(
  session,
  label,
  { note = false } = {},
) {
  const fixture = {};
  try {
    fixture.issue = await session.call("create_issue", {
      project: session.project,
      title: `BENCH fixture ${label}`,
      description: "Disposable GitLab MCP benchmark issue fixture.",
    });
    if (note) {
      fixture.note = await session.call("create_issue_note", {
        project: session.project,
        issue_iid: fixture.issue.iid,
        body: `Disposable benchmark note ${label}`,
      });
    }
    return fixture;
  } catch (error) {
    return rethrowAfterSetupCleanup(error, "Issue fixture", () =>
      closeIssue(session, fixture.issue?.iid),
    );
  }
}

export async function waitForPipeline(
  session,
  pipelineId,
  expectedStates,
  { timeoutMs = 120_000, pollMs = 1_000 } = {},
) {
  const states = new Set(
    Array.isArray(expectedStates) ? expectedStates : [expectedStates],
  );
  const deadline = Date.now() + timeoutMs;
  let pipeline;
  while (Date.now() < deadline) {
    pipeline = await session.call("get_pipeline", {
      project: session.project,
      pipeline_id: pipelineId,
    });
    if (states.has(pipeline.status)) return pipeline;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `Pipeline ${pipelineId} did not reach ${[...states].join("/")} before timeout; last status ${pipeline?.status}.`,
  );
}

export async function waitForPipelineJob(
  session,
  pipelineId,
  predicate,
  { timeoutMs = 120_000, pollMs = 1_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await session.call("list_pipeline_jobs", {
      project: session.project,
      pipeline_id: pipelineId,
      include_retried: true,
      page: 1,
      per_page: 100,
    });
    const found = pipelineRows(result).find((job) => predicate(job));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Expected job was not observed in pipeline ${pipelineId}.`);
}

export async function createPipelineFixture(
  session,
  label,
  ciYaml,
  { pollAttempts = 60, pollMs = 500 } = {},
) {
  const fixture = {
    branch: `mcp-bench/${slug(label)}`,
    branchCreated: false,
    branchBaseCommitId: undefined,
    commitAttempted: false,
  };
  try {
    const createdBranch = await session.call("create_branch", {
      project: session.project,
      branch: fixture.branch,
      ref: session.defaultBranch,
    });
    fixture.branchCreated = true;
    fixture.branchBaseCommitId = createdBranch?.commit?.id;
    await waitForCreatedBranch(
      session,
      fixture.branch,
      fixture.branchBaseCommitId,
    );
    fixture.commitAttempted = true;
    fixture.commit = await session.call("create_commit", {
      project: session.project,
      branch: fixture.branch,
      commit_message: `benchmark: prepare CI ${slug(label)}`,
      actions: [
        {
          action: "create",
          file_path: ".gitlab-ci.yml",
          content: ciYaml,
        },
      ],
    });
    // Exact ref+SHA pipeline discovery below is the post-commit readiness barrier.
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      try {
        const candidate = await session.call("list_pipelines", {
          project: session.project,
          ref: fixture.branch,
          sha: fixture.commit.id,
          source: "push",
          order_by: "id",
          sort: "desc",
          page: 1,
          per_page: 20,
        });
        const pipeline = pipelineRows(candidate).find(
          (entry) => entry?.sha === fixture.commit.id,
        );
        if (pipeline) {
          fixture.pipeline = pipeline;
          break;
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
        // The push-created pipeline can take a short moment to become visible.
      }
      if (attempt + 1 < pollAttempts) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    assert.ok(
      fixture.pipeline?.id && fixture.pipeline.sha === fixture.commit.id,
      `No push pipeline appeared for benchmark branch ${fixture.branch}.`,
    );
    return fixture;
  } catch (error) {
    return rethrowAfterSetupCleanup(error, "Pipeline fixture", () =>
      cleanupPipelineFixture(session, fixture),
    );
  }
}

async function recoverFixtureCommitForCleanup(session, fixture) {
  if (
    fixture.commit?.id ||
    fixture.commitAttempted !== true ||
    fixture.branchCreated !== true
  ) {
    return;
  }

  const branches = await session.call("list_branches", {
    project: session.project,
    search: fixture.branch,
    page: 1,
    per_page: 100,
  });
  const rows = Array.isArray(branches?.data) ? branches.data : branches;
  const current = Array.isArray(rows)
    ? rows.find((entry) => entry?.name === fixture.branch)
    : undefined;
  if (!current) return;

  const currentCommitId = current?.commit?.id;
  if (!currentCommitId || !fixture.branchBaseCommitId) {
    throw new Error(
      `Refusing to delete benchmark branch ${fixture.branch}: commit outcome is unresolved because branch tip provenance is incomplete.`,
    );
  }
  if (currentCommitId !== fixture.branchBaseCommitId) {
    fixture.commit = { id: currentCommitId };
  }
}

async function resolveFixturePipelineForCleanup(session, fixture) {
  if (fixture.pipeline?.id) return fixture.pipeline;
  if (!fixture.commit?.id) return undefined;

  const candidate = await session.call("list_pipelines", {
    project: session.project,
    ref: fixture.branch,
    sha: fixture.commit.id,
    source: "push",
    order_by: "id",
    sort: "desc",
    page: 1,
    per_page: 20,
  });
  const pipeline = pipelineRows(candidate).find(
    (entry) => entry?.sha === fixture.commit.id,
  );
  if (!pipeline?.id) {
    throw new Error(
      `Refusing to delete benchmark branch ${fixture.branch}: push commit ${fixture.commit.id} exists but its pipeline identity is unresolved.`,
    );
  }
  fixture.pipeline = pipeline;
  return pipeline;
}

async function ensureFixturePipelineTerminalOrAbsent(session, pipeline) {
  if (!pipeline?.id) return;
  let current;
  try {
    current = await session.call("get_pipeline", {
      project: session.project,
      pipeline_id: pipeline.id,
    });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (isTerminalPipelineStatus(current.status)) return;

  try {
    await session.call("cancel_pipeline", {
      project: session.project,
      pipeline_id: pipeline.id,
    });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  try {
    await waitForPipeline(
      session,
      pipeline.id,
      ["success", "failed", "canceled", "skipped"],
      { timeoutMs: 30_000, pollMs: 250 },
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function cleanupPipelineFixture(session, fixture) {
  if (!fixture) return;
  await recoverFixtureCommitForCleanup(session, fixture);
  const pipeline = await resolveFixturePipelineForCleanup(session, fixture);
  await ensureFixturePipelineTerminalOrAbsent(session, pipeline);
  if (fixture.branchCreated === true) {
    await deleteBranchIfPresent(session, fixture.branch);
  }
}
