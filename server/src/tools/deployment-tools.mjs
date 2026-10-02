/**
 * Environment and deployment tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 *
 * Inspection tools are read-only. Environment lifecycle mutations use exact
 * ID/name preflights, explicit acknowledgements, bounded results, and
 * idempotent handling for already-stopped or already-absent cleanup targets.
 *
 * Deployment approval data (`approval_summary`) is only available on
 * GitLab Premium and Ultimate. Free instances return the deployment without
 * approval fields; tools surface the raw data rather than synthesizing missing
 * tier information.
 */

import * as z from "zod/v4";

import { GitLabApiError } from "../gitlab-client.mjs";
import { IDEMPOTENT_DESTRUCTIVE, READ_ONLY } from "./annotations.mjs";
import { project, page, perPage } from "./schemas.mjs";
import { p } from "./paths.mjs";

const DEPLOYMENT_REF_SCAN_PER_PAGE = 100;
const DEPLOYMENT_REF_SCAN_MAX_PAGES = 100;
const DEFAULT_LIST_PAGE = 1;
const DEFAULT_LIST_PER_PAGE = 20;

function environmentPath(projectValue, environmentId) {
  return `${p(projectValue)}/environments/${environmentId}`;
}

function deploymentRefScanLimitError() {
  return new Error(
    `Deployment ref filter exceeded the bounded scan of ${DEPLOYMENT_REF_SCAN_MAX_PAGES} pages. Narrow the server-side environment, status, or time-range filters before retrying.`,
  );
}

function filteredPagination(pageNumber, perPageValue, total) {
  const totalPages = Math.max(1, Math.ceil(total / perPageValue));
  return {
    page: pageNumber,
    perPage: perPageValue,
    ...(pageNumber < totalPages ? { nextPage: pageNumber + 1 } : {}),
    ...(pageNumber > 1 && pageNumber <= totalPages
      ? { previousPage: pageNumber - 1 }
      : {}),
    total,
    totalPages,
  };
}

function invalidDeploymentPaginationError(
  message = "Deployment ref filtering received invalid upstream pagination.",
) {
  return new TypeError(message);
}

function derivedDeploymentTotalPages(total, perPageValue) {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(perPageValue) ||
    perPageValue <= 0
  ) {
    return undefined;
  }
  return Math.max(1, Math.ceil(total / perPageValue));
}

function deploymentPaginationIsInvalid({
  reportedPage,
  reportedPerPage,
  total,
  totalPages,
  derivedTotalPages,
  currentPage,
  rowCount,
}) {
  const invalidReportedPage =
    reportedPage !== undefined &&
    (!Number.isSafeInteger(reportedPage) || reportedPage !== currentPage);
  const invalidReportedPerPage =
    reportedPerPage !== undefined &&
    (!Number.isSafeInteger(reportedPerPage) ||
      reportedPerPage <= 0 ||
      reportedPerPage > DEPLOYMENT_REF_SCAN_PER_PAGE);
  const invalidTotal =
    total !== undefined && (!Number.isSafeInteger(total) || total < 0);
  const invalidTotalPages =
    totalPages !== undefined &&
    (!Number.isSafeInteger(totalPages) || totalPages < 0);
  const inconsistentTotalPages =
    derivedTotalPages !== undefined &&
    totalPages !== undefined &&
    totalPages !== derivedTotalPages &&
    !(total === 0 && totalPages === 0);
  const invalidRowCount =
    rowCount > DEPLOYMENT_REF_SCAN_PER_PAGE ||
    (reportedPerPage !== undefined && rowCount > reportedPerPage) ||
    (total !== undefined && rowCount > total);

  return (
    invalidReportedPage ||
    invalidReportedPerPage ||
    invalidTotal ||
    invalidTotalPages ||
    inconsistentTotalPages ||
    invalidRowCount
  );
}

function readDeploymentPagination(response, currentPage, rowCount) {
  const pagination = response?.pagination;
  const metadata = {
    nextPage: pagination?.nextPage,
    reportedPage: pagination?.page,
    reportedPerPage: pagination?.perPage,
    total: pagination?.total,
    totalPages: pagination?.totalPages,
  };
  const derivedTotalPages = derivedDeploymentTotalPages(
    metadata.total,
    metadata.reportedPerPage,
  );
  if (
    deploymentPaginationIsInvalid({
      ...metadata,
      derivedTotalPages,
      currentPage,
      rowCount,
    })
  ) {
    throw invalidDeploymentPaginationError();
  }
  return {
    ...metadata,
    knownTotalPages: metadata.totalPages ?? derivedTotalPages,
  };
}

function explicitNextDeploymentPage(nextPage, currentPage, knownTotalPages) {
  if (nextPage === undefined) return undefined;

  const outsideKnownRange =
    knownTotalPages !== undefined &&
    (knownTotalPages === 0 || currentPage >= knownTotalPages);
  if (
    !Number.isSafeInteger(nextPage) ||
    nextPage !== currentPage + 1 ||
    outsideKnownRange
  ) {
    throw invalidDeploymentPaginationError();
  }
  return nextPage;
}

function nextPageFromKnownDeploymentTotal(
  knownTotalPages,
  currentPage,
  rowCount,
) {
  if (knownTotalPages === undefined) return undefined;
  if (knownTotalPages === 0) {
    if (rowCount > 0) throw invalidDeploymentPaginationError();
    return null;
  }
  if (currentPage > knownTotalPages) {
    throw invalidDeploymentPaginationError();
  }
  if (currentPage < knownTotalPages) return currentPage + 1;
  if (knownTotalPages > 1 && rowCount === 0) {
    throw invalidDeploymentPaginationError(
      "Deployment ref filtering received an empty terminal page for a multi-page result.",
    );
  }
  return null;
}

function nextDeploymentScanPage(response, currentPage, rowCount) {
  const { nextPage, reportedPerPage, knownTotalPages } =
    readDeploymentPagination(response, currentPage, rowCount);

  if (
    knownTotalPages !== undefined &&
    knownTotalPages > DEPLOYMENT_REF_SCAN_MAX_PAGES
  ) {
    throw deploymentRefScanLimitError();
  }

  const explicitPage = explicitNextDeploymentPage(
    nextPage,
    currentPage,
    knownTotalPages,
  );
  if (explicitPage !== undefined) return explicitPage;

  const knownPage = nextPageFromKnownDeploymentTotal(
    knownTotalPages,
    currentPage,
    rowCount,
  );
  if (knownPage !== undefined) return knownPage;

  const sparsePerPage = reportedPerPage ?? DEPLOYMENT_REF_SCAN_PER_PAGE;
  return rowCount < sparsePerPage ? null : currentPage + 1;
}

function requireDeploymentRows(response) {
  if (!Array.isArray(response?.data)) {
    throw new TypeError(
      "Deployment ref filtering received an invalid upstream response.",
    );
  }
  return response.data;
}

function createDeploymentRefScanState() {
  return {
    pageMatches: [],
    totalMatches: 0,
    scannedRows: 0,
    expectedUpstreamPerPage: undefined,
    expectedUpstreamTotal: undefined,
    expectedUpstreamTotalPages: undefined,
    upstreamPage: 1,
  };
}

function assertStableDeploymentPaginationValue(
  expected,
  reported,
  errorMessage,
) {
  if (
    expected !== undefined &&
    reported !== undefined &&
    expected !== reported
  ) {
    throw new Error(errorMessage);
  }
}

function updateDeploymentRefScanMetadata(state, response, rowCount) {
  const reported = {
    perPage: response.pagination?.perPage,
    total: response.pagination?.total,
    totalPages: response.pagination?.totalPages,
  };
  assertStableDeploymentPaginationValue(
    state.expectedUpstreamPerPage,
    reported.perPage,
    "Deployment ref filtering received inconsistent upstream pagination metadata.",
  );
  assertStableDeploymentPaginationValue(
    state.expectedUpstreamTotalPages,
    reported.totalPages,
    "Deployment ref filtering received inconsistent upstream pagination metadata.",
  );
  assertStableDeploymentPaginationValue(
    state.expectedUpstreamTotal,
    reported.total,
    "Deployment ref filtering received inconsistent upstream pagination totals.",
  );

  state.expectedUpstreamPerPage ??= reported.perPage;
  state.expectedUpstreamTotal ??= reported.total;
  state.expectedUpstreamTotalPages ??= reported.totalPages;

  if (
    state.expectedUpstreamTotal !== undefined &&
    state.scannedRows + rowCount > state.expectedUpstreamTotal
  ) {
    throw new Error(
      "Deployment ref filtering received inconsistent upstream pagination totals.",
    );
  }
  return reported;
}

function collectDeploymentRefMatches(
  state,
  rows,
  ref,
  requestedStart,
  requestedPerPage,
) {
  for (const deployment of rows) {
    if (
      deployment === null ||
      typeof deployment !== "object" ||
      typeof deployment.ref !== "string"
    ) {
      throw new TypeError(
        "Deployment ref filtering received a deployment without a valid ref.",
      );
    }
    if (deployment.ref !== ref) continue;
    if (
      state.totalMatches >= requestedStart &&
      state.pageMatches.length < requestedPerPage
    ) {
      state.pageMatches.push(deployment);
    }
    state.totalMatches += 1;
  }
  state.scannedRows += rows.length;
}

function deploymentNavigationPagination(response, state, reported) {
  return {
    ...response.pagination,
    ...(reported.perPage === undefined &&
    state.expectedUpstreamPerPage !== undefined
      ? { perPage: state.expectedUpstreamPerPage }
      : {}),
    ...(reported.total === undefined &&
    state.expectedUpstreamTotal !== undefined
      ? { total: state.expectedUpstreamTotal }
      : {}),
    ...(reported.totalPages === undefined &&
    state.expectedUpstreamTotalPages !== undefined
      ? { totalPages: state.expectedUpstreamTotalPages }
      : {}),
  };
}

function reconcileDeploymentTotalExhaustion(
  state,
  response,
  navigationPagination,
  currentPage,
  nextPage,
) {
  if (
    state.expectedUpstreamTotal === undefined ||
    state.scannedRows !== state.expectedUpstreamTotal
  ) {
    return nextPage;
  }

  const explicitContinuation = response.pagination?.nextPage !== undefined;
  const declaredContinuation =
    navigationPagination.totalPages !== undefined &&
    navigationPagination.totalPages > currentPage;
  if (explicitContinuation || declaredContinuation) {
    throw new Error(
      "Deployment ref filtering received continuation after exhausting the upstream total.",
    );
  }
  return navigationPagination.totalPages === undefined ? null : nextPage;
}

function deploymentRefScanIsComplete(state, nextPage, rowCount) {
  if (nextPage !== null && rowCount === 0) {
    throw new Error(
      "Deployment ref filtering received an empty page with more upstream pages reported.",
    );
  }
  if (nextPage !== null) return false;
  if (
    state.expectedUpstreamTotal !== undefined &&
    state.scannedRows !== state.expectedUpstreamTotal
  ) {
    throw new Error(
      "Deployment ref filtering received incomplete upstream pagination.",
    );
  }
  return true;
}

async function listDeploymentsByRef(client, path, query, ref) {
  const requestedPage = query.page ?? DEFAULT_LIST_PAGE;
  const requestedPerPage = query.per_page ?? DEFAULT_LIST_PER_PAGE;
  const requestedStart = (requestedPage - 1) * requestedPerPage;
  const serverFilters = { ...query };
  delete serverFilters.page;
  delete serverFilters.per_page;
  const state = createDeploymentRefScanState();

  for (let checked = 0; checked < DEPLOYMENT_REF_SCAN_MAX_PAGES; checked += 1) {
    const response = await client.request(path, {
      query: {
        ...serverFilters,
        page: state.upstreamPage,
        per_page: DEPLOYMENT_REF_SCAN_PER_PAGE,
      },
    });
    const rows = requireDeploymentRows(response);
    const reported = updateDeploymentRefScanMetadata(
      state,
      response,
      rows.length,
    );
    collectDeploymentRefMatches(
      state,
      rows,
      ref,
      requestedStart,
      requestedPerPage,
    );

    const navigationPagination = deploymentNavigationPagination(
      response,
      state,
      reported,
    );
    let nextPage = nextDeploymentScanPage(
      { ...response, pagination: navigationPagination },
      state.upstreamPage,
      rows.length,
    );
    nextPage = reconcileDeploymentTotalExhaustion(
      state,
      response,
      navigationPagination,
      state.upstreamPage,
      nextPage,
    );
    if (deploymentRefScanIsComplete(state, nextPage, rows.length)) {
      return {
        data: state.pageMatches,
        pagination: filteredPagination(
          requestedPage,
          requestedPerPage,
          state.totalMatches,
        ),
      };
    }
    state.upstreamPage = nextPage;
  }

  throw deploymentRefScanLimitError();
}

function isNotFound(error) {
  return error instanceof GitLabApiError && error.status === 404;
}

async function confirmAbsentAfterMutationNotFound(client, path, mutationError) {
  try {
    await client.request(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw mutationError;
}

function boundedLifecycleResult({
  environmentId,
  environmentName,
  state,
  outcome,
  changed,
}) {
  return {
    environment_id: environmentId,
    environment_name: environmentName,
    state,
    outcome,
    changed,
  };
}

async function preflightEnvironment(client, args) {
  const path = environmentPath(args.project, args.environment_id);
  let environment;
  try {
    environment = (await client.request(path)).data;
  } catch (error) {
    if (isNotFound(error)) {
      return { path, environment: null };
    }
    throw error;
  }

  if (!environment || environment.id !== args.environment_id) {
    throw new Error(
      "Environment lifecycle preflight returned an unexpected environment ID.",
    );
  }
  if (environment.name !== args.expected_environment_name) {
    throw new Error(
      `Environment lifecycle preflight rejected ID ${args.environment_id}: expected name ${JSON.stringify(args.expected_environment_name)} but GitLab returned ${JSON.stringify(environment.name)}.`,
    );
  }
  return { path, environment };
}

/**
 * Register environment and deployment tools.
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

  tool(
    "stop_environment",
    {
      title: "Stop GitLab environment",
      description:
        "Stop one explicitly identified environment after reading its current ID, name, and state. Already-stopped, stopping, or absent targets return an idempotent no-change result. Set force=true only to stop without executing configured on_stop actions. Requires explicit acknowledgement.",
      inputSchema: {
        project,
        environment_id: z
          .number()
          .int()
          .positive()
          .describe("Numeric ID of the environment to stop."),
        expected_environment_name: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "Exact environment name expected at environment_id. The mutation is rejected if GitLab returns a different name.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "When true, stop without executing on_stop actions. Omit or set false for normal GitLab stop behavior.",
          ),
        acknowledge_environment_stop: z.literal(true),
      },
      annotations: IDEMPOTENT_DESTRUCTIVE,
    },
    async (client, args) => {
      const { path, environment } = await preflightEnvironment(client, args);
      if (!environment) {
        return boundedLifecycleResult({
          environmentId: args.environment_id,
          environmentName: args.expected_environment_name,
          state: "absent",
          outcome: "already_absent",
          changed: false,
        });
      }
      if (environment.state === "stopped") {
        return boundedLifecycleResult({
          environmentId: environment.id,
          environmentName: environment.name,
          state: environment.state,
          outcome: "already_stopped",
          changed: false,
        });
      }
      if (environment.state === "stopping") {
        return boundedLifecycleResult({
          environmentId: environment.id,
          environmentName: environment.name,
          state: environment.state,
          outcome: "stop_in_progress",
          changed: false,
        });
      }
      if (environment.state !== "available") {
        throw new Error(
          `Environment lifecycle preflight rejected unsupported state ${JSON.stringify(environment.state)}.`,
        );
      }

      let response;
      try {
        response = await client.request(`${path}/stop`, {
          method: "POST",
          ...(args.force === undefined ? {} : { body: { force: args.force } }),
        });
      } catch (error) {
        if (isNotFound(error)) {
          await confirmAbsentAfterMutationNotFound(client, path, error);
          return boundedLifecycleResult({
            environmentId: environment.id,
            environmentName: environment.name,
            state: "absent",
            outcome: "already_absent_after_preflight",
            changed: false,
          });
        }
        throw error;
      }
      const stopped = response.data;
      if (
        stopped?.id !== args.environment_id ||
        stopped?.name !== args.expected_environment_name
      ) {
        throw new Error(
          "Environment stop returned an unexpected environment identity.",
        );
      }
      if (stopped.state !== "stopped" && stopped.state !== "stopping") {
        throw new Error(
          `Environment stop returned unexpected state ${JSON.stringify(stopped.state)}.`,
        );
      }
      return boundedLifecycleResult({
        environmentId: stopped.id,
        environmentName: stopped.name,
        state: stopped.state,
        outcome: stopped.state === "stopped" ? "stopped" : "stop_in_progress",
        changed: true,
      });
    },
  );

  tool(
    "delete_environment",
    {
      title: "Delete GitLab environment",
      description:
        "Delete one explicitly identified stopped environment after reading its current ID, name, and state. GitLab requires environments to be stopped before deletion; this tool never hides that prerequisite by stopping automatically. Already-absent targets and a concurrent 404 after preflight return an idempotent no-change result. Requires explicit destructive acknowledgement.",
      inputSchema: {
        project,
        environment_id: z
          .number()
          .int()
          .positive()
          .describe("Numeric ID of the stopped environment to delete."),
        expected_environment_name: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "Exact environment name expected at environment_id. The deletion is rejected if GitLab returns a different name.",
          ),
        acknowledge_environment_deletion: z.literal(true),
      },
      annotations: IDEMPOTENT_DESTRUCTIVE,
    },
    async (client, args) => {
      const { path, environment } = await preflightEnvironment(client, args);
      if (!environment) {
        return boundedLifecycleResult({
          environmentId: args.environment_id,
          environmentName: args.expected_environment_name,
          state: "absent",
          outcome: "already_absent",
          changed: false,
        });
      }
      if (environment.state !== "stopped") {
        throw new Error(
          `Environment deletion requires state "stopped"; GitLab returned ${JSON.stringify(environment.state)}. Stop the exact environment first.`,
        );
      }

      try {
        await client.request(path, { method: "DELETE" });
      } catch (error) {
        if (isNotFound(error)) {
          await confirmAbsentAfterMutationNotFound(client, path, error);
          return boundedLifecycleResult({
            environmentId: environment.id,
            environmentName: environment.name,
            state: "absent",
            outcome: "already_absent_after_preflight",
            changed: false,
          });
        }
        throw error;
      }
      return boundedLifecycleResult({
        environmentId: environment.id,
        environmentName: environment.name,
        state: "absent",
        outcome: "deleted",
        changed: true,
      });
    },
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
      const { project: projectValue, ref, ...query } = args;
      const path = `${p(projectValue)}/deployments`;
      if (ref === undefined) {
        return client.request(path, { query });
      }
      return listDeploymentsByRef(client, path, query, ref);
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
