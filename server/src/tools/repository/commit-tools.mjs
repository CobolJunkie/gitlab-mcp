/**
 * Repository commit creation tools, including destructive commit safeguards.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../../gitlab-client.mjs";
import { WRITE, DESTRUCTIVE } from "../annotations.mjs";
import { project, nonEmpty } from "../schemas.mjs";
import { p } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

export function registerRepositoryCommitTools(tool) {
  // ── Safe commit creation ──────────────────────────────────────────────

  const safeCommitAction = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create"),
      file_path: nonEmpty,
      content: z.string(),
      encoding: z.enum(["text", "base64"]).optional(),
      execute_filemode: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("update"),
      file_path: nonEmpty,
      content: z.string(),
      encoding: z.enum(["text", "base64"]).optional(),
      last_commit_id: nonEmpty
        .optional()
        .describe(
          "Reviewed file commit ID required by create_commit and by non-force create_destructive_commit; optional only when force=true intentionally replaces history from start_sha.",
        ),
      execute_filemode: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("move"),
      file_path: nonEmpty,
      previous_path: nonEmpty,
      content: z.string().optional(),
      encoding: z.enum(["text", "base64"]).optional(),
      last_commit_id: nonEmpty
        .optional()
        .describe(
          "Reviewed file commit ID required by create_commit and by non-force create_destructive_commit; optional only when force=true intentionally replaces history from start_sha.",
        ),
    }),
    z.object({
      action: z.literal("chmod"),
      file_path: nonEmpty,
      execute_filemode: z.boolean(),
    }),
  ]);

  tool(
    "create_commit",
    {
      title: "Create repository commit",
      description:
        "Create one GitLab commit containing non-destructive atomic create, update, move, or chmod actions. update and move require a per-file last_commit_id to guard against concurrent overwrites. Do not supply both start_branch and start_sha; use start_branch for new-branch creation only.",
      inputSchema: {
        project,
        branch: nonEmpty,
        commit_message: nonEmpty,
        actions: z.array(safeCommitAction).min(1).max(100),
        start_branch: z.string().optional(),
        start_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .optional()
          .describe(
            "Full 40-character commit SHA for new-branch creation. Mutually exclusive with start_branch.",
          ),
        author_email: z.string().email().optional(),
        author_name: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const {
        project: projectValue,
        start_branch: startBranch,
        start_sha: startSha,
        actions,
        ...rest
      } = args;
      if (startBranch && startSha) {
        throw new Error(
          "create_commit does not accept both start_branch and start_sha. Use start_branch for new-branch creation only.",
        );
      }
      if (startSha) {
        const branchPath = `${p(projectValue)}/repository/branches/${encodePathSegment(args.branch)}`;
        let branchExists = false;
        try {
          await client.request(branchPath);
          branchExists = true;
        } catch (error) {
          if (!(error instanceof GitLabApiError) || error.status !== 404) {
            throw error;
          }
        }
        if (branchExists) {
          throw new Error(
            `create_commit start_sha is only valid when creating a new branch. Branch '${args.branch}' already exists; omit start_sha and use last_commit_id guards for existing-branch update or move actions.`,
          );
        }
      }
      for (const action of actions) {
        if (
          action.action !== "create" &&
          action.action !== "chmod" &&
          (!action.last_commit_id || action.last_commit_id === "")
        ) {
          throw new Error(
            `${action.action} action on '${action.file_path}' requires last_commit_id to prevent concurrent overwrites.`,
          );
        }
      }
      return (
        await client.request(`${p(projectValue)}/repository/commits`, {
          method: "POST",
          body: cleanBody({
            ...rest,
            actions,
            start_branch: startBranch,
            start_sha: startSha,
          }),
        })
      ).data;
    },
  );

  // ── Destructive commit creation ───────────────────────────────────────

  const destructiveCommitAction = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("delete"),
      file_path: nonEmpty,
      last_commit_id: nonEmpty.describe(
        "Current file commit ID required to prevent deleting a concurrently changed file.",
      ),
    }),
    ...safeCommitAction.options,
  ]);

  tool(
    "create_destructive_commit",
    {
      title: "Create destructive repository commit",
      description:
        "Create one GitLab commit that can delete files or force a branch update. In non-force mode, the branch tip must match start_sha and update/move actions require reviewed last_commit_id guards that are forwarded to GitLab unchanged. In force=true mode, start_sha is the explicit replacement parent and update/move may omit last_commit_id because replacing history after the reviewed SHA is intentional. Delete actions always require last_commit_id.",
      outputSchema: {
        result: z
          .unknown()
          .describe(
            "Created destructive GitLab commit, including its commit ID, SHA, and affected file actions when GitLab returns them.",
          ),
      },
      inputSchema: {
        project,
        branch: nonEmpty,
        commit_message: nonEmpty,
        actions: z.array(destructiveCommitAction).min(1).max(100),
        start_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe(
            "Reviewed commit SHA from which GitLab must apply this destructive change.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Allow GitLab to force the branch update from start_sha. In force mode, update/move last_commit_id is optional because commits after the reviewed start_sha may be intentionally replaced; delete actions still require it.",
          ),
        author_email: z.string().email().optional(),
        author_name: z.string().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const {
        project: projectValue,
        start_sha: startSha,
        force,
        ...body
      } = args;
      if (!force) {
        for (const action of body.actions) {
          if (
            (action.action === "update" || action.action === "move") &&
            !action.last_commit_id
          ) {
            throw new Error(
              `${action.action} action on '${action.file_path}' requires last_commit_id for non-force create_destructive_commit to prevent concurrent overwrites.`,
            );
          }
        }
        const branchPath = `${p(projectValue)}/repository/branches/${encodePathSegment(args.branch)}`;
        const branch = await client.request(branchPath);
        if (branch.data?.commit?.id !== startSha) {
          throw new GitLabApiError(
            "Destructive commit rejected because the target branch no longer matches start_sha.",
            {
              status: 409,
              method: "GET",
              path: branchPath,
              response: {
                expected_start_sha: startSha,
                actual_branch_sha: branch.data?.commit?.id,
              },
            },
          );
        }
      }
      return (
        await client.request(`${p(projectValue)}/repository/commits`, {
          method: "POST",
          body: cleanBody(
            force ? { ...body, start_sha: startSha, force } : body,
          ),
        })
      ).data;
    },
  );
}
