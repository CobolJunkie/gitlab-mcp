/**
 * Issue, issue-note, and issue-reaction tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import {
  project,
  iid,
  nonEmpty,
  page,
  perPage,
  stringArray,
} from "./schemas.mjs";
import { p, issue } from "./paths.mjs";
import { cleanBody } from "./responses.mjs";

/**
 * Register issue-domain tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerIssueTools(tool) {
  // ── Core issue tools ────────────────────────────────────────────────

  tool(
    "list_global_issues",
    {
      title: "List accessible GitLab issues",
      description:
        "List recent issues across all projects visible to the connected user, with account-wide triage filters.",
      inputSchema: {
        state: z.enum(["opened", "closed", "all"]).optional(),
        scope: z
          .enum(["created_by_me", "assigned_to_me", "all"])
          .default("all"),
        search: z.string().optional(),
        labels: stringArray.optional(),
        assignee_username: stringArray.optional(),
        author_username: z.string().optional(),
        milestone: z.string().optional(),
        confidential: z.boolean().optional(),
        created_after: z.string().datetime({ offset: true }).optional(),
        created_before: z.string().datetime({ offset: true }).optional(),
        updated_after: z.string().datetime({ offset: true }).optional(),
        updated_before: z.string().datetime({ offset: true }).optional(),
        order_by: z
          .enum([
            "created_at",
            "updated_at",
            "priority",
            "due_date",
            "relative_position",
            "label_priority",
            "milestone_due",
            "popularity",
            "weight",
          ])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { labels, assignee_username, ...query } = args;
      return client.request("/issues", {
        query: cleanBody({
          ...query,
          labels: labels?.join(","),
          "assignee_username[]": assignee_username,
        }),
      });
    },
  );

  tool(
    "list_issues",
    {
      title: "List GitLab issues",
      description:
        "List or search issues in one GitLab project with common triage filters.",
      inputSchema: {
        project,
        state: z.enum(["opened", "closed", "all"]).optional(),
        scope: z.enum(["created_by_me", "assigned_to_me", "all"]).optional(),
        search: z.string().optional(),
        labels: stringArray.optional(),
        assignee_username: stringArray.optional(),
        author_username: z.string().optional(),
        milestone: z.string().optional(),
        confidential: z.boolean().optional(),
        updated_after: z.string().datetime({ offset: true }).optional(),
        updated_before: z.string().datetime({ offset: true }).optional(),
        order_by: z
          .enum([
            "created_at",
            "updated_at",
            "priority",
            "due_date",
            "relative_position",
            "label_priority",
            "milestone_due",
            "popularity",
            "weight",
          ])
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
        assignee_username,
        ...query
      } = args;
      return client.request(`${p(projectValue)}/issues`, {
        query: cleanBody({
          ...query,
          labels: labels?.join(","),
          "assignee_username[]": assignee_username,
        }),
      });
    },
  );

  tool(
    "get_issue",
    {
      title: "Get GitLab issue",
      description:
        "Get one GitLab issue with labels, assignees, milestone, task status, and links.",
      inputSchema: {
        project,
        issue_iid: iid,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (await client.request(issue(args.project, args.issue_iid))).data,
  );

  tool(
    "create_issue",
    {
      title: "Create GitLab issue",
      description:
        "Create a GitLab issue with optional description, assignees, labels, milestone, due date, and confidentiality.",
      inputSchema: {
        project,
        title: nonEmpty,
        description: z.string().optional(),
        assignee_ids: z.array(z.number().int().positive()).optional(),
        labels: stringArray.optional(),
        milestone_id: z.number().int().positive().optional(),
        due_date: z.string().date().optional(),
        confidential: z.boolean().optional(),
        issue_type: z
          .enum(["issue", "incident", "test_case", "task"])
          .optional(),
        weight: z.number().int().min(0).optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, labels, ...body } = args;
      return (
        await client.request(`${p(projectValue)}/issues`, {
          method: "POST",
          body: cleanBody({ ...body, labels: labels?.join(",") }),
        })
      ).data;
    },
  );

  tool(
    "update_issue",
    {
      title: "Update GitLab issue",
      description:
        "Update issue metadata, assignees, labels, milestone, confidentiality, or open/closed state.",
      inputSchema: {
        project,
        issue_iid: iid,
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        assignee_ids: z.array(z.number().int().positive()).optional(),
        labels: z.array(z.string()).optional(),
        add_labels: stringArray.optional(),
        remove_labels: stringArray.optional(),
        milestone_id: z.number().int().min(0).optional(),
        due_date: z.string().date().nullable().optional(),
        confidential: z.boolean().optional(),
        discussion_locked: z.boolean().optional(),
        state_event: z.enum(["close", "reopen"]).optional(),
        weight: z.number().int().min(0).optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const {
        project: projectValue,
        issue_iid,
        labels,
        add_labels,
        remove_labels,
        ...body
      } = args;
      return (
        await client.request(issue(projectValue, issue_iid), {
          method: "PUT",
          body: cleanBody({
            ...body,
            labels: labels?.join(","),
            add_labels: add_labels?.join(","),
            remove_labels: remove_labels?.join(","),
          }),
        })
      ).data;
    },
  );

  // ── Issue-note tools ────────────────────────────────────────────────

  tool(
    "list_issue_notes",
    {
      title: "List issue notes",
      description:
        "List user and system notes on one GitLab issue in chronological or reverse order.",
      inputSchema: {
        project,
        issue_iid: iid,
        sort: z.enum(["asc", "desc"]).optional(),
        order_by: z.enum(["created_at", "updated_at"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, issue_iid, ...query } = args;
      return client.request(`${issue(projectValue, issue_iid)}/notes`, {
        query,
      });
    },
  );

  tool(
    "create_issue_note",
    {
      title: "Create issue note",
      description:
        "Add a top-level comment to a GitLab issue as the authenticated user.",
      inputSchema: {
        project,
        issue_iid: iid,
        body: nonEmpty,
        internal: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(`${issue(args.project, args.issue_iid)}/notes`, {
          method: "POST",
          body: { body: args.body, internal: args.internal },
        })
      ).data,
  );

  tool(
    "update_issue_note",
    {
      title: "Update issue note",
      description: "Replace the body of an existing GitLab issue comment.",
      inputSchema: {
        project,
        issue_iid: iid,
        note_id: z.number().int().positive(),
        body: nonEmpty,
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${issue(args.project, args.issue_iid)}/notes/${args.note_id}`,
          { method: "PUT", body: { body: args.body } },
        )
      ).data,
  );

  tool(
    "delete_issue_note",
    {
      title: "Delete issue note",
      description: "Permanently delete a GitLab issue comment.",
      inputSchema: {
        project,
        issue_iid: iid,
        note_id: z.number().int().positive(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${issue(args.project, args.issue_iid)}/notes/${args.note_id}`,
          { method: "DELETE" },
        )
      ).data,
  );

  // ── Issue-reaction tools ────────────────────────────────────────────

  tool(
    "list_issue_reactions",
    {
      title: "List issue reactions",
      description:
        "List emoji reactions on a GitLab issue or one of its comments.",
      inputSchema: {
        project,
        issue_iid: iid,
        note_id: z.number().int().positive().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const base = args.note_id
        ? `${issue(args.project, args.issue_iid)}/notes/${args.note_id}`
        : issue(args.project, args.issue_iid);
      return client.request(`${base}/award_emoji`, {
        query: { page: args.page, per_page: args.per_page },
      });
    },
  );

  tool(
    "add_issue_reaction",
    {
      title: "Add issue reaction",
      description:
        "Add an emoji reaction to a GitLab issue or to one of its comments.",
      inputSchema: {
        project,
        issue_iid: iid,
        name: nonEmpty.describe("GitLab emoji name such as thumbsup or eyes."),
        note_id: z.number().int().positive().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const base = args.note_id
        ? `${issue(args.project, args.issue_iid)}/notes/${args.note_id}`
        : issue(args.project, args.issue_iid);
      return (
        await client.request(`${base}/award_emoji`, {
          method: "POST",
          body: { name: args.name },
        })
      ).data;
    },
  );

  tool(
    "remove_issue_reaction",
    {
      title: "Remove issue reaction",
      description:
        "Remove an emoji reaction from a GitLab issue or issue comment by award ID.",
      inputSchema: {
        project,
        issue_iid: iid,
        award_id: z.number().int().positive(),
        note_id: z.number().int().positive().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const base = args.note_id
        ? `${issue(args.project, args.issue_iid)}/notes/${args.note_id}`
        : issue(args.project, args.issue_iid);
      return (
        await client.request(`${base}/award_emoji/${args.award_id}`, {
          method: "DELETE",
        })
      ).data;
    },
  );
}
