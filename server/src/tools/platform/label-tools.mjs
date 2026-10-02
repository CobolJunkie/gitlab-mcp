/**
 * Platform project/group label lifecycle tool registrations.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../../gitlab-client.mjs";
import { DESTRUCTIVE, READ_ONLY, WRITE } from "../annotations.mjs";
import { project, groupIdentifier, page, perPage } from "../schemas.mjs";
import { p, g } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

const labelIdentifier = z.union([
  z.number().int().positive(),
  z.string().min(1).max(255),
]);
const labelName = z.string().min(1).max(255);
const labelColor = z.string().min(1).max(64);
const labelDescription = z.string().max(1000);
const labelPriority = z.number().int().min(0).nullable();

function labelPath(scopePath, labelId) {
  return `${scopePath}/labels/${encodePathSegment(labelId)}`;
}

function requireLabelUpdate(body, scope) {
  if (Object.keys(body).length === 0) {
    throw new TypeError(
      `${scope} label update requires at least one mutable field.`,
    );
  }
  return body;
}

async function preflightLabelDeletion(
  client,
  { path, labelId, expectedName, scope },
) {
  const label = (await client.request(path)).data;
  if (!label || label.id !== labelId) {
    throw new Error(
      `${scope} label deletion preflight returned an unexpected label ID.`,
    );
  }
  if (label.name !== expectedName) {
    throw new Error(
      `${scope} label deletion preflight rejected ID ${labelId}: expected name ${JSON.stringify(expectedName)} but GitLab returned ${JSON.stringify(label.name)}.`,
    );
  }
  return label;
}

/**
 * Register project and group label lifecycle tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerPlatformLabelTools(tool) {
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
    "get_project_label",
    {
      title: "Get GitLab project label",
      description:
        "Retrieve one project label by numeric ID or exact title, including archived metadata when GitLab exposes it.",
      inputSchema: {
        project,
        label_id: labelIdentifier,
        include_ancestor_groups: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, label_id, ...query } = args;
      return (
        await client.request(labelPath(p(projectValue), label_id), { query })
      ).data;
    },
  );

  tool(
    "create_project_label",
    {
      title: "Create GitLab project label",
      description:
        "Create a project label with exact name, color, optional description, priority, and archive state. Unsupported fields are reported by GitLab.",
      inputSchema: {
        project,
        name: labelName,
        color: labelColor,
        description: labelDescription.optional(),
        priority: labelPriority.optional(),
        archived: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      return (
        await client.request(`${p(projectValue)}/labels`, {
          method: "POST",
          body: cleanBody(body),
        })
      ).data;
    },
  );

  tool(
    "update_project_label",
    {
      title: "Update GitLab project label",
      description:
        "Update one project label by numeric ID or exact title. Scoped names containing :: are forwarded unchanged; archived and priority fields depend on GitLab support.",
      inputSchema: {
        project,
        label_id: labelIdentifier,
        new_name: labelName.optional(),
        color: labelColor.optional(),
        description: labelDescription.optional(),
        priority: labelPriority.optional(),
        archived: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, label_id, ...fields } = args;
      const body = requireLabelUpdate(cleanBody(fields), "Project");
      return (
        await client.request(labelPath(p(projectValue), label_id), {
          method: "PUT",
          body,
        })
      ).data;
    },
  );

  tool(
    "delete_project_label",
    {
      title: "Delete GitLab project label",
      description:
        "Delete one project label only after reading the exact numeric ID and expected current name. Requires explicit destructive acknowledgement.",
      inputSchema: {
        project,
        label_id: z.number().int().positive(),
        expected_label_name: labelName,
        acknowledge_label_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const path = labelPath(p(args.project), args.label_id);
      const label = await preflightLabelDeletion(client, {
        path,
        labelId: args.label_id,
        expectedName: args.expected_label_name,
        scope: "Project",
      });
      await client.request(path, { method: "DELETE" });
      return {
        scope: "project",
        label_id: label.id,
        label_name: label.name,
        outcome: "deleted",
        changed: true,
      };
    },
  );

  tool(
    "list_group_labels",
    {
      title: "List GitLab group labels",
      description:
        "List labels available in a GitLab group with ancestor, descendant, project-label, count, search, and archive filters.",
      inputSchema: {
        group: groupIdentifier,
        search: z.string().optional(),
        with_counts: z.boolean().optional(),
        include_ancestor_groups: z.boolean().optional(),
        include_descendant_groups: z.boolean().optional(),
        only_group_labels: z.boolean().optional(),
        archived: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { group: groupValue, ...query } = args;
      return client.request(`${g(groupValue)}/labels`, { query });
    },
  );

  tool(
    "get_group_label",
    {
      title: "Get GitLab group label",
      description:
        "Retrieve one group label by numeric ID or exact title with ancestor and descendant scope controls.",
      inputSchema: {
        group: groupIdentifier,
        label_id: labelIdentifier,
        include_ancestor_groups: z.boolean().optional(),
        include_descendant_groups: z.boolean().optional(),
        only_group_labels: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { group: groupValue, label_id, ...query } = args;
      return (
        await client.request(labelPath(g(groupValue), label_id), { query })
      ).data;
    },
  );

  tool(
    "create_group_label",
    {
      title: "Create GitLab group label",
      description:
        "Create a group label with exact name, color, optional description, and archive state. Unsupported fields are reported by GitLab.",
      inputSchema: {
        group: groupIdentifier,
        name: labelName,
        color: labelColor,
        description: labelDescription.optional(),
        archived: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { group: groupValue, ...body } = args;
      return (
        await client.request(`${g(groupValue)}/labels`, {
          method: "POST",
          body: cleanBody(body),
        })
      ).data;
    },
  );

  tool(
    "update_group_label",
    {
      title: "Update GitLab group label",
      description:
        "Update one group label by numeric ID or exact title. Scoped names containing :: are forwarded unchanged; archived state depends on GitLab support.",
      inputSchema: {
        group: groupIdentifier,
        label_id: labelIdentifier,
        new_name: labelName.optional(),
        color: labelColor.optional(),
        description: labelDescription.optional(),
        archived: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { group: groupValue, label_id, ...fields } = args;
      const body = requireLabelUpdate(cleanBody(fields), "Group");
      return (
        await client.request(labelPath(g(groupValue), label_id), {
          method: "PUT",
          body,
        })
      ).data;
    },
  );

  tool(
    "delete_group_label",
    {
      title: "Delete GitLab group label",
      description:
        "Delete one group label only after reading the exact numeric ID and expected current name. Requires explicit destructive acknowledgement.",
      inputSchema: {
        group: groupIdentifier,
        label_id: z.number().int().positive(),
        expected_label_name: labelName,
        acknowledge_label_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const path = labelPath(g(args.group), args.label_id);
      const label = await preflightLabelDeletion(client, {
        path,
        labelId: args.label_id,
        expectedName: args.expected_label_name,
        scope: "Group",
      });
      await client.request(path, { method: "DELETE" });
      return {
        scope: "group",
        label_id: label.id,
        label_name: label.name,
        outcome: "deleted",
        changed: true,
      };
    },
  );
}
