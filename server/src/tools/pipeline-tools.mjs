/**
 * Pipeline and CI tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../gitlab-client.mjs";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import {
  project,
  nonEmpty,
  page,
  perPage,
  sha,
  stringArray,
  structuredInputValue,
} from "./schemas.mjs";
import { p, filePath } from "./paths.mjs";
import { cleanBody, sanitizeOperatorData } from "./responses.mjs";

const MAX_ARTIFACT_REPOSITORY_BYTES = 5_000_000;

function validateRepositoryTransferPath(path, label) {
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe ${label} path: "${path}".`);
  }
}

async function requireArtifactTargetHead(
  client,
  projectValue,
  branch,
  expectedHeadSha,
) {
  const branchPath = `${p(projectValue)}/repository/branches/${encodePathSegment(
    branch,
  )}`;
  const response = await client.request(branchPath);
  const currentHeadSha = response.data?.commit?.id;
  if (currentHeadSha !== expectedHeadSha) {
    throw new GitLabApiError(
      "Artifact repository commit rejected because the target branch no longer matches expected_head_sha.",
      {
        status: 409,
        method: "GET",
        path: branchPath,
        response: {
          expected_head_sha: expectedHeadSha,
          actual_branch_sha: currentHeadSha,
        },
      },
    );
  }
}

async function getRepositoryFileAtRef(client, projectValue, path, ref) {
  try {
    return (
      await client.request(filePath(projectValue, path), {
        query: { ref },
      })
    ).data;
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function pipelineRetryErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDefinitivePipelineRetryRejection(error) {
  const status = error instanceof GitLabApiError ? error.status : undefined;
  return (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409
  );
}

async function throwAmbiguousPipelineRetryOutcome(client, args, retryError) {
  const pipelinePath = `${p(args.project)}/pipelines/${args.pipeline_id}`;
  const retryMessage = pipelineRetryErrorMessage(retryError);
  let pipelineStatus = "unknown";
  let visibleJobCount;

  try {
    const pipeline = await client.request(pipelinePath);
    if (typeof pipeline.data?.status === "string") {
      pipelineStatus = pipeline.data.status;
    }
    const jobs = await client.request(`${pipelinePath}/jobs`, {
      query: { include_retried: true, page: 1, per_page: 100 },
    });
    if (!Array.isArray(jobs.data)) {
      throw new TypeError(
        "GitLab returned an invalid pipeline-jobs response during retry reconciliation.",
      );
    }
    visibleJobCount = jobs.data.length;
  } catch (postflightError) {
    const postflightMessage = pipelineRetryErrorMessage(postflightError);
    throw new Error(
      `Pipeline retry outcome is ambiguous because GitLab did not provide a definitive retry response (${retryMessage}) and postflight verification failed: ${postflightMessage} Re-read pipeline ${args.pipeline_id} and its jobs with include_retried=true before any retry or further mutation.`,
      { cause: retryError },
    );
  }

  throw new Error(
    `Pipeline retry outcome is ambiguous because GitLab did not provide a definitive retry response (${retryMessage}). Postflight currently reports pipeline status "${pipelineStatus}" and ${visibleJobCount} job(s) on the first page with retried jobs included, but current state cannot prove whether this request created any retry jobs. Re-read pipeline ${args.pipeline_id} and its jobs with include_retried=true before any retry or further mutation.`,
    { cause: retryError },
  );
}

/**
 * Register pipeline and CI tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerPipelineTools(tool) {
  // ── Core pipeline tools ─────────────────────────────────────────────

  tool(
    "list_pipelines",
    {
      title: "List GitLab pipelines",
      description:
        "List project pipelines by status, ref, source, user, or update time.",
      inputSchema: {
        project,
        status: z
          .enum([
            "created",
            "waiting_for_resource",
            "preparing",
            "waiting_for_callback",
            "pending",
            "running",
            "success",
            "failed",
            "canceling",
            "canceled",
            "skipped",
            "manual",
            "scheduled",
          ])
          .optional(),
        ref: z.string().optional(),
        sha: z.string().optional(),
        username: z.string().optional(),
        source: z.string().optional(),
        name: z.string().optional(),
        order_by: z
          .enum(["id", "status", "ref", "updated_at", "user_id"])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        updated_after: z.string().datetime({ offset: true }).optional(),
        updated_before: z.string().datetime({ offset: true }).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/pipelines`, { query });
    },
  );

  const pipelineVariable = z.object({
    key: z.string().min(1).max(255).regex(/^\w+$/),
    value: z.string().max(10_000),
    variable_type: z.enum(["env_var", "file"]).optional(),
  });
  tool(
    "create_pipeline",
    {
      title: "Create pipeline",
      description:
        "Create a GitLab pipeline for a ref with bounded structured inputs or variables. Variable values are sent only to GitLab and are omitted from the normalized response. Input values may be strings, numbers, booleans, arrays, or objects — bounded by depth, length, and size limits.",
      inputSchema: {
        project,
        ref: nonEmpty,
        inputs: z
          .record(z.string().min(1).max(255), structuredInputValue)
          .refine((value) => Object.keys(value).length <= 20, {
            message: "At most 20 pipeline inputs may be supplied.",
          })
          .optional(),
        variables: z.array(pipelineVariable).max(50).optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      const response = await client.request(`${p(projectValue)}/pipeline`, {
        method: "POST",
        body,
      });
      return sanitizeOperatorData(response.data);
    },
  );

  tool(
    "get_latest_pipeline",
    {
      title: "Get latest pipeline",
      description: "Get the latest pipeline for a project ref.",
      inputSchema: { project, ref: nonEmpty },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(`${p(args.project)}/pipelines/latest`, {
          query: { ref: args.ref },
        })
      ).data,
  );

  tool(
    "get_pipeline_test_report",
    {
      title: "Get pipeline test report",
      description:
        "Get bounded test-suite and test-case results for one pipeline.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/pipelines/${args.pipeline_id}/test_report`,
        )
      ).data,
  );

  tool(
    "get_pipeline_test_report_summary",
    {
      title: "Get pipeline test report summary",
      description:
        "Get aggregate test-report counts and pass/fail/error totals for one pipeline.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/pipelines/${args.pipeline_id}/test_report_summary`,
        )
      ).data,
  );

  tool(
    "list_pipeline_bridges",
    {
      title: "List pipeline bridges",
      description:
        "List bridge jobs for a pipeline to discover downstream child or multi-project pipelines.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().positive(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(
        `${p(args.project)}/pipelines/${args.pipeline_id}/bridges`,
        {
          query: { page: args.page, per_page: args.per_page },
        },
      ),
  );

  tool(
    "get_pipeline",
    {
      title: "Get GitLab pipeline",
      description:
        "Get one pipeline with status, duration, coverage, ref, user, and timestamps.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (await client.request(`${p(args.project)}/pipelines/${args.pipeline_id}`))
        .data,
  );

  // ── Pipeline job and artifact tools ─────────────────────────────────

  tool(
    "list_pipeline_jobs",
    {
      title: "List pipeline jobs",
      description:
        "List jobs in a GitLab pipeline, including stages, status, runner, artifacts, and failure reason.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().positive(),
        scope: z
          .array(
            z.enum([
              "created",
              "pending",
              "running",
              "failed",
              "success",
              "canceled",
              "skipped",
              "waiting_for_resource",
              "manual",
            ]),
          )
          .optional(),
        include_retried: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(`${p(args.project)}/pipelines/${args.pipeline_id}/jobs`, {
        query: {
          "scope[]": args.scope,
          include_retried: args.include_retried,
          page: args.page,
          per_page: args.per_page,
        },
      }),
  );

  tool(
    "get_job",
    {
      title: "Get GitLab job",
      description:
        "Get detailed status, runner, artifacts, timestamps, commit, and pipeline information for one CI job.",
      inputSchema: {
        project,
        job_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (await client.request(`${p(args.project)}/jobs/${args.job_id}`)).data,
  );

  tool(
    "list_project_jobs",
    {
      title: "List GitLab project jobs",
      description: "List recent jobs across all pipelines in a GitLab project.",
      inputSchema: {
        project,
        scope: z
          .array(
            z.enum([
              "created",
              "pending",
              "running",
              "failed",
              "success",
              "canceled",
              "skipped",
              "waiting_for_resource",
              "manual",
            ]),
          )
          .optional(),
        include_retried: z.boolean().optional(),
        order_by: z.enum(["id"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, scope, ...query } = args;
      return client.request(`${p(projectValue)}/jobs`, {
        query: {
          ...query,
          "scope[]": scope,
        },
      });
    },
  );

  tool(
    "get_job_log",
    {
      title: "Get GitLab job log",
      description:
        "Retrieve the plain-text trace for a GitLab CI job, up to the configured response safety limit.",
      inputSchema: {
        project,
        job_id: z.number().int().positive(),
        max_bytes: z.number().int().min(1_000).max(5_000_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(`${p(args.project)}/jobs/${args.job_id}/trace`, {
          responseType: "text",
          maxBytes: args.max_bytes || 1_000_000,
        })
      ).data,
  );

  tool(
    "get_job_artifact_file",
    {
      title: "Get job artifact file",
      description:
        "Download one file from a GitLab job artifact archive as base64, subject to a strict size limit.",
      inputSchema: {
        project,
        job_id: z.number().int().positive(),
        artifact_path: nonEmpty,
        max_bytes: z.number().int().min(1_000).max(5_000_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/jobs/${args.job_id}/artifacts/${encodePathSegment(args.artifact_path)}`,
          {
            responseType: "binary",
            maxBytes: args.max_bytes || 1_000_000,
          },
        )
      ).data,
  );

  tool(
    "get_job_artifact_archive",
    {
      title: "Get job artifact archive",
      description:
        "Download a GitLab job's complete artifact ZIP archive as bounded base64 data.",
      inputSchema: {
        project,
        job_id: z.number().int().positive(),
        max_bytes: z.number().int().min(1_000).max(10_000_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/jobs/${args.job_id}/artifacts`,
          {
            responseType: "binary",
            maxBytes: args.max_bytes || 5_000_000,
          },
        )
      ).data,
  );

  tool(
    "commit_job_artifact_file",
    {
      title: "Commit job artifact file",
      description:
        "Copy one bounded file from a same-instance GitLab job artifact directly into one repository commit without returning the file contents through MCP. The target branch must match expected_head_sha; create mode rejects existing targets and update mode requires an existing target and carries its last_commit_id concurrency guard.",
      inputSchema: {
        source_project: project,
        job_id: z.number().int().positive(),
        artifact_path: nonEmpty,
        target_project: project,
        target_branch: nonEmpty,
        target_path: nonEmpty,
        expected_head_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe(
            "Full reviewed target-branch head SHA. The operation fails closed if the branch has moved.",
          ),
        mode: z.enum(["create", "update"]),
        commit_message: nonEmpty,
        max_bytes: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_ARTIFACT_REPOSITORY_BYTES)
          .optional(),
        author_email: z.string().email().optional(),
        author_name: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      validateRepositoryTransferPath(args.artifact_path, "artifact");
      validateRepositoryTransferPath(args.target_path, "repository target");

      await requireArtifactTargetHead(
        client,
        args.target_project,
        args.target_branch,
        args.expected_head_sha,
      );

      const artifact = (
        await client.request(
          `${p(args.source_project)}/jobs/${args.job_id}/artifacts/${encodePathSegment(
            args.artifact_path,
          )}`,
          {
            responseType: "binary",
            maxBytes: args.max_bytes || 1_000_000,
          },
        )
      ).data;
      if (
        artifact?.encoding !== "base64" ||
        typeof artifact.content !== "string" ||
        !Number.isSafeInteger(artifact.contentLength) ||
        artifact.contentLength < 0
      ) {
        throw new Error(
          "GitLab returned an invalid bounded artifact-file response.",
        );
      }

      const target = await getRepositoryFileAtRef(
        client,
        args.target_project,
        args.target_path,
        args.expected_head_sha,
      );
      if (args.mode === "create" && target) {
        throw new GitLabApiError(
          `Artifact repository create rejected because "${args.target_path}" already exists.`,
          {
            status: 409,
            method: "GET",
            path: filePath(args.target_project, args.target_path),
          },
        );
      }
      if (args.mode === "update" && !target) {
        throw new GitLabApiError(
          `Artifact repository update rejected because "${args.target_path}" does not exist.`,
          {
            status: 404,
            method: "GET",
            path: filePath(args.target_project, args.target_path),
          },
        );
      }
      if (args.mode === "update" && !target?.last_commit_id) {
        throw new Error(
          `Cannot update "${args.target_path}": GitLab did not return last_commit_id for concurrency protection.`,
        );
      }

      await requireArtifactTargetHead(
        client,
        args.target_project,
        args.target_branch,
        args.expected_head_sha,
      );

      const action = {
        action: args.mode,
        file_path: args.target_path,
        content: artifact.content,
        encoding: "base64",
        ...(args.mode === "update"
          ? { last_commit_id: target.last_commit_id }
          : {}),
      };
      const commit = (
        await client.request(`${p(args.target_project)}/repository/commits`, {
          method: "POST",
          body: cleanBody({
            branch: args.target_branch,
            commit_message: args.commit_message,
            actions: [action],
            author_email: args.author_email,
            author_name: args.author_name,
          }),
        })
      ).data;

      const committedPath = `${p(args.target_project)}/repository/commits/${encodePathSegment(
        commit.id,
      )}`;
      let committed;
      try {
        committed = (await client.request(committedPath)).data;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Artifact repository commit postcondition is ambiguous after GitLab accepted the commit: ${message} The branch may have changed; re-read it before making any further mutation.`,
          { cause: error },
        );
      }
      if (
        !Array.isArray(committed?.parent_ids) ||
        committed.parent_ids.length !== 1 ||
        committed.parent_ids[0] !== args.expected_head_sha
      ) {
        throw new GitLabApiError(
          "Artifact repository commit completed but the resulting commit does not directly descend from expected_head_sha. The branch may have changed concurrently; re-read it before making any further mutation.",
          {
            status: 409,
            method: "GET",
            path: committedPath,
            response: {
              expected_parent_sha: args.expected_head_sha,
              resulting_commit_sha: commit.id,
              actual_parent_shas: committed?.parent_ids,
            },
          },
        );
      }
      try {
        await requireArtifactTargetHead(
          client,
          args.target_project,
          args.target_branch,
          commit.id,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Artifact repository commit succeeded, but the target branch no longer points at the resulting commit: ${message} The branch changed concurrently; re-read it before making any further mutation.`,
          { cause: error },
        );
      }

      return {
        ...commit,
        source: {
          project: args.source_project,
          job_id: args.job_id,
          artifact_path: args.artifact_path,
          content_length: artifact.contentLength,
        },
        target: {
          project: args.target_project,
          branch: args.target_branch,
          path: args.target_path,
          mode: args.mode,
        },
        changed_paths: [args.target_path],
      };
    },
  );

  // ── Pipeline and job action tools ───────────────────────────────────

  tool(
    "retry_pipeline",
    {
      title: "Retry pipeline",
      description: "Retry failed or canceled jobs in a GitLab pipeline.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().positive(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const retryPath = `${p(args.project)}/pipelines/${args.pipeline_id}/retry`;
      try {
        return (await client.request(retryPath, { method: "POST" })).data;
      } catch (error) {
        if (isDefinitivePipelineRetryRejection(error)) {
          throw error;
        }
        await throwAmbiguousPipelineRetryOutcome(client, args, error);
      }
    },
  );

  tool(
    "cancel_pipeline",
    {
      title: "Cancel pipeline",
      description: "Cancel all cancelable jobs in a running GitLab pipeline.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().positive(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/pipelines/${args.pipeline_id}/cancel`,
          { method: "POST" },
        )
      ).data,
  );

  for (const [name, suffix, title, description, annotations] of [
    [
      "retry_job",
      "retry",
      "Retry GitLab job",
      "Retry a failed or canceled GitLab CI job.",
      WRITE,
    ],
    [
      "cancel_job",
      "cancel",
      "Cancel GitLab job",
      "Cancel a pending or running GitLab CI job.",
      DESTRUCTIVE,
    ],
    [
      "play_job",
      "play",
      "Play manual GitLab job",
      "Start a manual GitLab CI job.",
      WRITE,
    ],
  ]) {
    /** @type {string} */
    const suffixValue = suffix;
    tool(
      name,
      {
        title,
        description,
        inputSchema:
          name === "play_job"
            ? {
                project,
                job_id: z.number().int().positive(),
                job_variables_attributes: z
                  .array(
                    z.object({
                      key: nonEmpty,
                      value: z.string(),
                    }),
                  )
                  .optional(),
              }
            : {
                project,
                job_id: z.number().int().positive(),
              },
        annotations,
      },
      async (client, args) =>
        (
          await client.request(
            `${p(args.project)}/jobs/${args.job_id}/${suffixValue}`,
            {
              method: "POST",
              body:
                name === "play_job" && args.job_variables_attributes
                  ? {
                      job_variables_attributes: args.job_variables_attributes,
                    }
                  : undefined,
            },
          )
        ).data,
    );
  }

  // ── Runner, CI lint, and commit status tools ────────────────────────

  tool(
    "list_project_runners",
    {
      title: "List project runners",
      description:
        "List runners available to a project without returning runner authentication tokens or CI variables.",
      inputSchema: {
        project,
        scope: z.enum(["active", "paused", "online", "offline"]).optional(),
        type: z
          .enum(["instance_type", "group_type", "project_type"])
          .optional(),
        status: z
          .enum(["online", "offline", "stale", "never_contacted"])
          .optional(),
        paused: z.boolean().optional(),
        tag_list: stringArray.optional(),
        version_prefix: z.string().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, tag_list, ...query } = args;
      const response = await client.request(`${p(projectValue)}/runners`, {
        query: cleanBody({
          ...query,
          tag_list: tag_list?.join(","),
        }),
      });
      return {
        ...response,
        data: sanitizeOperatorData(response.data),
      };
    },
  );

  tool(
    "lint_ci_configuration",
    {
      title: "Lint project CI configuration",
      description:
        "Validate GitLab CI YAML in project context and return status, errors, warnings, and jobs without returning merged YAML or protected variables.",
      inputSchema: {
        project,
        content: z.string().min(1).max(1_000_000),
        ref: z.string().optional(),
        dry_run: z.boolean().optional(),
        include_jobs: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      const response = await client.request(`${p(projectValue)}/ci/lint`, {
        method: "POST",
        body,
      });
      return sanitizeOperatorData(response.data);
    },
  );

  tool(
    "list_commit_statuses",
    {
      title: "List commit statuses",
      description:
        "List CI and external status checks attached to a GitLab commit.",
      inputSchema: {
        project,
        sha,
        ref: z.string().optional(),
        stage: z.string().optional(),
        name: z.string().optional(),
        all: z.boolean().optional(),
        order_by: z.enum(["id", "ref", "sha"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, sha: commitSha, ...query } = args;
      return client.request(
        `${p(projectValue)}/repository/commits/${encodePathSegment(commitSha)}/statuses`,
        { query },
      );
    },
  );

  tool(
    "create_commit_status",
    {
      title: "Create commit status",
      description:
        "Create or update an external GitLab commit status for a ref.",
      inputSchema: {
        project,
        sha,
        state: z.enum([
          "pending",
          "running",
          "success",
          "failed",
          "canceled",
          "skipped",
        ]),
        ref: z.string().optional(),
        name: z.string().optional(),
        target_url: z.string().url().optional(),
        description: z.string().max(255).optional(),
        coverage: z.number().min(0).max(100).optional(),
        pipeline_id: z.number().int().positive().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const { project: projectValue, sha: commitSha, ...query } = args;
      return (
        await client.request(
          `${p(projectValue)}/statuses/${encodePathSegment(commitSha)}`,
          { method: "POST", query },
        )
      ).data;
    },
  );
}
