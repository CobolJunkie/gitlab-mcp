/**
 * Guarded native commit revert workflow.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../../gitlab-client.mjs";
import { DESTRUCTIVE } from "../annotations.mjs";
import { project, nonEmpty } from "../schemas.mjs";
import { p } from "../paths.mjs";
import { boundedRevertCommit } from "./commit-response.mjs";

async function requireRevertBranchHead(
  client,
  projectValue,
  branch,
  expectedHeadSha,
) {
  const branchPath = `${p(projectValue)}/repository/branches/${encodePathSegment(
    branch,
  )}`;
  const response = await client.request(branchPath);
  const currentHeadSha = response.data?.commit?.id;
  if (currentHeadSha !== expectedHeadSha) {
    throw new GitLabApiError(
      "Commit revert rejected because the target branch no longer matches expected_head_sha.",
      {
        status: 409,
        method: "GET",
        path: branchPath,
        response: {
          expected_head_sha: expectedHeadSha,
          actual_branch_sha: currentHeadSha,
        },
      },
    );
  }
  return branchPath;
}

async function requireRevertCommitInExpectedHistory(client, args) {
  const mergeBasePath = `${p(args.project)}/repository/merge_base`;
  const response = await client.request(mergeBasePath, {
    query: {
      "refs[]": [args.sha, args.expected_head_sha],
    },
  });
  const mergeBaseSha = response.data?.id;
  if (mergeBaseSha !== args.sha) {
    throw new GitLabApiError(
      "Commit revert rejected because sha is not in the reviewed target-branch history at expected_head_sha.",
      {
        status: 409,
        method: "GET",
        path: mergeBasePath,
        response: {
          commit_sha: args.sha,
          expected_head_sha: args.expected_head_sha,
          merge_base_sha: mergeBaseSha,
        },
      },
    );
  }
}

async function verifyRevertCommit(client, args, revertResult) {
  const commitId = revertResult?.id;
  if (typeof commitId !== "string" || !/^[0-9a-f]{40}$/i.test(commitId)) {
    throw new Error(
      "GitLab accepted the commit revert request but did not return a full resulting commit SHA. The outcome is ambiguous; re-read the target branch before any further mutation.",
    );
  }

  const commitPath = `${p(args.project)}/repository/commits/${encodePathSegment(
    commitId,
  )}`;
  let committed;
  try {
    committed = (await client.request(commitPath)).data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Commit revert postcondition is ambiguous after GitLab accepted the revert: ${message} Re-read the target branch before any further mutation.`,
      { cause: error },
    );
  }

  if (
    !Array.isArray(committed?.parent_ids) ||
    committed.parent_ids.length !== 1 ||
    committed.parent_ids[0] !== args.expected_head_sha
  ) {
    throw new GitLabApiError(
      "Commit revert completed but the resulting commit does not directly descend from expected_head_sha. The branch may have changed concurrently; re-read it before any further mutation.",
      {
        status: 409,
        method: "GET",
        path: commitPath,
        response: {
          expected_parent_sha: args.expected_head_sha,
          resulting_commit_sha: commitId,
          actual_parent_shas: committed?.parent_ids,
        },
      },
    );
  }

  const branchPath = `${p(args.project)}/repository/branches/${encodePathSegment(
    args.branch,
  )}`;
  let branchResponse;
  try {
    branchResponse = await client.request(branchPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Commit revert completed, but the target branch could not be verified afterward: ${message} Re-read it before any further mutation.`,
      { cause: error },
    );
  }
  if (branchResponse.data?.commit?.id !== commitId) {
    throw new GitLabApiError(
      "Commit revert completed, but the target branch no longer points at the resulting revert commit. The branch changed concurrently; re-read it before any further mutation.",
      {
        status: 409,
        method: "GET",
        path: branchPath,
        response: {
          resulting_commit_sha: commitId,
          actual_branch_sha: branchResponse.data?.commit?.id,
        },
      },
    );
  }

  return boundedRevertCommit(committed);
}

export function registerRepositoryRevertTool(tool) {
  // ── Guarded native commit revert ────────────────────────────────────

  tool(
    "revert_commit",
    {
      title: "Revert repository commit",
      description:
        "Revert one reviewed commit on an existing branch through GitLab's native server-side revert endpoint. Requires full commit and expected branch-head SHAs, performs GitLab's native dry-run first, rechecks the branch immediately before mutation, and verifies the resulting commit parent and branch pointer afterward. GitLab's revert endpoint does not accept a custom commit message or an atomic expected-head guard, so a detected post-write race is reported for reconciliation rather than rewritten.",
      inputSchema: {
        project,
        branch: nonEmpty,
        sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe("Full reviewed SHA of the commit to revert."),
        expected_head_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe("Full reviewed target-branch head SHA."),
        dry_run: z
          .boolean()
          .default(false)
          .describe(
            "Run GitLab's native revert dry-run and branch-head guards without creating the revert commit.",
          ),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      await requireRevertBranchHead(
        client,
        args.project,
        args.branch,
        args.expected_head_sha,
      );
      await requireRevertCommitInExpectedHistory(client, args);

      const revertPath = `${p(args.project)}/repository/commits/${encodePathSegment(
        args.sha,
      )}/revert`;
      const dryRun = (
        await client.request(revertPath, {
          method: "POST",
          body: { branch: args.branch, dry_run: true },
        })
      ).data;
      if (dryRun?.dry_run !== "success") {
        throw new Error(
          "GitLab did not confirm a successful native revert dry-run; no revert was attempted.",
        );
      }

      await requireRevertBranchHead(
        client,
        args.project,
        args.branch,
        args.expected_head_sha,
      );
      if (args.dry_run) {
        return {
          dry_run: true,
          branch: args.branch,
          commit_sha: args.sha,
          expected_head_sha: args.expected_head_sha,
          native_revert_check: "success",
        };
      }

      const revertResult = (
        await client.request(revertPath, {
          method: "POST",
          body: { branch: args.branch },
        })
      ).data;
      return verifyRevertCommit(client, args, revertResult);
    },
  );
}
