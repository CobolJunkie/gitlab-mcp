/**
 * Tag and release tools for the GitLab MCP server.
 *
 * Git tags, releases, and release asset-link tools extracted from
 * `tools.mjs`, including their destructive-operation safety semantics.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so the canonical tag/release tool contracts remain centralized in this
 * dedicated module.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../gitlab-client.mjs";

import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import { project, nonEmpty, stringArray, page, perPage } from "./schemas.mjs";
import { p } from "./paths.mjs";

function tagDeletionContext(args) {
  const encodedTagName = encodePathSegment(args.tag_name);
  const projectPath = p(args.project);
  return {
    projectPath,
    tagsPath: `${projectPath}/repository/tags`,
    tagPath: `${projectPath}/repository/tags/${encodedTagName}`,
    releasePath: `${projectPath}/releases/${encodedTagName}`,
    exactTagSearch: `^${args.tag_name}$`,
  };
}

function tagDeletionErrorMessage(error) {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function tagReportsAssociatedRelease(tag) {
  return Boolean(tag && typeof tag === "object" && tag.release != null);
}

async function preflightTagDeletion(client, args, context) {
  const response = await client.request(context.tagPath);
  if (response.data == null || typeof response.data !== "object") {
    throw new Error(
      "Tag deletion preflight returned no exact tag data; refusing to delete.",
    );
  }

  const hasAssociatedRelease = tagReportsAssociatedRelease(response.data);
  if (
    hasAssociatedRelease &&
    args.acknowledge_associated_release_deletion !== true
  ) {
    throw new TypeError(
      "delete_tag requires acknowledge_associated_release_deletion: true because GitLab reports an associated Release for this exact tag and deleting the tag also deletes that Release.",
    );
  }
  return hasAssociatedRelease;
}

function isDefinitiveTagDeleteRejection(error) {
  const status = error instanceof GitLabApiError ? error.status : undefined;
  return (
    Number.isInteger(status) && status >= 400 && status < 500 && status !== 408
  );
}

async function confirmTagAbsent(client, args, context) {
  const confirmation = await client.request(context.tagsPath, {
    query: {
      search: context.exactTagSearch,
      page: 1,
      per_page: 1,
    },
  });
  if (!Array.isArray(confirmation.data)) {
    throw new TypeError(
      "GitLab returned an invalid tag-list response while confirming tag absence.",
    );
  }
  const visible = confirmation.data.find(
    (entry) => entry?.name === args.tag_name,
  );
  if (visible) {
    throw new GitLabApiError(
      "Tag deletion cannot confirm absence because the exact tag is visible again.",
      {
        status: 409,
        method: "GET",
        path: context.tagsPath,
        response: {
          tag_name: args.tag_name,
          target: visible.target,
        },
      },
    );
  }
}

async function confirmProjectReadable(client, context) {
  const confirmation = await client.request(context.projectPath);
  if (confirmation.data == null || typeof confirmation.data !== "object") {
    throw new TypeError(
      "GitLab returned invalid project data while corroborating Release absence.",
    );
  }
}

async function verifyTagDeletionAbsence(
  client,
  path,
  resourceLabel,
  confirmNotFound,
) {
  let response;
  try {
    response = await client.request(path);
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 404) {
      try {
        await confirmNotFound();
      } catch (confirmationError) {
        const confirmationMessage = tagDeletionErrorMessage(confirmationError);
        throw new Error(
          `Tag deletion postcondition is ambiguous because ${resourceLabel} returned 404 but absence could not be corroborated: ${confirmationMessage} Re-read the exact tag and Release before any retry or further mutation.`,
          { cause: confirmationError },
        );
      }
      return;
    }
    const message = tagDeletionErrorMessage(error);
    throw new Error(
      `Tag deletion postcondition is ambiguous because ${resourceLabel} could not be verified absent: ${message} Re-read the exact tag and Release before any retry or further mutation.`,
      { cause: error },
    );
  }

  if (response.data == null) {
    throw new Error(
      `Tag deletion postcondition is ambiguous because GitLab returned a successful empty read for ${resourceLabel}; absence is not proven. Re-read the exact tag and Release before any retry or further mutation.`,
    );
  }

  throw new Error(
    `Tag deletion postcondition failed because ${resourceLabel} is still present or was recreated concurrently. Re-read the exact tag and Release before any retry or further mutation.`,
  );
}

async function deleteReviewedTag(client, args) {
  const context = tagDeletionContext(args);
  const firstPreflightHadRelease = await preflightTagDeletion(
    client,
    args,
    context,
  );
  const finalPreflightHadRelease = await preflightTagDeletion(
    client,
    args,
    context,
  );
  const hadAssociatedRelease =
    firstPreflightHadRelease || finalPreflightHadRelease;

  let deleteResponse;
  try {
    deleteResponse = await client.request(context.tagPath, {
      method: "DELETE",
    });
  } catch (error) {
    if (isDefinitiveTagDeleteRejection(error)) {
      throw error;
    }
    const message = tagDeletionErrorMessage(error);
    throw new Error(
      `Tag deletion outcome is ambiguous because GitLab did not provide a definitive DELETE response (${message}). Re-read the exact tag and any associated Release before any retry or further mutation.`,
      { cause: error },
    );
  }

  await verifyTagDeletionAbsence(client, context.tagPath, "the tag", () =>
    confirmTagAbsent(client, args, context),
  );
  if (hadAssociatedRelease) {
    await verifyTagDeletionAbsence(
      client,
      context.releasePath,
      "the associated Release",
      () => confirmProjectReadable(client, context),
    );
  }

  return deleteResponse.data;
}

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
        "Delete one exact Git tag after a read preflight. If GitLab reports an associated Release, deleting the tag also deletes that Release and acknowledge_associated_release_deletion must be true. The exact tag is rechecked immediately before deletion, and accepted deletes verify tag and collateral Release absence afterward. GitLab exposes no atomic delete-if-release-state-unchanged operation, so concurrent association changes after the final preflight remain a residual race; ambiguous destructive outcomes fail closed.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        acknowledge_tag_deletion: z.literal(true),
        acknowledge_associated_release_deletion: z
          .literal(true)
          .optional()
          .describe(
            "Required when the exact tag preflight reports an associated GitLab Release; deleting that tag also deletes the Release.",
          ),
      },
      annotations: DESTRUCTIVE,
    },
    deleteReviewedTag,
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

  const releaseAssetUrl = z
    .string()
    .url()
    .refine((value) => /^(?:https?|ftp):\/\//i.test(value), {
      message: "Release asset URLs must use HTTP, HTTPS, or FTP.",
    })
    .describe("HTTP, HTTPS, or FTP URL for a GitLab release asset link.");

  const releaseAssets = z
    .object({
      links: z
        .array(
          z.object({
            name: nonEmpty,
            url: releaseAssetUrl,
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
        "Delete release metadata while preserving the Git tag with the same name. This is asymmetric with delete_tag: deleting a Git tag that has an associated Release also deletes that Release.",
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

  const releaseAssetLinkFields = {
    direct_asset_path: z.string().min(1).optional(),
    link_type: z.enum(["other", "runbook", "image", "package"]).optional(),
  };
  const releaseAssetLinkCreate = {
    name: nonEmpty,
    url: releaseAssetUrl,
    ...releaseAssetLinkFields,
  };
  const releaseAssetLinkUpdate = {
    name: nonEmpty
      .optional()
      .describe("Replacement name; required when url is omitted."),
    url: releaseAssetUrl
      .optional()
      .describe("Replacement URL; required when name is omitted."),
    ...releaseAssetLinkFields,
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
      description:
        "Attach an HTTP, HTTPS, or FTP asset link to a GitLab release.",
      inputSchema: { project, tag_name: nonEmpty, ...releaseAssetLinkCreate },
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
        "Rename or retarget a GitLab release asset link using HTTP, HTTPS, or FTP. At least one of name or url is required.",
      inputSchema: {
        project,
        tag_name: nonEmpty,
        link_id: z.number().int().positive(),
        ...releaseAssetLinkUpdate,
      },
      annotations: WRITE,
    },
    async (client, args) => {
      if (args.name === undefined && args.url === undefined) {
        throw new TypeError(
          "update_release_asset_link requires at least one of name or url.",
        );
      }
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
