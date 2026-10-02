/**
 * Merge-request discussion and reaction tools.
 *
 * Discussion and reaction registration is exported separately so the stable
 * facade can preserve the canonical tool order around suggestion tools.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../../gitlab-client.mjs";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "../annotations.mjs";
import { project, iid, nonEmpty, page, perPage } from "../schemas.mjs";
import { mr } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

/**
 * Register merge-request discussion tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerMergeRequestDiscussionTools(tool) {
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
}

/**
 * Register merge-request reaction tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerMergeRequestReactionTools(tool) {
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
