/**
 * Environment and deployment inspection tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 *
 * All tools in this module are read-only.  Mutation tools (stop
 * environment, approve/reject deployment) are deliberately excluded and
 * should be added in a later explicitly safe design.
 *
 * Deployment approval data (`approval_summary`) is only available on
 * GitLab Premium and Ultimate.  Free and Premium instances return the
 * deployment without approval fields; tools surface the raw data rather
 * than synthesizing missing tier information.
 */

import * as z from "zod/v4";

import { READ_ONLY } from "./annotations.mjs";
import { project, page, perPage } from "./schemas.mjs";
import { p } from "./paths.mjs";

/**
 * Register environment and deployment inspection tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerDeploymentTools(tool) {
  // ── Environment tools ───────────────────────────────────────────────

  tool(
    "list_environments",
    {
      title: "List GitLab environments",
      description:
        "List all environments for a project, optionally filtered by name, search term, or state (available, stopping, stopped).",
      inputSchema: {
        project,
        name: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Return the environment with this name. Mutually exclusive with search.",
          ),
        search: z
          .string()
          .min(3)
          .optional()
          .describe(
            "Search environments by name. Mutually exclusive with name. Must be at least 3 characters.",
          ),
        states: z
          .string()
          .optional()
          .describe(
            "Comma-separated state filter. Accepted values: available, stopping, stopped.",
          ),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/environments`, { query });
    },
  );

  tool(
    "get_environment",
    {
      title: "Get GitLab environment",
      description: "Retrieve a single environment by its numeric ID.",
      inputSchema: {
        project,
        environment_id: z
          .number()
          .int()
          .positive()
          .describe("Numeric ID of the environment."),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/environments/${args.environment_id}`,
        )
      ).data,
  );

  // ── Deployment tools ────────────────────────────────────────────────

  tool(
    "list_deployments",
    {
      title: "List GitLab deployments",
      description:
        "List deployments for a project with status, environment, ordering, and time-range filters. Pagination is bounded to 100 per page.",
      inputSchema: {
        project,
        order_by: z
          .enum(["id", "iid", "created_at", "updated_at", "finished_at", "ref"])
          .optional()
          .describe("Field to order by. Default is id."),
        sort: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort order. Default is asc."),
        status: z
          .enum([
            "created",
            "running",
            "success",
            "failed",
            "canceled",
            "blocked",
          ])
          .optional()
          .describe("Filter deployments by status."),
        environment: z
          .string()
          .min(1)
          .optional()
          .describe("Filter deployments by environment name."),
        ref: z
          .string()
          .min(1)
          .optional()
          .describe("Filter deployments by Git ref."),
        updated_after: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Return deployments updated after this ISO 8601 datetime."),
        updated_before: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "Return deployments updated before this ISO 8601 datetime.",
          ),
        finished_after: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "Return deployments finished after this ISO 8601 datetime. Use with order_by=finished_at.",
          ),
        finished_before: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "Return deployments finished before this ISO 8601 datetime. Use with order_by=finished_at.",
          ),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/deployments`, { query });
    },
  );

  tool(
    "get_deployment",
    {
      title: "Get GitLab deployment",
      description:
        "Retrieve a single deployment with status, environment, deployable, pipeline, and (on Premium/Ultimate) approval summary information.",
      inputSchema: {
        project,
        deployment_id: z
          .number()
          .int()
          .positive()
          .describe("Numeric ID of the deployment."),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/deployments/${args.deployment_id}`,
        )
      ).data,
  );

  tool(
    "get_deployment_approval_status",
    {
      title: "Get deployment approval status",
      description:
        "Retrieve the approval status for a deployment, including approval rules and individual approval decisions. Requires GitLab Premium or Ultimate with protected-environment approval rules configured. On Free or non-protected environments the approval fields may be absent.",
      inputSchema: {
        project,
        deployment_id: z
          .number()
          .int()
          .positive()
          .describe("Numeric ID of the deployment."),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const response = await client.request(
        `${p(args.project)}/deployments/${args.deployment_id}`,
      );
      const deployment = response.data;
      return {
        deployment_id: deployment.id,
        iid: deployment.iid,
        status: deployment.status,
        ref: deployment.ref,
        sha: deployment.sha,
        environment: deployment.environment,
        approval_summary: deployment.approval_summary ?? null,
      };
    },
  );
}
