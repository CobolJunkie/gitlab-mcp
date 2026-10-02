#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  GitLabClient,
  normalizeGitLabUrl,
} from "../server/src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../server/src/server.mjs";
import {
  createReport,
  addCapability,
  addCleanup,
  finalizeReport,
  writeReport,
  trackedCall,
} from "./integration-report.mjs";
import { validateResolvedDisposableIntegrationProject } from "./lib/disposable-integration-report-gate.mjs";
import { deleteBranchIfPresent } from "./lib/workload-live-fixtures.mjs";

const requestedProject = process.env.GITLAB_INTEGRATION_PROJECT;
const token = process.env.GITLAB_INTEGRATION_DISPOSABLE_TOKEN;
const disposable = process.env.GITLAB_INTEGRATION_DISPOSABLE === "true";

if (!requestedProject || !token || !disposable) {
  console.log(
    "Disposable GitLab MCP integration skipped: set GITLAB_INTEGRATION_PROJECT, GITLAB_INTEGRATION_DISPOSABLE_TOKEN, and GITLAB_INTEGRATION_DISPOSABLE=true for a dedicated throwaway project.",
  );
  process.exit(0);
}

const baseUrl = normalizeGitLabUrl(
  process.env.GITLAB_URL || process.env.CI_SERVER_URL,
);
const commitSha = process.env.CI_COMMIT_SHA || undefined;
const runId = `${Date.now()}-${randomBytes(6).toString("hex")}`;
const branch = `mcp/integration-${runId}`;
const releaseTag = `mcp-integration-release-${runId}`;
const fixturePath = `mcp-integration/${runId}.txt`;
const readPath = process.env.GITLAB_INTEGRATION_READ_PATH || "README.md";
const enableMergeRequest = process.env.GITLAB_INTEGRATION_ENABLE_MR === "true";
const artifactJobId = process.env.GITLAB_INTEGRATION_ARTIFACT_JOB_ID;
const reportDir =
  process.env.CI_PROJECT_DIR || fileURLToPath(new URL("../", import.meta.url));

const report = createReport({ runId, commitSha });

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createGitLabMcpServer({
  clientFactory: () => new GitLabClient({ baseUrl, token, timeoutMs: 15_000 }),
});
const client = new Client({
  name: "gitlab-mcp-disposable-integration",
  version: "0.1.0",
});

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(
    response.isError,
    undefined,
    `${name} failed: ${response.content?.[0]?.text || "unknown MCP error"}`,
  );
  console.log(`GitLab MCP integration check passed: ${name}`);
  return response.structuredContent.result;
}

function toolErrorText(response) {
  return (response.content || [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toolErrorStatus(response) {
  return response.structuredContent?.result?.status;
}

function mutationResponseMayBeAmbiguous(response) {
  const status = toolErrorStatus(response);
  return (
    response.isError === true &&
    (!Number.isInteger(status) ||
      status === 408 ||
      (status >= 500 && status < 600))
  );
}

async function callWithCleanupOwnership(name, args, claimOwnership) {
  const response = await client.callTool({ name, arguments: args });
  if (mutationResponseMayBeAmbiguous(response)) claimOwnership();
  assert.equal(
    response.isError,
    undefined,
    `${name} failed: ${toolErrorText(response) || "unknown MCP error"}`,
  );
  claimOwnership();
  console.log(`GitLab MCP integration check passed: ${name}`);
  return response.structuredContent.result;
}

async function callExpectError(name, args, expectedPattern) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, true, `${name} unexpectedly succeeded.`);
  assert.match(toolErrorText(response), expectedPattern);
  console.log(`GitLab MCP integration guard passed: ${name}`);
  return response;
}

async function callExpectStatus(name, args, expectedStatus) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, true, `${name} unexpectedly succeeded.`);
  assert.equal(
    toolErrorStatus(response),
    expectedStatus,
    `${name} returned an unexpected error status.`,
  );
  console.log(`GitLab MCP integration status check passed: ${name}`);
  return response;
}

async function readPage(name, args) {
  const first = await call(name, { ...args, page: 1, per_page: 1 });
  const nextPage = first.pagination?.nextPage;
  if (nextPage) {
    await call(name, { ...args, page: nextPage, per_page: 1 });
  }
  return first;
}

let project;
let issueIid;
let mergeRequestIid;
let branchCreated = false;
let releaseTagCreated = false;
let releaseCreated = false;

try {
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  // ── Identity & capability probes ──────────────────────────────────
  await trackedCall(
    report,
    "get_gitlab_capabilities",
    () =>
      call("get_gitlab_capabilities", {
        project: requestedProject,
        detailed: true,
      }),
    { category: "identity", required: true },
  );

  // ── Project reads ─────────────────────────────────────────────────
  const projectInfo = await trackedCall(
    report,
    "get_project",
    async () => {
      const info = await call("get_project", { project: requestedProject });
      project = validateResolvedDisposableIntegrationProject(
        info,
        process.env,
      ).projectId;
      return info;
    },
    { category: "project_read", required: true },
  );
  const targetBranch =
    process.env.GITLAB_INTEGRATION_TARGET_BRANCH || projectInfo.default_branch;
  assert.ok(targetBranch, "The disposable project must have a default branch.");

  await trackedCall(
    report,
    "list_repository_tree",
    () => readPage("list_repository_tree", { project, ref: targetBranch }),
    { category: "repository_read", required: true },
  );
  const fixtureFile = await trackedCall(
    report,
    "get_file",
    () =>
      call("get_file", {
        project,
        path: readPath,
        ref: targetBranch,
      }),
    { category: "repository_read", required: true },
  );
  assert.ok(fixtureFile.blob_id, `${readPath} did not return a blob ID.`);
  await trackedCall(
    report,
    "get_blob",
    () => call("get_blob", { project, blob_sha: fixtureFile.blob_id }),
    { category: "repository_read", required: true },
  );

  // ── Issue mutations ───────────────────────────────────────────────
  await trackedCall(
    report,
    "create_issue",
    async () => {
      const createdIssue = await call("create_issue", {
        project,
        title: `Disposable MCP integration ${runId}`,
        description:
          "Created by the disposable release-candidate integration suite.",
      });
      issueIid = createdIssue.iid;
      assert.ok(issueIid, "create_issue did not return an issue IID.");
    },
    { category: "issue_mutation", required: true },
  );
  await trackedCall(
    report,
    "update_issue",
    () =>
      call("update_issue", {
        project,
        issue_iid: issueIid,
        description:
          "Updated by the disposable release-candidate integration suite.",
      }),
    { category: "issue_mutation", required: true },
  );
  await trackedCall(
    report,
    "create_issue_note",
    () =>
      call("create_issue_note", {
        project,
        issue_iid: issueIid,
        body: "Disposable integration comment; this issue is closed during cleanup.",
      }),
    { category: "issue_mutation", required: true },
  );

  // ── Branch & commit mutations ─────────────────────────────────────
  await trackedCall(
    report,
    "create_branch",
    async () => {
      await call("create_branch", {
        project,
        branch,
        ref: targetBranch,
      });
      branchCreated = true;
    },
    { category: "branch_mutation", required: true },
  );
  const safeCommit = await trackedCall(
    report,
    "create_commit",
    () =>
      call("create_commit", {
        project,
        branch,
        commit_message: "test: create disposable integration fixture",
        actions: [
          {
            action: "create",
            file_path: fixturePath,
            content: `disposable integration fixture ${runId}\n`,
          },
        ],
      }),
    { category: "commit_mutation", required: true },
  );
  assert.match(
    safeCommit.id || "",
    /^[0-9a-f]{40}$/i,
    "create_commit did not return a full commit SHA.",
  );

  // ── Merge-request coverage (optional, capability-aware) ───────────
  if (enableMergeRequest) {
    report.flags.mergeRequestCoverage = true;
    report.flags.optionalCoverageEnabled = true;
    await trackedCall(
      report,
      "create_merge_request",
      async () => {
        const mergeRequest = await call("create_merge_request", {
          project,
          source_branch: branch,
          target_branch: targetBranch,
          title: `Draft: disposable MCP integration ${runId}`,
          description:
            "Created only by the disposable release-candidate integration suite.",
        });
        mergeRequestIid = mergeRequest.iid;
        assert.ok(
          mergeRequestIid,
          "create_merge_request did not return an IID.",
        );
      },
      { category: "merge_request_mutation", required: true },
    );
    await trackedCall(
      report,
      "update_merge_request",
      () =>
        call("update_merge_request", {
          project,
          merge_request_iid: mergeRequestIid,
          description:
            "Updated by the disposable release-candidate integration suite.",
        }),
      { category: "merge_request_mutation", required: true },
    );
    await trackedCall(
      report,
      "create_merge_request_discussion",
      () =>
        call("create_merge_request_discussion", {
          project,
          merge_request_iid: mergeRequestIid,
          body: "Disposable integration discussion; the merge request is closed during cleanup.",
        }),
      { category: "merge_request_mutation", required: true },
    );
  } else {
    addCapability(report, "merge_request_mutation", "skipped", {
      reason:
        "Set GITLAB_INTEGRATION_ENABLE_MR=true when the disposable project permits merge-request creation.",
      category: "merge_request_mutation",
      required: false,
    });
    console.log(
      "Merge-request integration skipped: set GITLAB_INTEGRATION_ENABLE_MR=true when the disposable project permits merge-request creation.",
    );
  }

  // ── Destructive commit (fixture cleanup) ──────────────────────────
  const createdFile = await trackedCall(
    report,
    "get_file (fixture for destructive cleanup)",
    () =>
      call("get_file", {
        project,
        path: fixturePath,
        ref: branch,
      }),
    { category: "commit_mutation", required: true },
  );
  assert.ok(
    createdFile.last_commit_id,
    "The fixture file did not return last_commit_id for destructive cleanup.",
  );
  const destructiveUpdate = await trackedCall(
    report,
    "create_destructive_commit (guarded update)",
    () =>
      call("create_destructive_commit", {
        project,
        branch,
        commit_message: "test: update disposable integration fixture",
        start_sha: safeCommit.id,
        actions: [
          {
            action: "update",
            file_path: fixturePath,
            content: `updated disposable integration fixture ${runId}\n`,
            last_commit_id: createdFile.last_commit_id,
          },
        ],
      }),
    { category: "commit_mutation", required: true },
  );
  assert.match(
    destructiveUpdate.id || "",
    /^[0-9a-f]{40}$/i,
    "guarded create_destructive_commit update did not return a full commit SHA.",
  );
  const updatedFile = await trackedCall(
    report,
    "get_file (updated fixture for destructive cleanup)",
    () =>
      call("get_file", {
        project,
        path: fixturePath,
        ref: branch,
      }),
    { category: "commit_mutation", required: true },
  );
  assert.ok(
    updatedFile.last_commit_id,
    "The updated fixture did not return last_commit_id for destructive cleanup.",
  );
  await trackedCall(
    report,
    "create_destructive_commit",
    () =>
      call("create_destructive_commit", {
        project,
        branch,
        commit_message: "test: remove disposable integration fixture",
        start_sha: destructiveUpdate.id,
        actions: [
          {
            action: "delete",
            file_path: fixturePath,
            last_commit_id: updatedFile.last_commit_id,
          },
        ],
      }),
    { category: "commit_mutation", required: true },
  );

  // ── Tag/Release destructive-side-effect coverage ────────────────
  await trackedCall(
    report,
    "create_tag (release-deletion fixture)",
    async () => {
      await callWithCleanupOwnership(
        "create_tag",
        {
          project,
          tag_name: releaseTag,
          ref: targetBranch,
        },
        () => {
          releaseTagCreated = true;
        },
      );
    },
    { category: "release_mutation", required: true },
  );
  await trackedCall(
    report,
    "create_release (tag-deletion fixture)",
    async () => {
      await callWithCleanupOwnership(
        "create_release",
        {
          project,
          tag_name: releaseTag,
          name: `Disposable release ${runId}`,
          description:
            "Created only to verify GitLab tag-deletion collateral Release behavior.",
        },
        () => {
          releaseCreated = true;
        },
      );
    },
    { category: "release_mutation", required: true },
  );
  await trackedCall(
    report,
    "get_tag (associated Release preflight evidence)",
    async () => {
      const tag = await call("get_tag", {
        project,
        tag_name: releaseTag,
      });
      assert.equal(
        tag.release?.tag_name,
        releaseTag,
        "Exact tag read did not expose its associated Release.",
      );
    },
    { category: "release_mutation", required: true },
  );
  await trackedCall(
    report,
    "delete_tag collateral acknowledgement guard",
    () =>
      callExpectError(
        "delete_tag",
        {
          project,
          tag_name: releaseTag,
          acknowledge_tag_deletion: true,
        },
        /acknowledge_associated_release_deletion/,
      ),
    { category: "release_mutation", required: true },
  );
  await trackedCall(
    report,
    "delete_tag with associated Release acknowledgement",
    async () => {
      await call("delete_tag", {
        project,
        tag_name: releaseTag,
        acknowledge_tag_deletion: true,
        acknowledge_associated_release_deletion: true,
      });
    },
    { category: "release_mutation", required: true },
  );
  await trackedCall(
    report,
    "verify tag deletion removed associated Release",
    async () => {
      await callExpectStatus("get_tag", { project, tag_name: releaseTag }, 404);
      await callExpectStatus(
        "get_release",
        { project, tag_name: releaseTag },
        404,
      );
      releaseTagCreated = false;
      releaseCreated = false;
    },
    { category: "release_mutation", required: true },
  );

  // ── Pagination coverage ───────────────────────────────────────────
  await trackedCall(
    report,
    "list_issues",
    () => readPage("list_issues", { project, state: "all" }),
    { category: "pagination", required: true },
  );
  await trackedCall(
    report,
    "list_pipelines",
    () => readPage("list_pipelines", { project }),
    { category: "pagination", required: true },
  );
  await trackedCall(
    report,
    "list_project_jobs",
    () => readPage("list_project_jobs", { project }),
    { category: "pagination", required: true },
  );

  // ── Artifact coverage (optional, capability-aware) ────────────────
  if (artifactJobId) {
    report.flags.artifactCoverage = true;
    report.flags.optionalCoverageEnabled = true;
    await trackedCall(
      report,
      "get_job",
      () => call("get_job", { project, job_id: Number(artifactJobId) }),
      { category: "artifact_retrieval", required: true },
    );
    await trackedCall(
      report,
      "get_job_artifact_archive",
      () =>
        call("get_job_artifact_archive", {
          project,
          job_id: Number(artifactJobId),
          max_bytes: 2_500_000,
        }),
      { category: "artifact_retrieval", required: true },
    );
  } else {
    addCapability(report, "artifact_retrieval", "skipped", {
      reason:
        "Set GITLAB_INTEGRATION_ARTIFACT_JOB_ID to a known small artifact job in the disposable project.",
      category: "artifact_retrieval",
      required: false,
    });
    console.log(
      "Artifact integration skipped: set GITLAB_INTEGRATION_ARTIFACT_JOB_ID to a known small artifact job in the disposable project.",
    );
  }

  // ── Project webhook event-list route validation ──────────────────
  // Exercises the documented webhook-scoped event-list endpoint to
  // confirm the route includes the actual webhook ID.  Creating a
  // real delivery event is impractical in the disposable environment,
  // so we validate the route succeeds (returns an array) and that the
  // response is shaped correctly.  A real GitLab instance returns an
  // empty array when no events exist for the webhook.
  try {
    const webhooks = await call("list_project_webhooks", {
      project,
      page: 1,
      per_page: 1,
    });
    const firstHook = Array.isArray(webhooks?.data) ? webhooks.data[0] : null;
    if (firstHook?.id) {
      const eventsResult = await call("list_project_webhook_events", {
        project,
        webhook_id: firstHook.id,
        page: 1,
        per_page: 1,
      });
      assert.ok(
        Array.isArray(eventsResult?.data),
        "list_project_webhook_events should return an array of events",
      );
      addCapability(report, "webhook_event_list", "passed", {
        reason: `Webhook ${firstHook.id} event-list endpoint returned ${eventsResult.data.length} event(s).`,
        category: "webhook_events",
        required: false,
      });
    } else {
      addCapability(report, "webhook_event_list", "skipped", {
        reason:
          "No webhooks configured in the disposable project; set up a webhook to exercise the event-list route.",
        category: "webhook_events",
        required: false,
      });
    }
  } catch (error) {
    addCapability(report, "webhook_event_list", "failed", {
      reason: `Webhook event-list validation failed: ${error.message}`,
      category: "webhook_events",
      required: false,
    });
  }

  console.log("Disposable GitLab MCP integration suite completed.");
  finalizeReport(report, "success");
} catch (error) {
  finalizeReport(report, "failure");
  console.error(`Disposable integration failed: ${error.message}`);
} finally {
  // ── Cleanup with structured tracking ──────────────────────────────
  if (mergeRequestIid) {
    try {
      await call("update_merge_request", {
        project,
        merge_request_iid: mergeRequestIid,
        state_event: "close",
      });
      addCleanup(report, "merge_request", true);
    } catch (error) {
      addCleanup(
        report,
        "merge_request",
        false,
        String(error.message || error),
      );
      console.error(`Cleanup failed to close merge request: ${error.message}`);
    }
  }
  if (issueIid) {
    try {
      await call("update_issue", {
        project,
        issue_iid: issueIid,
        state_event: "close",
      });
      addCleanup(report, "issue", true);
    } catch (error) {
      addCleanup(report, "issue", false, String(error.message || error));
      console.error(`Cleanup failed to close issue: ${error.message}`);
    }
  }
  if (releaseCreated) {
    try {
      const response = await client.callTool({
        name: "delete_release",
        arguments: {
          project,
          tag_name: releaseTag,
          acknowledge_release_deletion: true,
        },
      });
      const errorText = toolErrorText(response);
      if (response.isError && toolErrorStatus(response) !== 404) {
        addCleanup(
          report,
          "release",
          false,
          errorText || "delete_release cleanup failed",
        );
        console.error(
          `Cleanup failed to delete release: ${errorText || "unknown MCP error"}`,
        );
      } else {
        addCleanup(report, "release", true);
        releaseCreated = false;
      }
    } catch (error) {
      addCleanup(report, "release", false, String(error.message || error));
      console.error(`Cleanup failed to delete release: ${error.message}`);
    }
  }
  if (releaseTagCreated) {
    try {
      const response = await client.callTool({
        name: "delete_tag",
        arguments: {
          project,
          tag_name: releaseTag,
          acknowledge_tag_deletion: true,
          acknowledge_associated_release_deletion: true,
        },
      });
      const errorText = toolErrorText(response);
      if (response.isError && toolErrorStatus(response) !== 404) {
        addCleanup(
          report,
          "tag",
          false,
          errorText || "delete_tag cleanup failed",
        );
        console.error(
          `Cleanup failed to delete tag: ${errorText || "unknown MCP error"}`,
        );
      } else {
        addCleanup(report, "tag", true);
        releaseTagCreated = false;
      }
    } catch (error) {
      addCleanup(report, "tag", false, String(error.message || error));
      console.error(`Cleanup failed to delete tag: ${error.message}`);
    }
  }
  if (branchCreated) {
    try {
      await deleteBranchIfPresent({ project, call }, branch);
      addCleanup(report, "branch", true);
    } catch (error) {
      addCleanup(report, "branch", false, String(error.message || error));
      console.error(`Cleanup failed to delete branch: ${error.message}`);
    }
  }
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);

  // ── Write sanitized report artifact ───────────────────────────────
  try {
    await mkdir(join(reportDir, "integration"), { recursive: true });
    const reportPath = await writeReport(
      report,
      join(reportDir, "integration"),
    );
    console.log(`Integration report written: ${reportPath}`);
  } catch (error) {
    console.error(`Failed to write integration report: ${error.message}`);
  }

  const cleanupFailed = report.cleanup.some((entry) => !entry.cleaned);
  if (report.overallStatus === "failure" || cleanupFailed) {
    if (cleanupFailed) {
      console.error(
        "Disposable integration cleanup failed. See integration report for details.",
      );
    }
    process.exitCode = 1;
  }
}
