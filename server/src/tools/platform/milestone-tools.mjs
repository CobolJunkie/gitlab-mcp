/**
 * Platform project/group milestone lifecycle tool registrations.
 */

import * as z from "zod/v4";

import { DESTRUCTIVE, WRITE } from "../annotations.mjs";
import { project, groupIdentifier } from "../schemas.mjs";
import { p, g } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

const milestoneId = z.number().int().positive();
const milestoneTitle = z.string().min(1).max(255);
const milestoneDescription = z.string().max(10_000);
const milestoneDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Milestone date must be a real calendar date.")
  .describe("Milestone date in YYYY-MM-DD format.");
const milestoneStateEvent = z.enum(["close", "activate"]);

function milestonePath(scopePath, id) {
  return `${scopePath}/milestones/${id}`;
}

function requireMilestoneUpdate(body, scope) {
  if (Object.keys(body).length === 0) {
    throw new TypeError(
      `${scope} milestone update requires at least one mutable field.`,
    );
  }
  return body;
}

async function preflightMilestoneDeletion(
  client,
  { path, id, expectedTitle, scope },
) {
  const milestone = (await client.request(path)).data;
  if (!milestone || milestone.id !== id) {
    throw new Error(
      `${scope} milestone deletion preflight returned an unexpected milestone ID.`,
    );
  }
  if (milestone.title !== expectedTitle) {
    throw new Error(
      `${scope} milestone deletion preflight rejected ID ${id}: expected title ${JSON.stringify(expectedTitle)} but GitLab returned ${JSON.stringify(milestone.title)}.`,
    );
  }
  return milestone;
}

/**
 * Register project and group milestone lifecycle tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerPlatformMilestoneTools(tool) {
  tool(
    "create_project_milestone",
    {
      title: "Create GitLab project milestone",
      description:
        "Create a project milestone with title, optional description, start date, and due date.",
      inputSchema: {
        project,
        title: milestoneTitle,
        description: milestoneDescription.optional(),
        start_date: milestoneDate.optional(),
        due_date: milestoneDate.optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      return (
        await client.request(`${p(projectValue)}/milestones`, {
          method: "POST",
          body: cleanBody(body),
        })
      ).data;
    },
  );

  tool(
    "update_project_milestone",
    {
      title: "Update GitLab project milestone",
      description:
        "Update one project milestone by numeric ID, including close or activate state transitions.",
      inputSchema: {
        project,
        milestone_id: milestoneId,
        title: milestoneTitle.optional(),
        description: milestoneDescription.optional(),
        start_date: milestoneDate.optional(),
        due_date: milestoneDate.optional(),
        state_event: milestoneStateEvent.optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, milestone_id, ...fields } = args;
      const body = requireMilestoneUpdate(cleanBody(fields), "Project");
      return (
        await client.request(milestonePath(p(projectValue), milestone_id), {
          method: "PUT",
          body,
        })
      ).data;
    },
  );

  tool(
    "delete_project_milestone",
    {
      title: "Delete GitLab project milestone",
      description:
        "Delete one project milestone only after reading the exact numeric ID and expected current title. Requires explicit destructive acknowledgement.",
      inputSchema: {
        project,
        milestone_id: milestoneId,
        expected_milestone_title: milestoneTitle,
        acknowledge_milestone_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const path = milestonePath(p(args.project), args.milestone_id);
      const milestone = await preflightMilestoneDeletion(client, {
        path,
        id: args.milestone_id,
        expectedTitle: args.expected_milestone_title,
        scope: "Project",
      });
      await client.request(path, { method: "DELETE" });
      return {
        scope: "project",
        milestone_id: milestone.id,
        milestone_title: milestone.title,
        outcome: "deleted",
        changed: true,
      };
    },
  );

  tool(
    "create_group_milestone",
    {
      title: "Create GitLab group milestone",
      description:
        "Create a group milestone with title, optional description, start date, and due date.",
      inputSchema: {
        group: groupIdentifier,
        title: milestoneTitle,
        description: milestoneDescription.optional(),
        start_date: milestoneDate.optional(),
        due_date: milestoneDate.optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { group: groupValue, ...body } = args;
      return (
        await client.request(`${g(groupValue)}/milestones`, {
          method: "POST",
          body: cleanBody(body),
        })
      ).data;
    },
  );

  tool(
    "update_group_milestone",
    {
      title: "Update GitLab group milestone",
      description:
        "Update one group milestone by numeric ID, including close or activate state transitions.",
      inputSchema: {
        group: groupIdentifier,
        milestone_id: milestoneId,
        title: milestoneTitle.optional(),
        description: milestoneDescription.optional(),
        start_date: milestoneDate.optional(),
        due_date: milestoneDate.optional(),
        state_event: milestoneStateEvent.optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { group: groupValue, milestone_id, ...fields } = args;
      const body = requireMilestoneUpdate(cleanBody(fields), "Group");
      return (
        await client.request(milestonePath(g(groupValue), milestone_id), {
          method: "PUT",
          body,
        })
      ).data;
    },
  );

  tool(
    "delete_group_milestone",
    {
      title: "Delete GitLab group milestone",
      description:
        "Delete one group milestone only after reading the exact numeric ID and expected current title. Requires explicit destructive acknowledgement.",
      inputSchema: {
        group: groupIdentifier,
        milestone_id: milestoneId,
        expected_milestone_title: milestoneTitle,
        acknowledge_milestone_deletion: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const path = milestonePath(g(args.group), args.milestone_id);
      const milestone = await preflightMilestoneDeletion(client, {
        path,
        id: args.milestone_id,
        expectedTitle: args.expected_milestone_title,
        scope: "Group",
      });
      await client.request(path, { method: "DELETE" });
      return {
        scope: "group",
        milestone_id: milestone.id,
        milestone_title: milestone.title,
        outcome: "deleted",
        changed: true,
      };
    },
  );
}
