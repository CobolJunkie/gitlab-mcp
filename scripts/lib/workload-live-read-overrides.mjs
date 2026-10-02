import assert from "node:assert/strict";

import {
  cleanupDeploymentFixture,
  createDeploymentFixture,
} from "./workload-live-deployment-fixtures.mjs";
import { waitForMergeRequestPrepared } from "./workload-live-merge-request-readiness.mjs";
import {
  cleanupMergeRequestFixture,
  cleanupPipelineFixture,
  closeIssue,
  createBranchFixture,
  createIssueFixture,
  createMergeRequestFixture,
  createPipelineFixture,
  deleteBranchIfPresent,
  fixtureLabel,
  waitForPipeline,
  waitForPipelineJob,
} from "./workload-live-fixtures.mjs";
import {
  cleanupReleaseFixture,
  createReleaseFixture,
} from "./workload-live-release-fixtures.mjs";

const FAILURE_CI = `image: node:22-alpine\nstages: [test]\nbenchmark_failure:\n  stage: test\n  script:\n    - echo BENCHMARK_EXPECTED_FAILURE\n    - exit 7\n`;

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

function verified(value) {
  return { verified: value === true, forbiddenEffectsObserved: [] };
}

function discussionResolutionState(discussion) {
  const notes = Array.isArray(discussion?.notes) ? discussion.notes : [];
  const resolvableNotes = notes.filter((note) => note?.resolvable === true);
  if (resolvableNotes.length === 0) return null;
  if (resolvableNotes.every((note) => note.resolved === true)) {
    return "resolved";
  }
  if (resolvableNotes.some((note) => note.resolved === false)) {
    return "unresolved";
  }
  return null;
}

function compareRefsHandler(session) {
  let fixture;
  return {
    prepare: async () => {
      fixture = await createBranchFixture(
        session,
        fixtureLabel(session, "repository.compare-refs"),
      );
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const comparison = await session.call("compare_refs", {
          project: session.project,
          from: session.defaultBranch,
          to: fixture.branch,
          straight: true,
          unidiff: true,
        });
        assert.equal(
          comparison?.commits?.some((entry) => entry.id === fixture.commit.id),
          true,
          "Benchmark comparison did not contain the fixture commit.",
        );
        assert.ok(
          Array.isArray(comparison?.diffs) && comparison.diffs.length > 0,
          "Benchmark comparison did not contain the fixture diff.",
        );
      }),
    verifyFinalState: async () => {
      const branches = await session.call("list_branches", {
        project: session.project,
        search: fixture.branch,
        page: 1,
        per_page: 100,
      });
      const branch = rows(branches).find(
        (entry) => entry.name === fixture.branch,
      );
      return verified(branch?.commit?.id === fixture.commit.id);
    },
    finalize: async () => deleteBranchIfPresent(session, fixture?.branch),
  };
}

function issueInspectHandler(session) {
  let fixture;
  return {
    prepare: async () => {
      fixture = await createIssueFixture(
        session,
        fixtureLabel(session, "issues.inspect-thread"),
        { note: true },
      );
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const issue = await session.call("get_issue", {
          project: session.project,
          issue_iid: fixture.issue.iid,
        });
        const notes = await session.call("list_issue_notes", {
          project: session.project,
          issue_iid: fixture.issue.iid,
          page: 1,
          per_page: 20,
        });
        assert.equal(issue?.iid, fixture.issue.iid);
        assert.equal(
          rows(notes).some((entry) => entry.id === fixture.note.id),
          true,
        );
      }),
    verifyFinalState: async () => {
      const [issue, notes] = await Promise.all([
        session.call("get_issue", {
          project: session.project,
          issue_iid: fixture.issue.iid,
        }),
        session.call("list_issue_notes", {
          project: session.project,
          issue_iid: fixture.issue.iid,
          page: 1,
          per_page: 20,
        }),
      ]);
      return verified(
        issue?.state === "opened" &&
          rows(notes).some((entry) => entry.id === fixture.note.id),
      );
    },
    finalize: async () => closeIssue(session, fixture?.issue?.iid),
  };
}

function mergeRequestFixtureHandler(
  session,
  scenarioId,
  measuredOperation,
  {
    discussion = false,
    verifyDiscussion = false,
    waitForPrepared = false,
  } = {},
) {
  let fixture;
  return {
    prepare: async () => {
      fixture = await createMergeRequestFixture(
        session,
        fixtureLabel(session, scenarioId),
        { discussion },
      );
      if (waitForPrepared) {
        await waitForMergeRequestPrepared(session, fixture);
      }
    },
    execute: ({ observe }) =>
      session.measured(observe, () => measuredOperation(fixture)),
    verifyFinalState: async () => {
      const mergeRequest = await session.call("get_merge_request", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
      });
      let discussionPresent = true;
      if (verifyDiscussion) {
        const discussions = await session.call(
          "list_merge_request_discussions",
          {
            project: session.project,
            merge_request_iid: fixture.mergeRequest.iid,
            page: 1,
            per_page: 100,
          },
        );
        discussionPresent = rows(discussions).some(
          (entry) => entry.id === fixture.discussion?.id,
        );
      }
      return verified(
        mergeRequest?.state === "opened" &&
          mergeRequest?.source_branch === fixture.source &&
          mergeRequest?.target_branch === fixture.base &&
          discussionPresent,
      );
    },
    finalize: async () => cleanupMergeRequestFixture(session, fixture),
  };
}

function mergeRequestMetadataHandler(session) {
  return mergeRequestFixtureHandler(
    session,
    "mr.review-metadata-diff",
    async (fixture) => {
      const mergeRequest = await session.call("get_merge_request", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
      });
      const commits = await session.call("list_merge_request_commits", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
        page: 1,
        per_page: 20,
      });
      const diffs = await session.call("list_merge_request_diffs", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
        page: 1,
        per_page: 20,
      });
      assert.equal(mergeRequest?.iid, fixture.mergeRequest.iid);
      assert.equal(
        rows(commits).some((entry) => entry.id === fixture.commit.id),
        true,
      );
      assert.ok(rows(diffs).length > 0);
    },
    { waitForPrepared: true },
  );
}

async function prepareMixedDiscussionFixture(session) {
  let fixture;
  try {
    const label = fixtureLabel(session, "mr.review-discussions");
    fixture = await createMergeRequestFixture(session, label, {
      discussion: true,
    });
    fixture.resolvedDiscussion = await session.call(
      "create_merge_request_discussion",
      {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
        body: `Disposable resolved benchmark discussion ${label}`,
      },
    );
    await session.call("resolve_merge_request_discussion", {
      project: session.project,
      merge_request_iid: fixture.mergeRequest.iid,
      discussion_id: fixture.resolvedDiscussion.id,
      resolved: true,
    });
    return fixture;
  } catch (error) {
    if (!fixture) throw error;
    try {
      await cleanupMergeRequestFixture(session, fixture);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Benchmark mixed-discussion setup failed and cleanup could not be completed.",
      );
    }
    throw error;
  }
}

function mixedDiscussionsVerified(discussions, fixture) {
  const entries = rows(discussions);
  const unresolved = entries.find(
    (entry) => entry.id === fixture.discussion?.id,
  );
  const resolved = entries.find(
    (entry) => entry.id === fixture.resolvedDiscussion?.id,
  );
  return (
    discussionResolutionState(unresolved) === "unresolved" &&
    discussionResolutionState(resolved) === "resolved"
  );
}

function mergeRequestDiscussionsHandler(session) {
  let fixture;
  return {
    prepare: async () => {
      fixture = await prepareMixedDiscussionFixture(session);
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const discussions = await session.call(
          "list_merge_request_discussions",
          {
            project: session.project,
            merge_request_iid: fixture.mergeRequest.iid,
            page: 1,
            per_page: 100,
          },
        );
        assert.equal(mixedDiscussionsVerified(discussions, fixture), true);
      }),
    verifyFinalState: async () => {
      const mergeRequest = await session.call("get_merge_request", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
      });
      const discussions = await session.call("list_merge_request_discussions", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
        page: 1,
        per_page: 100,
      });
      return verified(
        mergeRequest?.state === "opened" &&
          mergeRequest?.source_branch === fixture.source &&
          mergeRequest?.target_branch === fixture.base &&
          mixedDiscussionsVerified(discussions, fixture),
      );
    },
    finalize: async () => cleanupMergeRequestFixture(session, fixture),
  };
}

function mergeRequestReadinessHandler(session, scenarioId) {
  return mergeRequestFixtureHandler(session, scenarioId, async (fixture) => {
    const mergeRequest = await session.call("get_merge_request", {
      project: session.project,
      merge_request_iid: fixture.mergeRequest.iid,
    });
    const approvals = await session.call("get_merge_request_approvals", {
      project: session.project,
      merge_request_iid: fixture.mergeRequest.iid,
    });
    assert.equal(mergeRequest?.iid, fixture.mergeRequest.iid);
    assert.ok(approvals && typeof approvals === "object");
  });
}

function governanceApprovalsHandler(session) {
  return mergeRequestFixtureHandler(
    session,
    "governance.approvals",
    async (fixture) => {
      const approvals = await session.call("get_merge_request_approvals", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
      });
      assert.ok(approvals && typeof approvals === "object");
    },
  );
}

async function prepareFailedPipeline(session, scenarioId) {
  let fixture;
  try {
    fixture = await createPipelineFixture(
      session,
      fixtureLabel(session, scenarioId),
      FAILURE_CI,
    );
    await waitForPipeline(session, fixture.pipeline.id, "failed");
    const failedJob = await waitForPipelineJob(
      session,
      fixture.pipeline.id,
      (job) => job.status === "failed",
    );
    return { fixture, failedJob };
  } catch (error) {
    if (!fixture) throw error;
    try {
      await cleanupPipelineFixture(session, fixture);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Benchmark failed-pipeline preparation for ${scenarioId} failed and cleanup could not be completed.`,
      );
    }
    throw error;
  }
}

function failedPipelineReadHandler(session, scenarioId, measuredOperation) {
  let state;
  return {
    prepare: async () => {
      state = await prepareFailedPipeline(session, scenarioId);
    },
    execute: ({ observe }) =>
      session.measured(observe, () => measuredOperation(state)),
    verifyFinalState: async () => {
      const pipeline = await session.call("get_pipeline", {
        project: session.project,
        pipeline_id: state.fixture.pipeline.id,
      });
      return verified(pipeline?.status === "failed");
    },
    finalize: async () => cleanupPipelineFixture(session, state?.fixture),
  };
}

function diagnoseFailureHandler(session) {
  return failedPipelineReadHandler(
    session,
    "ci.diagnose-failure",
    async ({ fixture, failedJob }) => {
      const pipeline = await session.call("get_pipeline", {
        project: session.project,
        pipeline_id: fixture.pipeline.id,
      });
      const jobs = await session.call("list_pipeline_jobs", {
        project: session.project,
        pipeline_id: fixture.pipeline.id,
        include_retried: true,
        page: 1,
        per_page: 100,
      });
      assert.equal(pipeline?.id, fixture.pipeline.id);
      assert.equal(pipeline?.status, "failed");
      assert.equal(
        rows(jobs).some(
          (entry) => entry.id === failedJob.id && entry.status === "failed",
        ),
        true,
      );
    },
  );
}

function boundedLogHandler(session) {
  return failedPipelineReadHandler(
    session,
    "ci.bounded-log",
    async ({ failedJob }) => {
      const log = await session.call("get_job_log", {
        project: session.project,
        job_id: failedJob.id,
        max_bytes: 16_384,
      });
      assert.equal(typeof log, "string");
      assert.match(log, /BENCHMARK_EXPECTED_FAILURE/);
    },
  );
}

function releaseInspectHandler(session) {
  let fixture;
  return {
    prepare: async () => {
      const tagName = `bench-${fixtureLabel(session, "release.inspect")}`.slice(
        0,
        120,
      );
      fixture = await createReleaseFixture(session, tagName, {
        assetName: "benchmark-readme",
        assetUrl: session.projectInfo.readme_url,
        assetLinkType: "other",
        description: "Disposable benchmark release fixture.",
      });
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const release = await session.call("get_release", {
          project: session.project,
          tag_name: fixture.tagName,
        });
        const links = await session.call("list_release_asset_links", {
          project: session.project,
          tag_name: fixture.tagName,
        });
        assert.equal(release?.tag_name, fixture.tagName);
        assert.equal(
          rows(links).some((entry) => entry.id === fixture.assetLink?.id),
          true,
        );
      }),
    verifyFinalState: async () => {
      const release = await session.call("get_release", {
        project: session.project,
        tag_name: fixture.tagName,
      });
      const links = await session.call("list_release_asset_links", {
        project: session.project,
        tag_name: fixture.tagName,
      });
      return verified(
        release?.tag_name === fixture.tagName &&
          rows(links).some((entry) => entry.id === fixture.assetLink?.id),
      );
    },
    finalize: async () => cleanupReleaseFixture(session, fixture),
  };
}

function deploymentInspectHandler(session) {
  let fixture;
  return {
    prepare: async () => {
      const label = fixtureLabel(session, "deployment.inspect");
      const environmentName = `benchmark / ${label}`;
      const ciYaml = `image: node:22-alpine\nstages: [deploy]\nbenchmark_environment:\n  stage: deploy\n  script:\n    - echo BENCHMARK_DEPLOYMENT_OK\n  environment:\n    name: ${environmentName}\n`;
      fixture = await createDeploymentFixture(session, {
        label,
        environmentName,
        ciYaml,
      });
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const environments = await session.call("list_environments", {
          project: session.project,
          search: fixture.environmentName,
          page: 1,
          per_page: 20,
        });
        const deployments = await session.call("list_deployments", {
          project: session.project,
          environment: fixture.environmentName,
          page: 1,
          per_page: 20,
        });
        assert.equal(
          rows(environments).some(
            (entry) =>
              entry.id === fixture.environment.id &&
              entry.name === fixture.environmentName,
          ),
          true,
        );
        assert.equal(
          rows(deployments).some(
            (entry) => entry.environment?.id === fixture.environment.id,
          ),
          true,
        );
      }),
    verifyFinalState: async () => {
      const environments = await session.call("list_environments", {
        project: session.project,
        search: fixture.environmentName,
        page: 1,
        per_page: 20,
      });
      return verified(
        rows(environments).some(
          (entry) =>
            entry.id === fixture.environment.id &&
            entry.name === fixture.environmentName,
        ),
      );
    },
    finalize: async () => cleanupDeploymentFixture(session, fixture),
  };
}

export function applyVerifiedReadWorkloadOverrides(session, handlers) {
  handlers["repository.compare-refs"] = compareRefsHandler(session);
  handlers["issues.inspect-thread"] = issueInspectHandler(session);
  handlers["mr.review-metadata-diff"] = mergeRequestMetadataHandler(session);
  handlers["mr.review-discussions"] = mergeRequestDiscussionsHandler(session);
  handlers["mr.merge-readiness"] = mergeRequestReadinessHandler(
    session,
    "mr.merge-readiness",
  );
  handlers["ci.diagnose-failure"] = diagnoseFailureHandler(session);
  handlers["ci.bounded-log"] = boundedLogHandler(session);
  handlers["governance.approvals"] = governanceApprovalsHandler(session);
  handlers["release.inspect"] = releaseInspectHandler(session);
  handlers["deployment.inspect"] = deploymentInspectHandler(session);
  return handlers;
}
