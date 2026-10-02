/**
 * Guarded native commit cherry-pick workflow.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../../gitlab-client.mjs";
import { WRITE } from "../annotations.mjs";
import { project, nonEmpty } from "../schemas.mjs";
import { p } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";
import { boundedCommitText, boundedRevertCommit } from "./commit-response.mjs";

const MAX_CHERRY_PICK_CHANGE_FILES = 50;
const MAX_CHERRY_PICK_DIFF_EXCERPT = 4_000;

async function requireCherryPickBranchHead(
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
      "Commit cherry-pick rejected because the target branch no longer matches expected_head_sha.",
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

async function requireCherryPickSourceCommit(client, args) {
  const commitPath = `${p(args.project)}/repository/commits/${encodePathSegment(
    args.sha,
  )}`;
  const commit = (await client.request(commitPath)).data;
  if (!Array.isArray(commit?.parent_ids)) {
    throw new TypeError(
      "Commit cherry-pick rejected because GitLab did not return source-commit parent metadata.",
    );
  }
  if (commit.parent_ids.length > 1) {
    throw new GitLabApiError(
      "Commit cherry-pick rejected because merge commits require an explicit mainline parent and GitLab's native cherry-pick API does not expose a mainline selector.",
      {
        status: 400,
        method: "GET",
        path: commitPath,
        response: {
          commit_sha: args.sha,
          parent_shas: commit.parent_ids.slice(0, 8),
        },
      },
    );
  }
}

function boundedCherryPickChange(change) {
  return cleanBody({
    old_path: boundedCommitText(change?.old_path, 1_000),
    new_path: boundedCommitText(change?.new_path, 1_000),
    new_file: change?.new_file === true ? true : undefined,
    renamed_file: change?.renamed_file === true ? true : undefined,
    deleted_file: change?.deleted_file === true ? true : undefined,
    diff_excerpt: boundedCommitText(change?.diff, MAX_CHERRY_PICK_DIFF_EXCERPT),
  });
}

async function readCherryPickChanges(client, projectValue, commitId) {
  const diffPath = `${p(projectValue)}/repository/commits/${encodePathSegment(
    commitId,
  )}/diff`;
  try {
    const response = await client.request(diffPath, {
      query: {
        unidiff: true,
        page: 1,
        per_page: MAX_CHERRY_PICK_CHANGE_FILES,
      },
    });
    const changes = Array.isArray(response.data)
      ? response.data
          .slice(0, MAX_CHERRY_PICK_CHANGE_FILES)
          .map(boundedCherryPickChange)
      : [];
    const changedPaths = [
      ...new Set(
        changes
          .flatMap((change) => [change.new_path, change.old_path])
          .filter((value) => typeof value === "string"),
      ),
    ].slice(0, MAX_CHERRY_PICK_CHANGE_FILES);
    return {
      change_summary_available: true,
      changed_paths: changedPaths,
      changes,
      changes_truncated: Boolean(response.pagination?.nextPage),
    };
  } catch {
    return {
      change_summary_available: false,
      changed_paths: [],
      changes: [],
      changes_truncated: false,
    };
  }
}

async function verifyCherryPickCommit(client, args, cherryPickResult) {
  const commitId = cherryPickResult?.id;
  if (typeof commitId !== "string" || !/^[0-9a-f]{40}$/i.test(commitId)) {
    throw new Error(
      "GitLab accepted the commit cherry-pick request but did not return a full resulting commit SHA. The outcome is ambiguous; re-read the target branch before any further mutation.",
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
      `Commit cherry-pick postcondition is ambiguous after GitLab accepted the cherry-pick: ${message} Re-read the target branch before any further mutation.`,
      { cause: error },
    );
  }

  if (
    !Array.isArray(committed?.parent_ids) ||
    committed.parent_ids.length !== 1 ||
    committed.parent_ids[0] !== args.expected_head_sha
  ) {
    throw new GitLabApiError(
      "Commit cherry-pick completed but the resulting commit does not directly descend from expected_head_sha. The branch may have changed concurrently; re-read it before any further mutation.",
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
      `Commit cherry-pick completed, but the target branch could not be verified afterward: ${message} Re-read it before any further mutation.`,
      { cause: error },
    );
  }
  if (branchResponse.data?.commit?.id !== commitId) {
    throw new GitLabApiError(
      "Commit cherry-pick completed, but the target branch no longer points at the resulting cherry-pick commit. The branch changed concurrently; re-read it before any further mutation.",
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

  return {
    ...boundedRevertCommit(committed),
    ...(await readCherryPickChanges(client, args.project, commitId)),
  };
}

export function registerRepositoryCherryPickTool(tool) {
  // ── Guarded native commit cherry-pick ────────────────────────────────

  tool(
    "cherry_pick_commit",
    {
      title: "Cherry-pick repository commit",
      description:
        "Replay one reviewed non-merge commit onto an existing branch through GitLab's native server-side cherry-pick endpoint. Requires full source-commit and expected branch-head SHAs, validates that the source is not a merge commit, performs GitLab's native dry-run first, rechecks the branch immediately before mutation, and verifies the resulting commit parent and branch pointer afterward. Merge commits are rejected because GitLab's native API exposes no explicit mainline-parent selector.",
      inputSchema: {
        project,
        branch: nonEmpty,
        sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe("Full reviewed SHA of the source commit to cherry-pick."),
        expected_head_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe("Full reviewed target-branch head SHA."),
        message: z
          .string()
          .min(1)
          .max(10_000)
          .optional()
          .describe(
            "Optional custom commit message for the cherry-picked commit.",
          ),
        dry_run: z
          .boolean()
          .default(false)
          .describe(
            "Run GitLab's native cherry-pick dry-run and branch-head guards without creating the cherry-picked commit.",
          ),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      await requireCherryPickBranchHead(
        client,
        args.project,
        args.branch,
        args.expected_head_sha,
      );
      await requireCherryPickSourceCommit(client, args);

      const cherryPickPath = `${p(
        args.project,
      )}/repository/commits/${encodePathSegment(args.sha)}/cherry_pick`;
      const dryRun = (
        await client.request(cherryPickPath, {
          method: "POST",
          body: cleanBody({
            branch: args.branch,
            dry_run: true,
            message: args.message,
          }),
        })
      ).data;
      if (dryRun?.dry_run !== "success") {
        throw new Error(
          "GitLab did not confirm a successful native cherry-pick dry-run; no cherry-pick was attempted.",
        );
      }

      await requireCherryPickBranchHead(
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
          native_cherry_pick_check: "success",
        };
      }

      const cherryPickResult = (
        await client.request(cherryPickPath, {
          method: "POST",
          body: cleanBody({
            branch: args.branch,
            message: args.message,
          }),
        })
      ).data;
      return verifyCherryPickCommit(client, args, cherryPickResult);
    },
  );
}
