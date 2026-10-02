import assert from "node:assert/strict";

import {
  cleanupMergeRequestFixture,
  cleanupPipelineFixture,
  closeIssue,
  createMergeRequestFixture,
  createPipelineFixture,
  fixtureLabel,
  waitForPipeline,
} from "./workload-live-fixtures.mjs";

const FAILURE_CI = `image: node:22-alpine\nstages: [test]\nbenchmark_failure:\n  stage: test\n  script:\n    - echo BENCHMARK_EXPECTED_FAILURE\n    - exit 7\n`;
const README_MARKER = "GitLab Codex Plugin Disposable Integration";
const BENCHMARK_ISSUE_DESCRIPTION =
  "Disposable GitLab MCP benchmark issue fixture.";

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

function successVerification() {
  return { verified: true, forbiddenEffectsObserved: [] };
}

function resolveProjectHandler(session) {
  return {
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const search = await session.call("search_projects", {
          search: "gitlab-codex-plugin",
          page: 1,
          per_page: 100,
        });
        const projects = rows(search);
        const match = projects.find(
          (project) => project.path_with_namespace === session.projectPath,
        );
        assert.ok(
          match,
          "Disposable project was not resolvable through search.",
        );
        assert.equal(String(match.id), String(session.project));

        const project = await session.call("get_project", {
          project: session.projectPath,
        });
        assert.equal(String(project?.id), String(session.project));
        assert.equal(project?.path_with_namespace, session.projectPath);
        assert.equal(project?.default_branch, session.defaultBranch);
      }),
    verifyFinalState: async () => successVerification(),
  };
}

function capabilitiesHandler(session) {
  return {
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const result = await session.call("get_gitlab_capabilities", {
          project: session.project,
          detailed: true,
        });
        assert.equal(result?.schemaVersion, 1);
        assert.equal(
          result?.capabilities?.authenticated_api?.state,
          "available",
        );
        assert.ok(result?.probes && typeof result.probes === "object");
      }),
    verifyFinalState: async () => successVerification(),
  };
}

function identityHandler(session) {
  return {
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const user = await session.call("get_current_user");
        assert.ok(
          Number.isSafeInteger(user?.id) && user.id > 0,
          "Benchmark identity must include a positive user ID.",
        );
        assert.ok(
          typeof user?.username === "string" && user.username.trim() !== "",
          "Benchmark identity must include a username.",
        );
      }),
    verifyFinalState: async () => successVerification(),
  };
}

function inspectTreeFileHandler(session) {
  return {
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const tree = await session.call("list_repository_tree", {
          project: session.project,
          ref: session.defaultBranch,
          page: 1,
          per_page: 100,
        });
        assert.equal(
          rows(tree).some((entry) => entry.path === "README.md"),
          true,
          "Benchmark repository tree did not include README.md.",
        );
        const file = await session.call("get_file", {
          project: session.project,
          path: "README.md",
          ref: session.defaultBranch,
          decode_text: true,
          start_line: 1,
          end_line: 10,
        });
        assert.equal(typeof file?.content, "string");
        assert.equal(file.content.includes(README_MARKER), true);
      }),
    verifyFinalState: async () => successVerification(),
  };
}

function issueCreateHandler(session) {
  let issue;
  let expectedTitle;
  return {
    execute: ({ observe, iteration }) =>
      session.measured(observe, async () => {
        expectedTitle = `BENCH fixture ${fixtureLabel(
          session,
          "issues.create",
          iteration,
        )}`;
        issue = await session.call("create_issue", {
          project: session.project,
          title: expectedTitle,
          description: BENCHMARK_ISSUE_DESCRIPTION,
        });
      }),
    verifyFinalState: async () => {
      const current = await session.call("get_issue", {
        project: session.project,
        issue_iid: issue.iid,
      });
      return {
        verified:
          current?.iid === issue.iid &&
          current?.state === "opened" &&
          current?.title === expectedTitle,
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await closeIssue(session, issue?.iid);
      issue = undefined;
      expectedTitle = undefined;
    },
  };
}

function mergeReadinessHandler(session) {
  let fixture;
  return {
    prepare: async () => {
      fixture = await createMergeRequestFixture(
        session,
        fixtureLabel(session, "mr.merge-readiness"),
        { draft: true },
      );
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const mergeRequest = await session.call("get_merge_request", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
        });
        const approvals = await session.call("get_merge_request_approvals", {
          project: session.project,
          merge_request_iid: fixture.mergeRequest.iid,
        });
        assert.equal(mergeRequest?.state, "opened");
        assert.equal(mergeRequest?.source_branch, fixture.source);
        assert.equal(mergeRequest?.target_branch, fixture.base);
        assert.equal(
          mergeRequest?.draft === true ||
            mergeRequest?.work_in_progress === true,
          true,
          "Benchmark readiness fixture must remain deterministically blocked as draft.",
        );
        assert.ok(approvals && typeof approvals === "object");
      }),
    verifyFinalState: async () => {
      const current = await session.call("get_merge_request", {
        project: session.project,
        merge_request_iid: fixture.mergeRequest.iid,
      });
      return {
        verified:
          current?.state === "opened" &&
          current?.source_branch === fixture.source &&
          current?.target_branch === fixture.base &&
          (current?.draft === true || current?.work_in_progress === true),
        forbiddenEffectsObserved: [],
      };
    },
    finalize: async () => cleanupMergeRequestFixture(session, fixture),
  };
}

function retryFailedPipelineHandler(session) {
  let fixture;
  let originalJobIds;
  let retried;
  return {
    setup: async ({ iteration }) => {
      fixture = await createPipelineFixture(
        session,
        fixtureLabel(session, "ci.retry-failed", iteration),
        FAILURE_CI,
      );
      await waitForPipeline(session, fixture.pipeline.id, "failed");
      const originalJobs = await session.call("list_pipeline_jobs", {
        project: session.project,
        pipeline_id: fixture.pipeline.id,
        include_retried: true,
        page: 1,
        per_page: 100,
      });
      originalJobIds = new Set(
        rows(originalJobs)
          .map((job) => job?.id)
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      );
      assert.ok(
        originalJobIds.size > 0,
        "Benchmark retry fixture must contain an original pipeline job.",
      );
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        retried = await session.call("retry_pipeline", {
          project: session.project,
          pipeline_id: fixture.pipeline.id,
        });
      }),
    verifyFinalState: async () => {
      if (retried?.id !== fixture.pipeline.id) {
        return { verified: false, forbiddenEffectsObserved: [] };
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const jobs = await session.call("list_pipeline_jobs", {
          project: session.project,
          pipeline_id: fixture.pipeline.id,
          include_retried: true,
          page: 1,
          per_page: 100,
        });
        const newJobObserved = rows(jobs).some(
          (job) => Number.isSafeInteger(job?.id) && !originalJobIds.has(job.id),
        );
        if (newJobObserved) {
          return { verified: true, forbiddenEffectsObserved: [] };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { verified: false, forbiddenEffectsObserved: [] };
    },
    cleanup: async () => {
      await cleanupPipelineFixture(session, fixture);
      fixture = undefined;
      originalJobIds = undefined;
      retried = undefined;
    },
  };
}

export function applyVerificationWorkloadOverrides(session, handlers) {
  handlers["context.resolve-project"] = resolveProjectHandler(session);
  handlers["context.capabilities"] = capabilitiesHandler(session);
  handlers["context.identity"] = identityHandler(session);
  handlers["repository.inspect-tree-file"] = inspectTreeFileHandler(session);
  handlers["issues.create"] = issueCreateHandler(session);
  handlers["mr.merge-readiness"] = mergeReadinessHandler(session);
  handlers["ci.retry-failed"] = retryFailedPipelineHandler(session);
  return handlers;
}
