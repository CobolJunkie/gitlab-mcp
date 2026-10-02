/**
 * Merge-request approvals, diffs, commits, and pipeline-association tools.
 */

import * as z from "zod/v4";

import { READ_ONLY, WRITE } from "../annotations.mjs";
import { project, iid, nonEmpty, page, perPage } from "../schemas.mjs";
import { mr } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

const reviewedMergeRequestHeadSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/i)
  .describe(
    "Full 40-character SHA of the merge request head that the caller reviewed.",
  );

/**
 * Register merge-request review-inspection tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerMergeRequestReviewTools(tool) {
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
        "Submit the authenticated user's approval for a GitLab merge request. Requires the exact full head SHA that was reviewed; GitLab rejects the approval if the MR has advanced.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        sha: reviewedMergeRequestHeadSha,
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
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(`${mr(args.project, args.merge_request_iid)}/pipelines`, {
        query: { page: args.page, per_page: args.per_page },
      }),
  );
}
