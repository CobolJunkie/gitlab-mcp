/**
 * Merge-request tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../gitlab-client.mjs";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import {
  project,
  iid,
  nonEmpty,
  page,
  perPage,
  stringArray,
} from "./schemas.mjs";
import { p, mr } from "./paths.mjs";
import { cleanBody } from "./responses.mjs";

/**
 * Fetch MR metadata and verify the expected head SHA matches.
 *
 * @param {object} client - GitLab API client.
 * @param {string|number} projectValue - Project ID or path.
 * @param {number} mergeRequestIid - MR IID.
 * @param {string} expectedHeadSha - Caller-supplied expected head SHA.
 * @returns {Promise<object>} The MR diff_refs from the GitLab API.
 */
async function validateMrHeadSha(
  client,
  projectValue,
  mergeRequestIid,
  expectedHeadSha,
) {
  const mrResp = (
    await client.request(mr(projectValue, mergeRequestIid), {
      query: {
        include_diverged_commits_count: false,
        include_rebase_in_progress: false,
      },
    })
  ).data;
  const currentHeadSha = mrResp?.diff_refs?.head_sha;
  if (!currentHeadSha) {
    throw new Error(
      "Could not determine the current MR head SHA. The MR may not have any diffs.",
    );
  }
  if (currentHeadSha !== expectedHeadSha) {
    throw new Error(
      `expected_head_sha mismatch: the MR head is "${currentHeadSha}" but the caller expected "${expectedHeadSha}". The MR has changed since the caller last reviewed it. Re-read the MR and retry.`,
    );
  }
  return mrResp;
}

/**
 * Fetch all pages of discussions for the MR.
 *
 * @param {object} client - GitLab API client.
 * @param {string|number} projectValue - Project ID or path.
 * @param {number} mergeRequestIid - MR IID.
 * @returns {Promise<Array<object>>} All discussion objects.
 */
async function fetchAllDiscussions(client, projectValue, mergeRequestIid) {
  let allDiscussions = [];
  let pageNum = 1;
  const perPage = 100;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = (
      await client.request(`${mr(projectValue, mergeRequestIid)}/discussions`, {
        query: { page: pageNum, per_page: perPage },
      })
    ).data;
    if (!Array.isArray(page) || page.length === 0) break;
    allDiscussions = allDiscussions.concat(page);
    if (page.length < perPage) break;
    pageNum += 1;
    // Safety cap: 50 pages = 5000 discussions
    if (pageNum > 50) break;
  }
  return allDiscussions;
}

/**
 * Build a suggestion lookup map from MR discussions.
 *
 * Returns a Map<number, { suggestion, note, discussion }> keyed by suggestion ID.
 *
 * @param {object} client - GitLab API client.
 * @param {string|number} projectValue - Project ID or path.
 * @param {number} mergeRequestIid - MR IID.
 * @returns {Promise<Map<number, object>>} Suggestion lookup map.
 */
async function buildSuggestionMap(client, projectValue, mergeRequestIid) {
  const allDiscussions = await fetchAllDiscussions(
    client,
    projectValue,
    mergeRequestIid,
  );
  const map = new Map();
  for (const discussion of allDiscussions) {
    if (!Array.isArray(discussion.notes)) continue;
    for (const note of discussion.notes) {
      if (!Array.isArray(note.suggestions)) continue;
      for (const suggestion of note.suggestions) {
        map.set(suggestion.id, { suggestion, note, discussion });
      }
    }
  }
  return map;
}

/**
 * Validate a single suggestion against the MR discussions.
 *
 * @param {Map} suggestionMap - Map from suggestion ID to { suggestion, note, discussion }.
 * @param {number} suggestionId - The suggestion ID to validate.
 * @returns {object} The validated suggestion entry.
 * @throws {Error} If the suggestion is not found, already applied, or not applicable.
 */
function validateSuggestion(suggestionMap, suggestionId) {
  const entry = suggestionMap.get(suggestionId);
  if (!entry) {
    throw new Error(
      `Suggestion ${suggestionId} was not found in any discussion of the target merge request.`,
    );
  }
  if (entry.suggestion.applied === true) {
    throw new Error(`Suggestion ${suggestionId} has already been applied.`);
  }
  // "appliable" is the field name used in the discussions API response;
  // "applicable" is used in the suggestions apply response. Check both.
  const isApplicable =
    entry.suggestion.applicable === true || entry.suggestion.appliable === true;
  if (!isApplicable) {
    throw new Error(
      `Suggestion ${suggestionId} is not applicable (the diff position may be stale or the file has changed).`,
    );
  }
  return entry;
}

/**
 * Register merge-request tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerMergeRequestTools(tool) {
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
        ...query
      } = args;
      return client.request(`${p(projectValue)}/merge_requests`, {
        query: cleanBody({
          ...query,
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
        "Merge a GitLab merge request now or when its pipeline succeeds. This changes the target branch.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        sha: z.string().optional(),
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

  // ── Approvals, diffs, commits, pipelines ────────────────────────────

  tool(
    "get_merge_request_approvals",
    {
      title: "Get merge request approvals",
      description:
        "Get approval rules, approvals received, approvals still required, and eligible approvers.",
      inputSchema: {
        project,
        merge_request_iid: iid,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/approvals`,
        )
      ).data,
  );

  tool(
    "approve_merge_request",
    {
      title: "Approve merge request",
      description:
        "Submit the authenticated user's approval for a GitLab merge request.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        sha: z.string().optional(),
        approval_password: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/approve`,
          {
            method: "POST",
            body: cleanBody({
              sha: args.sha,
              approval_password: args.approval_password,
            }),
          },
        )
      ).data,
  );

  tool(
    "unapprove_merge_request",
    {
      title: "Remove merge request approval",
      description:
        "Remove the authenticated user's approval from a GitLab merge request.",
      inputSchema: {
        project,
        merge_request_iid: iid,
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/unapprove`,
          { method: "POST" },
        )
      ).data,
  );

  tool(
    "list_merge_request_diffs",
    {
      title: "List merge request diffs",
      description:
        "Return changed files and patch hunks for a GitLab merge request.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        unidiff: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, merge_request_iid, ...query } = args;
      return client.request(`${mr(projectValue, merge_request_iid)}/diffs`, {
        query,
      });
    },
  );

  tool(
    "get_merge_request_file_patch",
    {
      title: "Get merge request file patch",
      description:
        "Find one exact changed path across paginated merge-request diffs and return its patch metadata and hunks.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        path: nonEmpty,
        unidiff: z.boolean().optional(),
        max_pages: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      let pageNumber = 1;
      for (let checked = 0; checked < args.max_pages; checked += 1) {
        const response = await client.request(
          `${mr(args.project, args.merge_request_iid)}/diffs`,
          {
            query: {
              unidiff: args.unidiff,
              page: pageNumber,
              per_page: 100,
            },
          },
        );
        const match = response.data?.find(
          (diff) => diff.new_path === args.path || diff.old_path === args.path,
        );
        if (match) {
          return match;
        }
        const nextPage = response.pagination?.nextPage;
        if (!nextPage || nextPage === pageNumber) {
          break;
        }
        pageNumber = nextPage;
      }
      throw new Error(
        `Merge request does not contain the exact changed path: ${args.path}`,
      );
    },
  );

  tool(
    "list_merge_request_commits",
    {
      title: "List merge request commits",
      description: "List commits contained in a GitLab merge request.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(`${mr(args.project, args.merge_request_iid)}/commits`, {
        query: { page: args.page, per_page: args.per_page },
      }),
  );

  tool(
    "list_merge_request_pipelines",
    {
      title: "List merge request pipelines",
      description: "List pipelines associated with a GitLab merge request.",
      inputSchema: {
        project,
        merge_request_iid: iid,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/pipelines`,
        )
      ).data,
  );

  // ── Discussion tools ────────────────────────────────────────────────

  tool(
    "list_merge_request_discussions",
    {
      title: "List merge request discussions",
      description:
        "List complete GitLab merge request discussion threads, including resolution state and diff positions.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(
        `${mr(args.project, args.merge_request_iid)}/discussions`,
        { query: { page: args.page, per_page: args.per_page } },
      ),
  );

  tool(
    "create_merge_request_discussion",
    {
      title: "Create merge request discussion",
      description:
        "Create a top-level or inline review thread on a GitLab merge request. Inline comments require the latest diff version SHAs and file position.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        body: nonEmpty,
        position: z
          .object({
            position_type: z.enum(["text", "image", "file"]),
            base_sha: nonEmpty,
            head_sha: nonEmpty,
            start_sha: nonEmpty,
            old_path: z.string().optional(),
            new_path: z.string().optional(),
            old_line: z.number().int().positive().optional(),
            new_line: z.number().int().positive().optional(),
          })
          .optional(),
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/discussions`,
          {
            method: "POST",
            body: cleanBody({ body: args.body, position: args.position }),
          },
        )
      ).data,
  );

  tool(
    "reply_merge_request_discussion",
    {
      title: "Reply to merge request discussion",
      description: "Reply to an existing GitLab merge request review thread.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        discussion_id: nonEmpty,
        body: nonEmpty,
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/discussions/${encodePathSegment(args.discussion_id)}/notes`,
          { method: "POST", body: { body: args.body } },
        )
      ).data,
  );

  tool(
    "resolve_merge_request_discussion",
    {
      title: "Resolve merge request discussion",
      description: "Resolve or reopen a GitLab merge request review thread.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        discussion_id: nonEmpty,
        resolved: z.boolean(),
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/discussions/${encodePathSegment(args.discussion_id)}`,
          { method: "PUT", body: { resolved: args.resolved } },
        )
      ).data,
  );

  tool(
    "update_merge_request_note",
    {
      title: "Update merge request note",
      description:
        "Replace the body of a note or reply inside a GitLab merge request discussion.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        discussion_id: nonEmpty,
        note_id: z.number().int().positive(),
        body: nonEmpty,
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/discussions/${encodePathSegment(args.discussion_id)}/notes/${args.note_id}`,
          { method: "PUT", body: { body: args.body } },
        )
      ).data,
  );

  tool(
    "delete_merge_request_note",
    {
      title: "Delete merge request note",
      description:
        "Permanently delete a note or reply from a GitLab merge request discussion.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        discussion_id: nonEmpty,
        note_id: z.number().int().positive(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${mr(args.project, args.merge_request_iid)}/discussions/${encodePathSegment(args.discussion_id)}/notes/${args.note_id}`,
          { method: "DELETE" },
        )
      ).data,
  );

  // ── Suggestion tools ────────────────────────────────────────────────
  tool(
    "apply_merge_request_suggestion",
    {
      title: "Apply merge request suggestion",
      description:
        "Apply a single GitLab code suggestion by its suggestion ID. Performs preflight validation: confirms the suggestion belongs to the specified project/MR, is still applicable, has not already been applied, and that the MR head SHA matches the caller's expected value. Uses the Suggestions API at PUT /suggestions/:id/apply. Returns the suggestion state including applicable and applied flags. An explicit acknowledgement is required to apply. Note: GitLab's apply endpoint does not accept an expected-head parameter, so a TOCTOU race is possible between preflight and mutation; the server remains authoritative at mutation time.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        suggestion_id: z.number().int().positive(),
        expected_head_sha: z
          .string()
          .min(1)
          .describe(
            "The MR head SHA the caller last reviewed. The tool rejects the mutation if the current MR head differs.",
          ),
        commit_message: z.string().optional(),
        acknowledge: z
          .boolean()
          .describe(
            "Must be true to confirm the suggestion should be applied.",
          ),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      if (!args.acknowledge) {
        throw new Error(
          "Suggestion application requires acknowledge: true to confirm the mutation.",
        );
      }

      // Preflight 1: validate MR head SHA
      await validateMrHeadSha(
        client,
        args.project,
        args.merge_request_iid,
        args.expected_head_sha,
      );

      // Preflight 2: fetch discussions and validate the suggestion
      const suggestionMap = await buildSuggestionMap(
        client,
        args.project,
        args.merge_request_iid,
      );
      validateSuggestion(suggestionMap, args.suggestion_id); // eslint-disable-line await/promise

      // Mutation
      return (
        await client.request(`/suggestions/${args.suggestion_id}/apply`, {
          method: "PUT",
          body: cleanBody({ commit_message: args.commit_message }),
        })
      ).data;
    },
  );

  tool(
    "batch_apply_merge_request_suggestions",
    {
      title: "Batch apply merge request suggestions",
      description:
        "Apply multiple GitLab code suggestions in a single commit using the batch Suggestions API at PUT /suggestions/batch_apply. Performs preflight validation on every suggestion before any mutation: confirms each belongs to the specified project/MR, is still applicable, has not already been applied, and that the MR head SHA matches the caller's expected value. If any suggestion is invalid the entire batch is rejected before calling GitLab's batch-apply endpoint. Returns an array of suggestion states. An explicit acknowledgement is required. Note: GitLab's batch-apply endpoint does not accept an expected-head parameter, so a TOCTOU race is possible between preflight and mutation; the server remains authoritative at mutation time.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(50)
          .describe(
            "Suggestion IDs to apply in a single batch (1–50 suggestions).",
          ),
        expected_head_sha: z
          .string()
          .min(1)
          .describe(
            "The MR head SHA the caller last reviewed. The tool rejects the batch if the current MR head differs.",
          ),
        commit_message: z.string().optional(),
        acknowledge: z
          .boolean()
          .describe(
            "Must be true to confirm the suggestions should be applied.",
          ),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      if (!args.acknowledge) {
        throw new Error(
          "Batch suggestion application requires acknowledge: true to confirm the mutation.",
        );
      }

      // Preflight 1: validate MR head SHA
      await validateMrHeadSha(
        client,
        args.project,
        args.merge_request_iid,
        args.expected_head_sha,
      );

      // Preflight 2: fetch discussions and validate every suggestion
      const suggestionMap = await buildSuggestionMap(
        client,
        args.project,
        args.merge_request_iid,
      );

      const invalidIds = [];
      for (const id of args.ids) {
        try {
          validateSuggestion(suggestionMap, id); // eslint-disable-line await/promise
        } catch (err) {
          invalidIds.push({ id, reason: err.message });
        }
      }

      if (invalidIds.length > 0) {
        throw new Error(
          `Batch rejected: ${invalidIds.length} suggestion(s) failed preflight validation. ${JSON.stringify(invalidIds)}`,
        );
      }

      // Mutation
      return (
        await client.request("/suggestions/batch_apply", {
          method: "PUT",
          body: cleanBody({
            ids: args.ids,
            commit_message: args.commit_message,
          }),
        })
      ).data;
    },
  );

  // ── Reaction tools ──────────────────────────────────────────────────

  tool(
    "list_merge_request_reactions",
    {
      title: "List merge request reactions",
      description:
        "List emoji reactions on a GitLab merge request or one of its notes.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        note_id: z.number().int().positive().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const base = args.note_id
        ? `${mr(args.project, args.merge_request_iid)}/notes/${args.note_id}`
        : mr(args.project, args.merge_request_iid);
      return client.request(`${base}/award_emoji`, {
        query: { page: args.page, per_page: args.per_page },
      });
    },
  );

  tool(
    "add_merge_request_reaction",
    {
      title: "Add merge request reaction",
      description:
        "Add an emoji reaction to a GitLab merge request or one of its notes.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        name: nonEmpty,
        note_id: z.number().int().positive().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const base = args.note_id
        ? `${mr(args.project, args.merge_request_iid)}/notes/${args.note_id}`
        : mr(args.project, args.merge_request_iid);
      return (
        await client.request(`${base}/award_emoji`, {
          method: "POST",
          body: { name: args.name },
        })
      ).data;
    },
  );

  tool(
    "remove_merge_request_reaction",
    {
      title: "Remove merge request reaction",
      description:
        "Remove an emoji reaction from a GitLab merge request or note by award ID.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        award_id: z.number().int().positive(),
        note_id: z.number().int().positive().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const base = args.note_id
        ? `${mr(args.project, args.merge_request_iid)}/notes/${args.note_id}`
        : mr(args.project, args.merge_request_iid);
      return (
        await client.request(`${base}/award_emoji/${args.award_id}`, {
          method: "DELETE",
        })
      ).data;
    },
  );
}
