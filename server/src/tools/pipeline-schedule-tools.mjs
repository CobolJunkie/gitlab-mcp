/**
 * Pipeline schedule tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../gitlab-client.mjs";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import {
  project,
  nonEmpty,
  page,
  perPage,
  structuredInputValue,
} from "./schemas.mjs";
import { p } from "./paths.mjs";
import { cleanBody, sanitizeOperatorData } from "./responses.mjs";

/**
 * Schedule variable metadata — returns only the key and optional
 * variable_type.  The submitted value is never included.
 */
function pipelineScheduleVariableMetadata(
  value,
  { key, variable_type: variableType, includeVariableType = true } = {},
) {
  return cleanBody({
    key: value?.key || key,
    ...(includeVariableType
      ? { variable_type: value?.variable_type || variableType }
      : {}),
  });
}

// Schedule inputs can contain sensitive deployment configuration. Preserve
// useful schedule metadata and input names, but never expose input values.
function pipelineScheduleMetadata(value) {
  if (Array.isArray(value)) {
    return value.map((item) => pipelineScheduleMetadata(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const safe = sanitizeOperatorData(value);
  return cleanBody({
    id: safe.id,
    description: safe.description,
    ref: safe.ref,
    cron: safe.cron,
    cron_timezone: safe.cron_timezone,
    next_run_at: safe.next_run_at,
    active: safe.active,
    created_at: safe.created_at,
    updated_at: safe.updated_at,
    last_pipeline: safe.last_pipeline,
    owner: safe.owner,
    variables: safe.variables,
    inputs: Array.isArray(safe.inputs)
      ? safe.inputs.map((input) => cleanBody({ name: input?.name }))
      : undefined,
  });
}

/**
 * Register pipeline schedule tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerPipelineScheduleTools(tool) {
  // ── Schedule reads and core ───────────────────────────────────────────

  tool(
    "list_pipeline_schedules",
    {
      title: "List pipeline schedules",
      description:
        "List project pipeline schedules without exposing schedule variable values.",
      inputSchema: {
        project,
        scope: z.enum(["active", "inactive"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      const response = await client.request(
        `${p(projectValue)}/pipeline_schedules`,
        { query },
      );
      return {
        ...response,
        data: pipelineScheduleMetadata(response.data),
      };
    },
  );

  tool(
    "get_pipeline_schedule",
    {
      title: "Get pipeline schedule",
      description:
        "Get one pipeline schedule without exposing schedule variable values.",
      inputSchema: {
        project,
        pipeline_schedule_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      pipelineScheduleMetadata(
        (
          await client.request(
            `${p(args.project)}/pipeline_schedules/${args.pipeline_schedule_id}`,
          )
        ).data,
      ),
  );

  const createScheduleInputs = z
    .array(
      z.object({
        name: nonEmpty,
        value: structuredInputValue,
      }),
    )
    .max(20)
    .optional();

  const updateScheduleInputs = z
    .array(
      z.object({
        name: nonEmpty,
        value: structuredInputValue.optional(),
        destroy: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional();

  tool(
    "create_pipeline_schedule",
    {
      title: "Create pipeline schedule",
      description: "Create a project pipeline schedule.",
      inputSchema: {
        project,
        description: nonEmpty,
        ref: nonEmpty,
        cron: nonEmpty,
        cron_timezone: z.string().optional(),
        active: z.boolean().optional(),
        inputs: createScheduleInputs,
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      return pipelineScheduleMetadata(
        (
          await client.request(`${p(projectValue)}/pipeline_schedules`, {
            method: "POST",
            body,
          })
        ).data,
      );
    },
  );

  tool(
    "update_pipeline_schedule",
    {
      title: "Update pipeline schedule",
      description: "Update a project pipeline schedule.",
      inputSchema: {
        project,
        pipeline_schedule_id: z.number().int().positive(),
        description: z.string().min(1).optional(),
        cron: z.string().min(1).optional(),
        cron_timezone: z.string().optional(),
        active: z.boolean().optional(),
        inputs: updateScheduleInputs,
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, pipeline_schedule_id, ...body } = args;
      return pipelineScheduleMetadata(
        (
          await client.request(
            `${p(projectValue)}/pipeline_schedules/${pipeline_schedule_id}`,
            { method: "PUT", body },
          )
        ).data,
      );
    },
  );

  // ── Schedule variable tools ──────────────────────────────────────────

  const pipelineScheduleVariableInput = {
    project,
    pipeline_schedule_id: z.number().int().positive(),
    key: z.string().min(1).max(255).regex(/^\w+$/),
    value: z.string(),
    variable_type: z.enum(["env_var", "file"]).optional(),
  };

  tool(
    "create_pipeline_schedule_variable",
    {
      title: "Create pipeline schedule variable",
      description:
        "Create a pipeline schedule variable without returning its value.",
      inputSchema: pipelineScheduleVariableInput,
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, pipeline_schedule_id, ...body } = args;
      const response = await client.request(
        `${p(projectValue)}/pipeline_schedules/${pipeline_schedule_id}/variables`,
        { method: "POST", body },
      );
      return pipelineScheduleVariableMetadata(response.data, args);
    },
  );

  tool(
    "update_pipeline_schedule_variable",
    {
      title: "Update pipeline schedule variable",
      description:
        "Update a pipeline schedule variable without returning its value.",
      inputSchema: pipelineScheduleVariableInput,
      annotations: WRITE,
    },
    async (client, args) => {
      const {
        project: projectValue,
        pipeline_schedule_id,
        key,
        ...body
      } = args;
      const response = await client.request(
        `${p(projectValue)}/pipeline_schedules/${pipeline_schedule_id}/variables/${encodePathSegment(key)}`,
        { method: "PUT", body },
      );
      return pipelineScheduleVariableMetadata(response.data, args);
    },
  );

  tool(
    "delete_pipeline_schedule_variable",
    {
      title: "Delete pipeline schedule variable",
      description:
        "Delete a pipeline schedule variable without returning its former value.",
      inputSchema: {
        project,
        pipeline_schedule_id: z.number().int().positive(),
        key: z.string().min(1).max(255),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const response = await client.request(
        `${p(args.project)}/pipeline_schedules/${args.pipeline_schedule_id}/variables/${encodePathSegment(args.key)}`,
        { method: "DELETE" },
      );
      return pipelineScheduleVariableMetadata(response.data, {
        ...args,
        includeVariableType: false,
      });
    },
  );

  // ── Schedule action tools ────────────────────────────────────────────

  tool(
    "delete_pipeline_schedule",
    {
      title: "Delete pipeline schedule",
      description: "Delete a project pipeline schedule.",
      inputSchema: {
        project,
        pipeline_schedule_id: z.number().int().positive(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/pipeline_schedules/${args.pipeline_schedule_id}`,
          { method: "DELETE" },
        )
      ).data,
  );

  tool(
    "run_pipeline_schedule",
    {
      title: "Run pipeline schedule",
      description: "Run a project pipeline schedule immediately.",
      inputSchema: {
        project,
        pipeline_schedule_id: z.number().int().positive(),
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/pipeline_schedules/${args.pipeline_schedule_id}/play`,
          { method: "POST" },
        )
      ).data,
  );

  tool(
    "take_ownership_pipeline_schedule",
    {
      title: "Take ownership of pipeline schedule",
      description:
        "Make the current GitLab user the owner of a pipeline schedule.",
      inputSchema: {
        project,
        pipeline_schedule_id: z.number().int().positive(),
      },
      annotations: WRITE,
    },
    async (client, args) =>
      pipelineScheduleMetadata(
        (
          await client.request(
            `${p(args.project)}/pipeline_schedules/${args.pipeline_schedule_id}/take_ownership`,
            { method: "POST" },
          )
        ).data,
      ),
  );
}
