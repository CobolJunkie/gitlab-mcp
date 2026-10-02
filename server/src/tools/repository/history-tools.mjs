/**
 * Repository commit/history read tools.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../../gitlab-client.mjs";
import { READ_ONLY } from "../annotations.mjs";
import { project, nonEmpty, page, perPage, sha } from "../schemas.mjs";
import { p } from "../paths.mjs";

export function registerRepositoryHistoryTools(tool) {
  tool(
    "list_commits",
    {
      title: "List repository commits",
      description:
        "List commits for a project, optionally scoped to a ref, path, or time range.",
      inputSchema: {
        project,
        ref_name: z.string().optional(),
        path: z.string().optional(),
        since: z.string().datetime({ offset: true }).optional(),
        until: z.string().datetime({ offset: true }).optional(),
        all: z.boolean().optional(),
        with_stats: z.boolean().optional(),
        first_parent: z.boolean().optional(),
        order: z.enum(["default", "topo"]).optional(),
        trailers: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/repository/commits`, { query });
    },
  );

  tool(
    "get_commit",
    {
      title: "Get repository commit",
      description: "Fetch a GitLab commit and its optional diff statistics.",
      inputSchema: {
        project,
        sha,
        stats: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/repository/commits/${encodePathSegment(args.sha)}`,
          { query: { stats: args.stats } },
        )
      ).data,
  );

  tool(
    "compare_refs",
    {
      title: "Compare repository refs",
      description:
        "Compare two branches, tags, or commits and return commits plus per-file diffs.",
      inputSchema: {
        project,
        from: nonEmpty,
        to: nonEmpty,
        straight: z.boolean().optional(),
        unidiff: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(`${p(args.project)}/repository/compare`, {
          query: {
            from: args.from,
            to: args.to,
            straight: args.straight,
            unidiff: args.unidiff,
          },
        })
      ).data,
  );

  tool(
    "list_commit_diffs",
    {
      title: "List commit diffs",
      description:
        "Return the files and patch hunks changed by one GitLab commit.",
      inputSchema: {
        project,
        sha,
        unidiff: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(
        `${p(args.project)}/repository/commits/${encodePathSegment(args.sha)}/diff`,
        {
          query: {
            unidiff: args.unidiff,
            page: args.page,
            per_page: args.per_page,
          },
        },
      ),
  );
}
