/**
 * Repository branch lifecycle tools and deletion safeguards.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../../gitlab-client.mjs";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "../annotations.mjs";
import { project, nonEmpty, page, perPage } from "../schemas.mjs";
import { p } from "../paths.mjs";

function escapeBranchRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function branchDeletionContext(args) {
  const branchesPath = `${p(args.project)}/repository/branches`;
  return {
    branchesPath,
    branchPath: `${branchesPath}/${encodePathSegment(args.branch)}`,
    exactBranchRegex: `^${escapeBranchRegex(args.branch)}$`,
  };
}

function branchDeletionAbsentResult(args, outcome, changed) {
  return {
    branch: args.branch,
    expected_head_sha: args.expected_head_sha,
    state: "absent",
    outcome,
    changed,
    atomicity: "preflight_guarded_non_atomic",
  };
}

function branchDeletionErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function branchDeletionConflict(args, context, message, actualBranchSha) {
  return new GitLabApiError(message, {
    status: 409,
    method: "GET",
    path: context.branchPath,
    response: {
      expected_head_sha: args.expected_head_sha,
      actual_branch_sha: actualBranchSha,
    },
  });
}

async function confirmBranchAbsent(client, args, context) {
  const confirmation = await client.request(context.branchesPath, {
    query: {
      regex: context.exactBranchRegex,
      page: 1,
      per_page: 1,
    },
  });
  if (!Array.isArray(confirmation.data)) {
    throw new TypeError(
      "GitLab returned an invalid branch-list response while confirming branch absence.",
    );
  }
  const visible = confirmation.data.find(
    (entry) => entry?.name === args.branch,
  );
  if (visible) {
    throw new GitLabApiError(
      "Branch deletion cannot confirm absence because the branch is visible again.",
      {
        status: 409,
        method: "GET",
        path: context.branchesPath,
        response: {
          expected_head_sha: args.expected_head_sha,
          actual_branch_sha: visible.commit?.id,
        },
      },
    );
  }
}

async function requireDeleteBranchExpectedHead(client, args, context) {
  let response;
  try {
    response = await client.request(context.branchPath);
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 404) {
      await confirmBranchAbsent(client, args, context);
      return false;
    }
    throw error;
  }
  const currentHeadSha = response.data?.commit?.id;
  if (
    typeof currentHeadSha !== "string" ||
    currentHeadSha.toLowerCase() !== args.expected_head_sha.toLowerCase()
  ) {
    throw branchDeletionConflict(
      args,
      context,
      "Branch deletion rejected because the target branch no longer matches expected_head_sha.",
      currentHeadSha,
    );
  }
  return true;
}

async function throwAmbiguousBranchDeleteOutcome(
  client,
  args,
  context,
  deleteError,
) {
  const deleteMessage = branchDeletionErrorMessage(deleteError);
  let postflight;
  try {
    postflight = await client.request(context.branchPath);
  } catch (postflightError) {
    if (
      postflightError instanceof GitLabApiError &&
      postflightError.status === 404
    ) {
      try {
        await confirmBranchAbsent(client, args, context);
      } catch (confirmationError) {
        const confirmationMessage =
          branchDeletionErrorMessage(confirmationError);
        throw new Error(
          `Branch deletion outcome is ambiguous because GitLab did not provide a definitive DELETE response (${deleteMessage}) and absence could not be confirmed: ${confirmationMessage} Re-read the repository and branch before any retry or further mutation.`,
          { cause: deleteError },
        );
      }
      throw new Error(
        `Branch deletion outcome is ambiguous because GitLab did not provide a definitive DELETE response (${deleteMessage}), although the branch is currently confirmed absent. Do not infer whether this request deleted it; re-read before any retry or further mutation.`,
        { cause: deleteError },
      );
    }
    const postflightMessage = branchDeletionErrorMessage(postflightError);
    throw new Error(
      `Branch deletion outcome is ambiguous because GitLab did not provide a definitive DELETE response (${deleteMessage}) and postflight verification failed: ${postflightMessage} Re-read the branch before any retry or further mutation.`,
      { cause: deleteError },
    );
  }

  if (postflight.data == null) {
    throw new Error(
      `Branch deletion outcome is ambiguous because GitLab did not provide a definitive DELETE response (${deleteMessage}) and the successful postflight response was empty. Re-read the branch before any retry or further mutation.`,
      { cause: deleteError },
    );
  }

  throw new Error(
    `Branch deletion outcome is ambiguous because GitLab did not provide a definitive DELETE response (${deleteMessage}); the branch is currently present or was recreated concurrently. Re-read it before any retry or further mutation.`,
    { cause: deleteError },
  );
}

async function reconcileDeleteBranchNotFound(client, args, context) {
  let postflight;
  try {
    postflight = await client.request(context.branchPath);
  } catch (postflightError) {
    if (
      postflightError instanceof GitLabApiError &&
      postflightError.status === 404
    ) {
      try {
        await confirmBranchAbsent(client, args, context);
      } catch (repositoryError) {
        const message = branchDeletionErrorMessage(repositoryError);
        throw new Error(
          `Branch deletion outcome is ambiguous after GitLab returned 404 for both deletion and branch verification because repository readability could not be confirmed: ${message} Re-read the repository and branch before any further mutation.`,
          { cause: repositoryError },
        );
      }
      return branchDeletionAbsentResult(
        args,
        "already_absent_after_preflight",
        false,
      );
    }
    const message = branchDeletionErrorMessage(postflightError);
    throw new Error(
      `Branch deletion outcome is ambiguous after GitLab returned 404 for the deletion request: ${message} Re-read the branch before any further mutation.`,
      { cause: postflightError },
    );
  }

  throw branchDeletionConflict(
    args,
    context,
    postflight.data == null
      ? "Branch deletion request returned 404, but a successful empty postflight response does not prove the branch is absent. Re-read it before any further mutation."
      : "Branch deletion request returned 404, but the branch is still present or was recreated concurrently. Re-read it before any further mutation.",
    postflight.data?.commit?.id,
  );
}

async function verifyBranchDeletionPostcondition(client, args, context) {
  try {
    const postflight = await client.request(context.branchPath);
    if (postflight.data == null) {
      throw new Error(
        "GitLab returned a successful empty postflight response, which does not prove the branch is absent.",
      );
    }
    throw branchDeletionConflict(
      args,
      context,
      "Branch deletion completed, but the branch is still present or was recreated concurrently. Re-read it before any further mutation.",
      postflight.data?.commit?.id,
    );
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 404) {
      try {
        await confirmBranchAbsent(client, args, context);
      } catch (repositoryError) {
        const message = branchDeletionErrorMessage(repositoryError);
        throw new Error(
          `Branch deletion postcondition is ambiguous after GitLab accepted the deletion because repository readability could not be confirmed: ${message} Re-read the repository and branch before any further mutation.`,
          { cause: repositoryError },
        );
      }
      return branchDeletionAbsentResult(args, "deleted", true);
    }
    if (error instanceof GitLabApiError && error.status === 409) {
      throw error;
    }
    const message = branchDeletionErrorMessage(error);
    throw new Error(
      `Branch deletion postcondition is ambiguous after GitLab accepted the deletion: ${message} Re-read the branch before any further mutation.`,
      { cause: error },
    );
  }
}

function isDefinitiveBranchDeleteRejection(status) {
  return (
    Number.isInteger(status) && status >= 400 && status < 500 && status !== 408
  );
}

async function deleteReviewedBranch(client, args) {
  const context = branchDeletionContext(args);
  if (!(await requireDeleteBranchExpectedHead(client, args, context))) {
    return branchDeletionAbsentResult(args, "already_absent", false);
  }
  if (!(await requireDeleteBranchExpectedHead(client, args, context))) {
    return branchDeletionAbsentResult(
      args,
      "already_absent_after_preflight",
      false,
    );
  }

  try {
    await client.request(context.branchPath, { method: "DELETE" });
  } catch (error) {
    const status = error instanceof GitLabApiError ? error.status : undefined;
    if (status === 404) {
      return reconcileDeleteBranchNotFound(client, args, context);
    }
    if (isDefinitiveBranchDeleteRejection(status)) {
      throw error;
    }
    await throwAmbiguousBranchDeleteOutcome(client, args, context, error);
  }

  return verifyBranchDeletionPostcondition(client, args, context);
}

/**
 * Register repository tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */

export function registerRepositoryBranchTools(tool) {
  // ── Branch and commit read tools ──────────────────────────────────────

  tool(
    "list_branches",
    {
      title: "List repository branches",
      description: "List or search branches in a GitLab project.",
      inputSchema: {
        project,
        search: z.string().optional(),
        regex: z.string().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/repository/branches`, {
        query,
      });
    },
  );

  tool(
    "create_branch",
    {
      title: "Create repository branch",
      description:
        "Create a branch from an existing branch, tag, or commit SHA.",
      inputSchema: {
        project,
        branch: nonEmpty,
        ref: nonEmpty,
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(`${p(args.project)}/repository/branches`, {
          method: "POST",
          query: { branch: args.branch, ref: args.ref },
        })
      ).data,
  );

  tool(
    "delete_branch",
    {
      title: "Delete repository branch",
      description:
        "Delete one exact reviewed GitLab repository branch. Requires the full reviewed branch-head SHA and explicit acknowledgement, rechecks the branch immediately before GitLab's name-based DELETE, then verifies absence afterward. GitLab does not provide atomic delete-if-head-equals semantics, so ambiguous post-delete state fails closed and must be reconciled. Protected/default branch restrictions remain GitLab-authoritative.",
      inputSchema: {
        project,
        branch: nonEmpty,
        expected_head_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe("Full reviewed head SHA of the branch to delete."),
        acknowledge_branch_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    deleteReviewedBranch,
  );
}
