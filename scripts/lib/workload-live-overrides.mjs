import {
  cleanupDeploymentFixture,
  createDeploymentFixture,
} from "./workload-live-deployment-fixtures.mjs";
import {
  cleanupMergeRequestFixture,
  cleanupPipelineFixture,
  closeIssue,
  createIssueFixture,
  createMergeRequestFixture,
  createPipelineFixture,
  fixtureLabel,
  waitForPipeline,
} from "./workload-live-fixtures.mjs";
import {
  cleanupReleaseFixture,
  createReleaseFixture,
} from "./workload-live-release-fixtures.mjs";
import {
  createAdmissionLimitBenchmarkHandler,
  createReadOnlyMutationBenchmarkHandler,
} from "./workload-live-safety.mjs";

const FAILURE_CI = `image: node:22-alpine\nstages: [test]\nbenchmark_failure:\n  stage: test\n  script:\n    - echo BENCHMARK_EXPECTED_FAILURE\n    - exit 7\n`;

function successVerification() {
  return { verified: true, forbiddenEffectsObserved: [] };
}

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

function discussionResolved(discussion) {
  const notes = Array.isArray(discussion?.notes) ? discussion.notes : [];
  const resolvableNotes = notes.filter((note) => note?.resolvable === true);
  if (resolvableNotes.length > 0) {
    return resolvableNotes.every((note) => note.resolved === true);
  }
  return discussion?.resolvable === true && discussion?.resolved === true;
}

function mergeRequestReady(current) {
  const mergeable =
    current?.merge_status === "can_be_merged" ||
    current?.detailed_merge_status === "mergeable";
  return (
    mergeable && current?.draft !== true && current?.work_in_progress !== true
  );
}

async function waitForMergeRequestMergeable(session, mergeRequestIid) {
  const deadline = Date.now() + 30_000;
  let current;
  while (Date.now() < deadline) {
    current = await session.call("get_merge_request", {
      project: session.project,
      merge_request_iid: mergeRequestIid,
    });
    if (mergeRequestReady(current)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Benchmark merge request ${mergeRequestIid} did not become mergeable before timeout; last status ${current?.detailed_merge_status ?? current?.merge_status ?? "unknown"}.`,
  );
}

function assertGuardedMergeIdentity(current, fixture) {
  if (
    current?.state !== "opened" ||
    current?.source_branch !== fixture.source ||
    current?.target_branch !== fixture.base ||
    current?.sha !== fixture.commit?.id ||
    !mergeRequestReady(current)
  ) {
    throw new Error(
      "Benchmark guarded merge fixture changed from its pinned source, target, head, or merge-ready state.",
    );
  }
}

function issueUpdateCommentHandler(session) {
  let fixture;
  let expectedDescription;
  let note;
  return {
    setup: async ({ iteration }) => {
      fixture = await createIssueFixture(
        session,
        fixtureLabel(session, "issues.update-comment", iteration),
      );
    },
    execute: ({ observe, iteration }) =>
      session.measured(observe, async () => {
        expectedDescription = `Updated by benchmark iteration ${iteration}.`;
        await session.call("update_issue", {
          project: session.project,
          issue_iid: fixture.issue.iid,
          description: expectedDescription,
        });
        note = await session.call("create_issue_note", {
          project: session.project,
          issue_iid: fixture.issue.iid,
          body: `Benchmark comment iteration ${iteration}.`,
        });
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
      const target = rows(notes).find((entry) => entry.id === note?.id);
      return {
        verified:
          issue.state === "opened" &&
          issue.description === expectedDescription &&
          Boolean(target?.id),
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await closeIssue(session, fixture?.issue?.iid);
      fixture = undefined;
      expectedDescription = undefined;
      note = undefined;
    },
  };
}

function retryFailedPipelineHandler(session) {
  let fixture;
  let retried;
  return {
    setup: async ({ iteration }) => {
      fixture = await createPipelineFixture(
        session,
        fixtureLabel(session, "ci.retry-failed", iteration),
        FAILURE_CI,
      );
      await waitForPipeline(session, fixture.pipeline.id, "failed");
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        retried = await session.call("retry_pipeline", {
          project: session.project,
          pipeline_id: fixture.pipeline.id,
        });
      }),
    verifyFinalState: async () => ({
      verified: retried?.id === fixture.pipeline.id,
      forbiddenEffectsObserved: [],
    }),
    cleanup: async () => {
      await cleanupPipelineFixture(session, fixture);
      fixture = undefined;
      retried = undefined;
    },
  };
}

function commentDiscussionHandler(session) {
  let fixture;
  let discussion;
  return {
    setup: async ({ iteration }) => {
      fixture = await createMergeRequestFixture(
        session,
        fixtureLabel(session, "mr.comment", iteration),
      );
    },
    execute: ({ observe, iteration }) =>
      session.measured(observe, async () => {
        discussion = await session.call("create_merge_request_discussion", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
          body: `Benchmark MR comment ${iteration}`,
        });
      }),
    verifyFinalState: async () => {
      const [mergeRequest, discussions] = await Promise.all([
        session.call("get_merge_request", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
        }),
        session.call("list_merge_request_discussions", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
          page: 1,
          per_page: 100,
        }),
      ]);
      const target = rows(discussions).find(
        (entry) => entry.id === discussion?.id,
      );
      return {
        verified: mergeRequest.state === "opened" && Boolean(target?.id),
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await cleanupMergeRequestFixture(session, fixture);
      fixture = undefined;
      discussion = undefined;
    },
  };
}

function guardedMergeHandler(session) {
  let fixture;
  return {
    setup: async ({ iteration }) => {
      fixture = await createMergeRequestFixture(
        session,
        fixtureLabel(session, "mr.guarded-merge", iteration),
        { draft: false },
      );
      await waitForMergeRequestMergeable(session, fixture.mergeRequest.iid);
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const current = await session.call("get_merge_request", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
        });
        assertGuardedMergeIdentity(current, fixture);
        await session.call("merge_merge_request", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
          sha: fixture.commit.id,
          squash: false,
          should_remove_source_branch: false,
        });
      }),
    verifyFinalState: async () => {
      const current = await session.call("get_merge_request", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
      });
      return {
        verified:
          current.state === "merged" &&
          current.source_branch === fixture.source &&
          current.target_branch === fixture.base &&
          current.sha === fixture.commit.id,
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await cleanupMergeRequestFixture(session, fixture);
      fixture = undefined;
    },
  };
}

function resolveDiscussionHandler(session) {
  let fixture;
  return {
    setup: async ({ iteration }) => {
      fixture = await createMergeRequestFixture(
        session,
        fixtureLabel(session, "mr.resolve-discussion", iteration),
        { discussion: true },
      );
    },
    execute: ({ observe }) =>
      session.measured(observe, () =>
        session.call("resolve_merge_request_discussion", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
          discussion_id: fixture.discussion.id,
          resolved: true,
        }),
      ),
    verifyFinalState: async () => {
      const [mergeRequest, discussions] = await Promise.all([
        session.call("get_merge_request", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
        }),
        session.call("list_merge_request_discussions", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
          page: 1,
          per_page: 100,
        }),
      ]);
      const target = rows(discussions).find(
        (entry) => entry.id === fixture.discussion.id,
      );
      return {
        verified: mergeRequest.state === "opened" && discussionResolved(target),
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await cleanupMergeRequestFixture(session, fixture);
      fixture = undefined;
    },
  };
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
        description: "Disposable benchmark release fixture.",
      });
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        await session.call("get_release", {
          project: session.project,
          tag_name: fixture.tagName,
        });
        await session.call("list_release_asset_links", {
          project: session.project,
          tag_name: fixture.tagName,
        });
      }),
    verifyFinalState: async () => successVerification(),
    finalize: async () => cleanupReleaseFixture(session, fixture),
  };
}

function releaseAssetFlowHandler(session) {
  let fixture;
  return {
    execute: ({ observe, iteration }) =>
      session.measured(observe, async () => {
        const tagName = `bench-${fixtureLabel(
          session,
          "release.asset-flow",
          iteration,
        )}`.slice(0, 120);
        fixture = await createReleaseFixture(session, tagName, {
          assetName: "benchmark-readme",
          assetUrl: session.projectInfo.readme_url,
          description: "Disposable benchmark release flow.",
        });
      }),
    verifyFinalState: async () => {
      const links = await session.call("list_release_asset_links", {
        project: session.project,
        tag_name: fixture.tagName,
      });
      const target = rows(links).find(
        (entry) => entry.id === fixture.assetLink?.id,
      );
      return {
        verified: Boolean(target?.id),
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await cleanupReleaseFixture(session, fixture);
      fixture = undefined;
    },
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
        await session.call("list_environments", {
          project: session.project,
          search: fixture.environmentName,
          page: 1,
          per_page: 20,
        });
        await session.call("list_deployments", {
          project: session.project,
          environment: fixture.environmentName,
          page: 1,
          per_page: 20,
        });
      }),
    verifyFinalState: async () => successVerification(),
    finalize: async () => cleanupDeploymentFixture(session, fixture),
  };
}

export function applyLiveWorkloadOverrides(session, handlers) {
  handlers["issues.update-comment"] = issueUpdateCommentHandler(session);
  handlers["mr.comment"] = commentDiscussionHandler(session);
  handlers["mr.resolve-discussion"] = resolveDiscussionHandler(session);
  handlers["mr.guarded-merge"] = guardedMergeHandler(session);
  handlers["ci.retry-failed"] = retryFailedPipelineHandler(session);
  handlers["release.inspect"] = releaseInspectHandler(session);
  handlers["release.asset-flow"] = releaseAssetFlowHandler(session);
  handlers["deployment.inspect"] = deploymentInspectHandler(session);
  handlers["safety.read-only-mutation"] =
    createReadOnlyMutationBenchmarkHandler();
  handlers["safety.admission-limit"] = createAdmissionLimitBenchmarkHandler();
  return handlers;
}
