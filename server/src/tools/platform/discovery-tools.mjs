/**
 * Platform identity, group, project, and search tool registrations.
 */

import * as z from "zod/v4";

import { READ_ONLY } from "../annotations.mjs";
import {
  project,
  groupIdentifier,
  nonEmpty,
  page,
  perPage,
} from "../schemas.mjs";
import { p, g } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

const SEARCH_SCOPES_BY_LOCATION = Object.freeze({
  instance: new Set([
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
  group: new Set([
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
  ]),
  project: new Set([
    "issues",
    "work_items",
    "merge_requests",
    "milestones",
    "users",
    "commits",
    "blobs",
    "wiki_blobs",
    "notes",
  ]),
});

const SEARCH_STATE_VALUES = Object.freeze({
  issues: new Set(["all", "opened", "closed"]),
  work_items: new Set(["all", "opened", "closed"]),
  merge_requests: new Set(["all", "opened", "closed", "merged"]),
});

const SEARCH_ORDERABLE_SCOPES = new Set([
  "issues",
  "work_items",
  "merge_requests",
]);

const SEARCH_ARCHIVED_FILTER_SCOPES = new Set([
  "projects",
  "issues",
  "work_items",
  "merge_requests",
  "milestones",
  "commits",
  "blobs",
  "wiki_blobs",
  "notes",
]);

const SEARCH_VERSION_REQUIREMENTS = Object.freeze([
  { options: ["include_archived", "exclude_forks"], minimum: [18, 7] },
  { options: ["regex"], minimum: [18, 9] },
  { options: ["num_context_lines"], minimum: [18, 11] },
]);

const SEARCH_NON_PROJECT_PREMIUM_SCOPES = new Set([
  "blobs",
  "wiki_blobs",
  "commits",
  "notes",
]);

function searchLocation(args) {
  if (args.group !== undefined && args.project !== undefined) {
    throw new TypeError(
      "Provide either group or project search scope, not both.",
    );
  }
  if (args.project !== undefined) return "project";
  if (args.group !== undefined) return "group";
  return "instance";
}

function validateSearchState(args) {
  if (args.state === undefined) return;

  const allowedStates = SEARCH_STATE_VALUES[args.scope];
  if (!allowedStates) {
    throw new TypeError(
      `search_gitlab state is only valid for issues, work_items, and merge_requests; scope ${JSON.stringify(args.scope)} does not support it.`,
    );
  }
  if (!allowedStates.has(args.state)) {
    throw new TypeError(
      `search_gitlab state ${JSON.stringify(args.state)} is not valid for scope ${JSON.stringify(args.scope)}.`,
    );
  }
}

function validateSearchFilterApplicability(args) {
  if (
    args.confidential !== undefined &&
    !["issues", "work_items"].includes(args.scope)
  ) {
    throw new TypeError(
      "search_gitlab confidential is only valid for issues and work_items.",
    );
  }
  if (
    args.fields !== undefined &&
    !["issues", "merge_requests"].includes(args.scope)
  ) {
    throw new TypeError(
      "search_gitlab fields is only valid for issues and merge_requests.",
    );
  }
}

function validateSearchOrdering(args) {
  const hasOrdering = args.order_by !== undefined || args.sort !== undefined;
  if (hasOrdering && !SEARCH_ORDERABLE_SCOPES.has(args.scope)) {
    throw new TypeError(
      "search_gitlab order_by and sort are only valid for issues, work_items, and merge_requests.",
    );
  }
  if (args.sort !== undefined && args.order_by === undefined) {
    throw new TypeError(
      "search_gitlab sort requires order_by=created_at on the GitLab 18.11 compatibility surface.",
    );
  }
}

function validateSearchArchiveFilter(args, location) {
  if (args.include_archived === undefined) return;

  if (location === "project") {
    throw new TypeError(
      "search_gitlab include_archived is only valid for instance- or group-scoped search.",
    );
  }
  if (!SEARCH_ARCHIVED_FILTER_SCOPES.has(args.scope)) {
    throw new TypeError(
      "search_gitlab include_archived is only valid for project-backed search scopes; users and snippet_titles do not support it.",
    );
  }
}

function validateSearchType(args, location, codeScope) {
  if (args.search_type === "advanced" && args.scope === "snippet_titles") {
    throw new TypeError(
      "search_gitlab search_type=advanced does not support scope=snippet_titles.",
    );
  }
  if (args.search_type === "zoekt" && !codeScope) {
    throw new TypeError(
      "search_gitlab search_type=zoekt is only valid with scope=blobs.",
    );
  }
  if (
    args.search_type === "basic" &&
    location !== "project" &&
    ["blobs", "wiki_blobs", "commits", "notes"].includes(args.scope)
  ) {
    throw new TypeError(
      `search_gitlab basic search does not support scope ${JSON.stringify(args.scope)} at ${location} scope.`,
    );
  }
}

function validateSearchCodeFilters(args, location, codeScope) {
  if (
    args.exclude_forks !== undefined &&
    (location === "project" || !codeScope || args.search_type !== "zoekt")
  ) {
    throw new TypeError(
      "search_gitlab exclude_forks requires instance/group scope, scope=blobs, and search_type=zoekt.",
    );
  }
  if (
    args.regex !== undefined &&
    (!codeScope || args.search_type !== "zoekt")
  ) {
    throw new TypeError(
      "search_gitlab regex requires scope=blobs and search_type=zoekt.",
    );
  }
  if (
    args.num_context_lines !== undefined &&
    (!codeScope || !["advanced", "zoekt"].includes(args.search_type))
  ) {
    throw new TypeError(
      "search_gitlab num_context_lines requires scope=blobs and search_type=advanced or zoekt.",
    );
  }
}

function validateSearchGitLabArgs(args) {
  const location = searchLocation(args);
  if (!SEARCH_SCOPES_BY_LOCATION[location].has(args.scope)) {
    throw new TypeError(
      `search_gitlab scope ${JSON.stringify(args.scope)} is not supported for ${location}-scoped search.`,
    );
  }

  validateSearchState(args);
  validateSearchFilterApplicability(args);
  validateSearchOrdering(args);
  validateSearchArchiveFilter(args, location);

  const codeScope = args.scope === "blobs";
  validateSearchType(args, location, codeScope);
  validateSearchCodeFilters(args, location, codeScope);
}

function parseGitLabVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value ?? ""));
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(actual, required) {
  for (let index = 0; index < required.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function affectedByAdvancedZeroContextBug(actual) {
  const [major, minor, patch = 0] = actual;
  return (
    (major === 18 && minor === 11 && patch < 4) ||
    (major === 19 && minor === 0 && patch < 1)
  );
}

function searchRequiresPremiumTier(args) {
  const location = searchLocation(args);
  return (
    args.fields !== undefined ||
    ["advanced", "zoekt"].includes(args.search_type) ||
    (location !== "project" &&
      SEARCH_NON_PROJECT_PREMIUM_SCOPES.has(args.scope))
  );
}

async function validateSearchGitLabTier(client, args) {
  if (!searchRequiresPremiumTier(args)) return;

  let enterprise;
  try {
    enterprise = (await client.request("/metadata")).data?.enterprise;
  } catch {
    throw new TypeError(
      "search_gitlab cannot safely use the requested Premium/Ultimate search capability because GitLab edition metadata could not be determined.",
    );
  }

  if (enterprise !== true) {
    const evidence =
      enterprise === false
        ? "connected server reports Community Edition"
        : "Enterprise Edition capability was not proven";
    throw new TypeError(
      `search_gitlab requested a Premium/Ultimate search capability; ${evidence}.`,
    );
  }
}

async function validateSearchGitLabVersion(client, args) {
  const requirements = SEARCH_VERSION_REQUIREMENTS.filter(({ options }) =>
    options.some((option) => args[option] !== undefined),
  );
  if (requirements.length === 0) return;

  let versionValue;
  try {
    versionValue = (await client.request("/version")).data?.version;
  } catch {
    throw new TypeError(
      "search_gitlab cannot safely use the requested version-gated filters because the GitLab version could not be determined.",
    );
  }
  const actual = parseGitLabVersion(versionValue);
  if (!actual) {
    throw new TypeError(
      "search_gitlab cannot safely use the requested version-gated filters because the GitLab version could not be determined.",
    );
  }

  for (const { options, minimum } of requirements) {
    if (versionAtLeast(actual, minimum)) continue;
    const requested = options.filter((option) => args[option] !== undefined);
    throw new TypeError(
      `search_gitlab option(s) ${requested.join(", ")} require GitLab ${minimum.join(".")} or newer; connected server reports ${versionValue}.`,
    );
  }

  if (
    args.search_type === "advanced" &&
    args.num_context_lines === 0 &&
    affectedByAdvancedZeroContextBug(actual)
  ) {
    throw new TypeError(
      `search_gitlab advanced num_context_lines=0 is not reliable on GitLab ${versionValue}; use GitLab 18.11.4+ or 19.0.1+ for the affected release lines.`,
    );
  }
}

/**
 * Register platform identity, group, project, and search tools that precede
 * lifecycle registrations in the canonical platform tool order.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerPlatformDiscoveryTools(tool) {
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
        "Search globally, within a group, or within a project with scope-aware validation. Location, state, and filter combinations are checked before search dispatch. Some advanced/exact-search features remain tier or configuration dependent.",
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
        state: z
          .enum(["all", "opened", "closed", "merged"])
          .optional()
          .describe(
            "State filter for issues/work_items (all, opened, closed) or merge_requests (all, opened, closed, merged).",
          ),
        confidential: z
          .boolean()
          .optional()
          .describe("Confidentiality filter for issues and work_items only."),
        search_type: z
          .enum(["basic", "advanced", "zoekt"])
          .optional()
          .describe(
            "GitLab search backend. advanced and zoekt depend on tier and instance configuration; zoekt is exact code search.",
          ),
        fields: z
          .array(z.enum(["title"]))
          .length(1)
          .optional()
          .describe(
            'Restrict issues or merge_requests search to title. Supply exactly ["title"]; GitLab documents this filter for Premium/Ultimate tiers.',
          ),
        include_archived: z
          .boolean()
          .optional()
          .describe(
            "Include archived projects for instance/group project-backed search scopes. Not valid for project, users, or snippet_titles search. Requires GitLab 18.7 or newer.",
          ),
        exclude_forks: z
          .boolean()
          .optional()
          .describe(
            "Exclude forks from instance/group exact code search. Requires scope=blobs, search_type=zoekt, and GitLab 18.7 or newer.",
          ),
        regex: z
          .boolean()
          .optional()
          .describe(
            "Treat the query as a regular expression for exact code search. Requires scope=blobs, search_type=zoekt, and GitLab 18.9 or newer.",
          ),
        num_context_lines: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe(
            "Code-search context lines. Requires scope=blobs, advanced/zoekt search, and GitLab 18.11 or newer. Advanced-search value 0 is rejected on affected GitLab 18.11.0-18.11.3 and 19.0.0 releases because they return extra context.",
          ),
        order_by: z
          .enum(["created_at"])
          .optional()
          .describe(
            "Order issues, work_items, or merge_requests search results by creation time for the GitLab 18.11 compatibility surface.",
          ),
        sort: z
          .enum(["asc", "desc"])
          .optional()
          .describe(
            "Sort direction for issues, work_items, or merge_requests search results. Requires order_by=created_at on the GitLab 18.11 compatibility surface.",
          ),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      validateSearchGitLabArgs(args);
      await validateSearchGitLabTier(client, args);
      await validateSearchGitLabVersion(client, args);
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
}

/**
 * Register the trailing project-member lookup while preserving canonical tool
 * registration order around label and milestone lifecycle groups.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerPlatformProjectMemberTool(tool) {
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
