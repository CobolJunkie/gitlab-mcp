/**
 * Platform identity, group, project, and discovery tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { READ_ONLY } from "./annotations.mjs";
import {
  project,
  groupIdentifier,
  nonEmpty,
  page,
  perPage,
} from "./schemas.mjs";
import { p, g } from "./paths.mjs";
import { cleanBody } from "./responses.mjs";

/**
 * Register platform identity, group, project, and discovery tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerPlatformTools(tool) {
  tool(
    "get_current_user",
    {
      title: "Get current GitLab user",
      description:
        "Return the profile and identity associated with the connected GitLab token.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async (client) => (await client.request("/user")).data,
  );

  tool(
    "list_groups",
    {
      title: "List GitLab groups",
      description:
        "List groups visible to the connected user, including membership, ownership, access-level, and search filters.",
      inputSchema: {
        search: z.string().optional(),
        owned: z.boolean().optional(),
        min_access_level: z.number().int().min(0).max(50).optional(),
        all_available: z.boolean().optional(),
        top_level_only: z.boolean().optional(),
        order_by: z.enum(["name", "path", "id", "similarity"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => client.request("/groups", { query: args }),
  );

  tool(
    "get_group",
    {
      title: "Get GitLab group",
      description:
        "Get one GitLab group or namespace with visibility, project, sharing, and permission metadata.",
      inputSchema: {
        group: groupIdentifier,
        with_projects: z.boolean().optional(),
        statistics: z.boolean().optional(),
        root_storage_statistics: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(g(args.group), {
          query: {
            with_projects: args.with_projects,
            statistics: args.statistics,
            root_storage_statistics: args.root_storage_statistics,
          },
        })
      ).data,
  );

  tool(
    "list_group_projects",
    {
      title: "List GitLab group projects",
      description:
        "List projects in a GitLab group with subgroup, membership, visibility, archive, search, and ordering filters.",
      inputSchema: {
        group: groupIdentifier,
        search: z.string().optional(),
        include_subgroups: z.boolean().optional(),
        with_shared: z.boolean().optional(),
        owned: z.boolean().optional(),
        min_access_level: z.number().int().min(0).max(50).optional(),
        archived: z.boolean().optional(),
        active: z.boolean().optional(),
        visibility: z.enum(["private", "internal", "public"]).optional(),
        order_by: z
          .enum([
            "id",
            "name",
            "path",
            "created_at",
            "updated_at",
            "similarity",
            "star_count",
            "last_activity_at",
          ])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { group, ...query } = args;
      return client.request(`${g(group)}/projects`, { query });
    },
  );

  tool(
    "list_group_members",
    {
      title: "List GitLab group members",
      description:
        "List direct, inherited, and invited members of a GitLab group.",
      inputSchema: {
        group: groupIdentifier,
        query: z.string().optional(),
        user_ids: z.array(z.number().int().positive()).optional(),
        skip_users: z.array(z.number().int().positive()).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { group, user_ids, skip_users, ...query } = args;
      return client.request(`${g(group)}/members/all`, {
        query: cleanBody({
          ...query,
          "user_ids[]": user_ids,
          "skip_users[]": skip_users,
        }),
      });
    },
  );

  tool(
    "get_group_member",
    {
      title: "Get GitLab group member",
      description:
        "Get one direct or inherited group member and their effective access level.",
      inputSchema: {
        group: groupIdentifier,
        user_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (await client.request(`${g(args.group)}/members/all/${args.user_id}`))
        .data,
  );

  tool(
    "search_gitlab",
    {
      title: "Search GitLab",
      description:
        "Search globally, within a group, or within a project. Supported scopes include projects, issues, merge requests, users, commits, blobs, notes, milestones, and work items; availability depends on GitLab tier and search configuration.",
      inputSchema: {
        search: nonEmpty,
        scope: z.enum([
          "projects",
          "issues",
          "work_items",
          "merge_requests",
          "milestones",
          "users",
          "commits",
          "blobs",
          "wiki_blobs",
          "notes",
          "snippet_titles",
        ]),
        group: groupIdentifier.optional(),
        project: project.optional(),
        state: z.string().optional(),
        confidential: z.boolean().optional(),
        search_type: z.enum(["basic", "advanced", "zoekt"]).optional(),
        fields: z.array(z.enum(["title"])).optional(),
        include_archived: z.boolean().optional(),
        exclude_forks: z.boolean().optional(),
        regex: z.boolean().optional(),
        num_context_lines: z.number().int().min(0).max(20).optional(),
        order_by: z.string().optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      if (args.group !== undefined && args.project !== undefined) {
        throw new Error(
          "Provide either group or project search scope, not both.",
        );
      }
      const { group, project: projectValue, fields, ...query } = args;
      let base;
      if (projectValue !== undefined) {
        base = `${p(projectValue)}/search`;
      } else if (group !== undefined) {
        base = `${g(group)}/search`;
      } else {
        base = "/search";
      }
      return client.request(base, {
        query: cleanBody({
          ...query,
          "fields[]": fields,
        }),
      });
    },
  );

  tool(
    "search_projects",
    {
      title: "Search GitLab projects",
      description:
        "Search accessible GitLab projects by name, path, or description. Use this to resolve an ambiguous project before other calls.",
      inputSchema: {
        search: z.string().optional(),
        membership: z.boolean().optional(),
        owned: z.boolean().optional(),
        starred: z.boolean().optional(),
        archived: z.boolean().optional(),
        visibility: z.enum(["private", "internal", "public"]).optional(),
        order_by: z
          .enum([
            "id",
            "name",
            "path",
            "created_at",
            "updated_at",
            "last_activity_at",
            "similarity",
          ])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request("/projects", {
        query: cleanBody({ ...args, simple: true }),
      }),
  );

  tool(
    "get_project",
    {
      title: "Get GitLab project",
      description:
        "Get repository, namespace, default branch, visibility, permissions, and feature metadata for one GitLab project.",
      inputSchema: {
        project,
        statistics: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(p(args.project), {
          query: { statistics: args.statistics },
        })
      ).data,
  );

  tool(
    "list_project_members",
    {
      title: "List GitLab project members",
      description:
        "List direct and inherited project members, optionally filtering by username or name.",
      inputSchema: {
        project,
        query: z.string().optional(),
        user_ids: z.array(z.number().int().positive()).optional(),
        skip_users: z.array(z.number().int().positive()).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/members/all`, {
        query: cleanBody({
          ...query,
          "user_ids[]": query.user_ids,
          "skip_users[]": query.skip_users,
          user_ids: undefined,
          skip_users: undefined,
        }),
      });
    },
  );

  tool(
    "list_project_labels",
    {
      title: "List GitLab project labels",
      description: "List labels available in a GitLab project.",
      inputSchema: {
        project,
        search: z.string().optional(),
        include_ancestor_groups: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/labels`, { query });
    },
  );

  tool(
    "get_project_member",
    {
      title: "Get GitLab project member",
      description:
        "Get one direct or inherited project member and their effective access level.",
      inputSchema: {
        project,
        user_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (await client.request(`${p(args.project)}/members/all/${args.user_id}`))
        .data,
  );
}
