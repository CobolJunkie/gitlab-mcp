/**
 * Tag and release tools for the GitLab MCP server.
 *
 * Git tags, releases, and release asset-link tools extracted from
 * `tools.mjs` without any policy or semantic changes.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../gitlab-client.mjs";

import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import { project, nonEmpty, stringArray, page, perPage } from "./schemas.mjs";
import { p } from "./paths.mjs";

/**
 * Register tag, release, and release asset-link tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerReleaseTools(tool) {
  // ── Tag tools ─────────────────────────────────────────────────────────

  tool(
    "list_tags",
    {
      title: "List repository tags",
      description: "List Git tags and release metadata for a project.",
      inputSchema: {
        project,
        order_by: z.enum(["name", "updated", "version"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        search: z.string().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/repository/tags`, { query });
    },
  );

  tool(
    "get_tag",
    {
      title: "Get repository tag",
      description: "Get one Git tag and its associated release metadata.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/repository/tags/${encodePathSegment(args.tag_name)}`,
        )
      ).data,
  );

  tool(
    "create_tag",
    {
      title: "Create repository tag",
      description: "Create a Git tag from a branch, ref, or commit SHA.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        ref: nonEmpty,
        message: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      return (
        await client.request(`${p(projectValue)}/repository/tags`, {
          method: "POST",
          body,
        })
      ).data;
    },
  );

  tool(
    "delete_tag",
    {
      title: "Delete repository tag",
      description:
        "Delete a Git tag. This does not delete a release with the same tag name.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        acknowledge_tag_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/repository/tags/${encodePathSegment(args.tag_name)}`,
          { method: "DELETE" },
        )
      ).data,
  );

  // ── Release tools ─────────────────────────────────────────────────────

  tool(
    "list_releases",
    {
      title: "List releases",
      description: "List GitLab releases for a project.",
      inputSchema: {
        project,
        order_by: z.enum(["released_at", "created_at"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        include_html_description: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/releases`, { query });
    },
  );

  tool(
    "get_release",
    {
      title: "Get release",
      description: "Get one GitLab release by tag name.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        include_html_description: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/releases/${encodePathSegment(args.tag_name)}`,
          {
            query: {
              include_html_description: args.include_html_description,
            },
          },
        )
      ).data,
  );

  const releaseAssets = z
    .object({
      links: z
        .array(
          z.object({
            name: nonEmpty,
            url: z.string().url(),
            direct_asset_path: z.string().optional(),
            link_type: z
              .enum(["other", "runbook", "image", "package"])
              .optional(),
          }),
        )
        .optional(),
    })
    .optional();

  tool(
    "create_release",
    {
      title: "Create release",
      description:
        "Create a GitLab release and optionally create its tag from a ref.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        name: z.string().optional(),
        description: z.string().optional(),
        ref: z.string().optional(),
        milestones: stringArray.optional(),
        released_at: z.string().datetime().optional(),
        assets: releaseAssets,
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      return (
        await client.request(`${p(projectValue)}/releases`, {
          method: "POST",
          body,
        })
      ).data;
    },
  );

  tool(
    "update_release",
    {
      title: "Update release",
      description:
        "Update the metadata or assets of an existing GitLab release.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        name: z.string().optional(),
        description: z.string().optional(),
        milestones: stringArray.optional(),
        released_at: z.string().datetime().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, tag_name, ...body } = args;
      return (
        await client.request(
          `${p(projectValue)}/releases/${encodePathSegment(tag_name)}`,
          { method: "PUT", body },
        )
      ).data;
    },
  );

  tool(
    "delete_release",
    {
      title: "Delete release",
      description:
        "Delete release metadata without deleting the Git tag with the same name.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        acknowledge_release_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/releases/${encodePathSegment(args.tag_name)}`,
          { method: "DELETE" },
        )
      ).data,
  );

  // ── Release asset-link tools ──────────────────────────────────────────

  const releaseAssetLink = {
    name: nonEmpty,
    url: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), {
        message: "Release asset URLs must use HTTPS or HTTP.",
      }),
    direct_asset_path: z.string().min(1).optional(),
    link_type: z.enum(["other", "runbook", "image", "package"]).optional(),
  };

  tool(
    "list_release_asset_links",
    {
      title: "List release asset links",
      description: "List external asset links attached to a GitLab release.",
      inputSchema: { project, tag_name: nonEmpty },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(
        `${p(args.project)}/releases/${encodePathSegment(args.tag_name)}/assets/links`,
      ),
  );

  tool(
    "get_release_asset_link",
    {
      title: "Get release asset link",
      description: "Get one external asset link attached to a GitLab release.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        link_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/releases/${encodePathSegment(args.tag_name)}/assets/links/${args.link_id}`,
        )
      ).data,
  );

  tool(
    "create_release_asset_link",
    {
      title: "Create release asset link",
      description: "Attach an external asset link to a GitLab release.",
      inputSchema: { project, tag_name: nonEmpty, ...releaseAssetLink },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, tag_name, ...body } = args;
      return (
        await client.request(
          `${p(projectValue)}/releases/${encodePathSegment(tag_name)}/assets/links`,
          { method: "POST", body },
        )
      ).data;
    },
  );

  tool(
    "update_release_asset_link",
    {
      title: "Update release asset link",
      description:
        "Update an external asset link attached to a GitLab release.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        link_id: z.number().int().positive(),
        ...releaseAssetLink,
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, tag_name, link_id, ...body } = args;
      return (
        await client.request(
          `${p(projectValue)}/releases/${encodePathSegment(tag_name)}/assets/links/${link_id}`,
          { method: "PUT", body },
        )
      ).data;
    },
  );

  tool(
    "delete_release_asset_link",
    {
      title: "Delete release asset link",
      description: "Delete an external asset link from a GitLab release.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        link_id: z.number().int().positive(),
        acknowledge_asset_link_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/releases/${encodePathSegment(args.tag_name)}/assets/links/${args.link_id}`,
          { method: "DELETE" },
        )
      ).data,
  );
}
