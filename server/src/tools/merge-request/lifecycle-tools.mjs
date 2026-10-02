/**
 * Merge-request lifecycle tools.
 *
 * Owns list/get/create/update/merge/rebase registration while preserving the
 * stable merge-request domain facade.
 */

import * as z from "zod/v4";

import { READ_ONLY, WRITE, DESTRUCTIVE } from "../annotations.mjs";
import {
  project,
  iid,
  nonEmpty,
  page,
  perPage,
  stringArray,
} from "../schemas.mjs";
import { p, mr } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

const reviewedMergeRequestHeadSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/i)
  .describe(
    "Full 40-character SHA of the merge request head that the caller reviewed.",
  );

function parseGitLabMajorVersion(version) {
  const match =
    typeof version === "string"
      ? /^(\d+)\.\d+(?:\.\d+)?(?:[-+].*)?$/.exec(version.trim())
      : null;
  if (!match) {
    throw new TypeError(
      "Cannot safely apply merge-request draft filtering because GitLab returned unrecognized version metadata.",
    );
  }
  const major = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(major)) {
    throw new TypeError(
      "Cannot safely apply merge-request draft filtering because GitLab returned unrecognized version metadata.",
    );
  }
  return major;
}

async function discoverGitLabMajorVersion(client) {
  let receivedMetadata = false;

  for (const path of ["/version", "/metadata"]) {
    try {
      const response = await client.request(path);
      receivedMetadata = true;
      try {
        return parseGitLabMajorVersion(response?.data?.version);
      } catch {
        // Try the alternate documented metadata endpoint before failing closed.
      }
    } catch {
      // Try the alternate documented metadata endpoint before failing closed.
    }
  }

  throw new Error(
    receivedMetadata
      ? "Cannot safely apply merge-request draft filtering because GitLab returned unrecognized version metadata."
      : "Cannot safely apply merge-request draft filtering because GitLab version discovery failed.",
  );
}

async function mergeRequestDraftFilterQuery(client, draft) {
  if (draft === undefined) return {};

  const major = await discoverGitLabMajorVersion(client);
  return major >= 19 ? { draft } : { wip: draft ? "yes" : "no" };
}

/**
 * Register merge-request lifecycle tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerMergeRequestLifecycleTools(tool) {
  // ── Core merge-request tools ────────────────────────────────────────

  tool(
    "list_merge_requests",
    {
      title: "List GitLab merge requests",
      description:
        "List or search merge requests in one GitLab project with common review and triage filters.",
      inputSchema: {
        project,
        state: z
          .enum(["opened", "closed", "locked", "merged", "all"])
          .optional(),
        scope: z.enum(["created_by_me", "assigned_to_me", "all"]).optional(),
        search: z.string().optional(),
        labels: stringArray.optional(),
        source_branch: z.string().optional(),
        target_branch: z.string().optional(),
        author_username: z.string().optional(),
        assignee_username: z.string().optional(),
        reviewer_username: z.string().optional(),
        approved_by_usernames: stringArray.optional(),
        draft: z.boolean().optional(),
        updated_after: z.string().datetime({ offset: true }).optional(),
        updated_before: z.string().datetime({ offset: true }).optional(),
        order_by: z
          .enum(["created_at", "title", "updated_at", "merged_at"])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const {
        project: projectValue,
        labels,
        approved_by_usernames,
        draft,
        ...query
      } = args;
      const draftFilterQuery = await mergeRequestDraftFilterQuery(
        client,
        draft,
      );
      return client.request(`${p(projectValue)}/merge_requests`, {
        query: cleanBody({
          ...query,
          ...draftFilterQuery,
          labels: labels?.join(","),
          "approved_by_usernames[]": approved_by_usernames,
        }),
      });
    },
  );

  tool(
    "get_merge_request",
    {
      title: "Get GitLab merge request",
      description:
        "Get merge request metadata, branches, participants, mergeability, pipeline, approvals, and discussion status.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        include_diverged_commits_count: z.boolean().optional(),
        include_rebase_in_progress: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(mr(args.project, args.merge_request_iid), {
          query: {
            include_diverged_commits_count: args.include_diverged_commits_count,
            include_rebase_in_progress: args.include_rebase_in_progress,
          },
        })
      ).data,
  );

  tool(
    "create_merge_request",
    {
      title: "Create GitLab merge request",
      description:
        "Open a GitLab merge request from an existing source branch. Draft merge requests are supported.",
      inputSchema: {
        project,
        title: nonEmpty,
        source_branch: nonEmpty,
        target_branch: nonEmpty,
        description: z.string().optional(),
        draft: z.boolean().default(false),
        target_project_id: z.number().int().positive().optional(),
        assignee_ids: z.array(z.number().int().positive()).optional(),
        reviewer_ids: z.array(z.number().int().positive()).optional(),
        labels: stringArray.optional(),
        milestone_id: z.number().int().positive().optional(),
        remove_source_branch: z.boolean().optional(),
        squash: z.boolean().optional(),
        allow_collaboration: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, draft, labels, title, ...rest } = args;
      const normalizedTitle =
        draft && !/^draft:\s*/i.test(title) ? `Draft: ${title}` : title;
      return (
        await client.request(`${p(projectValue)}/merge_requests`, {
          method: "POST",
          body: cleanBody({
            ...rest,
            title: normalizedTitle,
            labels: labels?.join(","),
          }),
        })
      ).data;
    },
  );

  tool(
    "update_merge_request",
    {
      title: "Update GitLab merge request",
      description:
        "Update merge request metadata, branches, assignees, reviewers, labels, draft/ready title state, or open/closed state.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        target_branch: z.string().optional(),
        assignee_ids: z.array(z.number().int().positive()).optional(),
        reviewer_ids: z.array(z.number().int().positive()).optional(),
        labels: z.array(z.string()).optional(),
        add_labels: stringArray.optional(),
        remove_labels: stringArray.optional(),
        milestone_id: z.number().int().min(0).optional(),
        remove_source_branch: z.boolean().optional(),
        squash: z.boolean().optional(),
        allow_collaboration: z.boolean().optional(),
        discussion_locked: z.boolean().optional(),
        state_event: z.enum(["close", "reopen"]).optional(),
        draft_event: z.enum(["mark_as_draft", "mark_as_ready"]).optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const {
        project: projectValue,
        merge_request_iid,
        labels,
        add_labels,
        remove_labels,
        draft_event,
        ...body
      } = args;
      let currentMergeRequest;
      if (draft_event) {
        if (!body.title) {
          currentMergeRequest = (
            await client.request(mr(projectValue, merge_request_iid))
          ).data;
        }
        const sourceTitle = body.title || currentMergeRequest.title;
        const isDraft = /^draft:\s*/i.test(sourceTitle);
        if (draft_event === "mark_as_draft") {
          body.title = isDraft ? sourceTitle : `Draft: ${sourceTitle}`;
        } else {
          body.title = sourceTitle.replace(/^draft:\s*/i, "");
        }
      }
      const updateBody = cleanBody({
        ...body,
        labels: labels?.join(","),
        add_labels: add_labels?.join(","),
        remove_labels: remove_labels?.join(","),
      });
      if (Object.keys(updateBody).length === 0) {
        return (
          currentMergeRequest ||
          (await client.request(mr(projectValue, merge_request_iid))).data
        );
      }
      return (
        await client.request(mr(projectValue, merge_request_iid), {
          method: "PUT",
          body: updateBody,
        })
      ).data;
    },
  );

  tool(
    "merge_merge_request",
    {
      title: "Merge GitLab merge request",
      description:
        "Merge a GitLab merge request now or when its pipeline succeeds. This changes the target branch. Requires the exact full head SHA that was reviewed; GitLab rejects the merge if the MR has advanced.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        sha: reviewedMergeRequestHeadSha,
        squash: z.boolean().optional(),
        should_remove_source_branch: z.boolean().optional(),
        merge_when_pipeline_succeeds: z.boolean().optional(),
        auto_merge: z.boolean().optional(),
        merge_commit_message: z.string().optional(),
        squash_commit_message: z.string().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const { project: projectValue, merge_request_iid, ...body } = args;
      return (
        await client.request(`${mr(projectValue, merge_request_iid)}/merge`, {
          method: "PUT",
          body: cleanBody(body),
        })
      ).data;
    },
  );

  tool(
    "rebase_merge_request",
    {
      title: "Rebase GitLab merge request",
      description:
        "Enqueue a GitLab rebase for the merge request source branch. Use get_merge_request with include_rebase_in_progress to poll the result. Only available when the source branch is a fast-forward of the target.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        skip_ci: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, merge_request_iid, ...body } = args;
      return (
        await client.request(`${mr(projectValue, merge_request_iid)}/rebase`, {
          method: "PUT",
          body: cleanBody(body),
        })
      ).data;
    },
  );
}
