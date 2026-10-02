import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  GitLabClient,
  normalizeGitLabUrl,
} from "../../server/src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../../server/src/server.mjs";
import { validateResolvedDisposableIntegrationProject } from "./disposable-integration-report-gate.mjs";
import { resetStaleBenchmarkFixtures } from "./workload-live-reset.mjs";

const ENVIRONMENT_STOP_POLL_ATTEMPTS = 20;
const ENVIRONMENT_STOP_POLL_MS = 250;

function trimBoundaryHyphens(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

function safeSegment(value, fallback = "run") {
  const safe = trimBoundaryHyphens(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-"),
  ).slice(0, 48);
  return safe || fallback;
}

export function benchmarkRunId(prefix = "bench") {
  return `${safeSegment(prefix)}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export function assertRequestedBenchmarkProject(requestedProject, resolved) {
  const requested = requiredString(
    requestedProject,
    "requested benchmark project",
  );
  const numeric = Number(requested);
  const requestedId =
    Number.isSafeInteger(numeric) &&
    numeric > 0 &&
    String(numeric) === requested
      ? requested
      : null;
  const matches = requestedId
    ? resolved?.projectId === requestedId
    : resolved?.projectPath === requested;
  if (!matches) {
    throw new Error(
      "Resolved disposable benchmark project does not match GITLAB_INTEGRATION_PROJECT.",
    );
  }
  return true;
}

export function liveBenchmarkConfiguration(environment = process.env) {
  if (environment.GITLAB_INTEGRATION_DISPOSABLE !== "true") {
    throw new Error(
      "Live workload benchmarking requires GITLAB_INTEGRATION_DISPOSABLE=true.",
    );
  }
  const requestedProject = requiredString(
    environment.GITLAB_INTEGRATION_PROJECT,
    "GITLAB_INTEGRATION_PROJECT",
  );
  const token = requiredString(
    environment.GITLAB_INTEGRATION_DISPOSABLE_TOKEN,
    "GITLAB_INTEGRATION_DISPOSABLE_TOKEN",
  );
  const baseUrl = normalizeGitLabUrl(
    environment.GITLAB_URL || environment.CI_SERVER_URL,
  );
  return Object.freeze({ baseUrl, requestedProject, token });
}

function toolError(name, response) {
  const result = response?.structuredContent?.result;
  const message =
    result?.message || response?.content?.[0]?.text || "unknown MCP error";
  const error = new Error(`${name} failed: ${message}`);
  error.name = "LiveBenchmarkToolError";
  error.tool = name;
  error.result = result;
  return error;
}

function assertBenchmarkEnvironmentIdentity(
  environment,
  { environmentId, environmentName },
) {
  assert.equal(
    environment?.id ?? environment?.environment_id,
    environmentId,
    "Benchmark environment cleanup resolved a different environment ID.",
  );
  assert.equal(
    environment?.name ?? environment?.environment_name,
    environmentName,
    "Benchmark environment cleanup resolved a different environment name.",
  );
}

function isToolNotFound(error) {
  return (
    error?.name === "LiveBenchmarkToolError" && error?.result?.status === 404
  );
}

async function waitForBenchmarkEnvironmentStopped(call, target, initialState) {
  let state = initialState;
  for (
    let attempt = 0;
    attempt < ENVIRONMENT_STOP_POLL_ATTEMPTS;
    attempt += 1
  ) {
    if (state === "stopped") return "stopped";
    if (state === "absent") return "absent";
    if (state !== "stopping") {
      throw new Error(
        `Benchmark environment cleanup observed unexpected state ${JSON.stringify(state)} after stop.`,
      );
    }
    if (attempt + 1 >= ENVIRONMENT_STOP_POLL_ATTEMPTS) break;
    await new Promise((resolve) =>
      setTimeout(resolve, ENVIRONMENT_STOP_POLL_MS),
    );
    try {
      const current = await call("get_environment", {
        project: target.project,
        environment_id: target.environment_id,
      });
      assertBenchmarkEnvironmentIdentity(current, {
        environmentId: target.environment_id,
        environmentName: target.expected_environment_name,
      });
      state = current.state;
    } catch (error) {
      if (isToolNotFound(error)) return "absent";
      throw error;
    }
  }
  throw new Error(
    `Benchmark environment ${target.environment_id} did not reach the stopped state after bounded polling.`,
  );
}

export async function cleanupBenchmarkEnvironment(
  call,
  { projectId, environmentId, environmentName },
) {
  const numericProjectId = Number(projectId);
  if (
    !Number.isSafeInteger(numericProjectId) ||
    numericProjectId <= 0 ||
    String(numericProjectId) !== String(projectId)
  ) {
    throw new Error(
      "Benchmark environment cleanup requires a positive project ID.",
    );
  }
  if (!Number.isSafeInteger(environmentId) || environmentId <= 0) {
    throw new Error(
      "Benchmark environment cleanup requires a positive environment ID.",
    );
  }
  const expectedName = requiredString(
    environmentName,
    "benchmark environment name",
  );
  const target = {
    project: numericProjectId,
    environment_id: environmentId,
    expected_environment_name: expectedName,
  };

  const stopped = await call("stop_environment", {
    ...target,
    force: true,
    acknowledge_environment_stop: true,
  });
  assertBenchmarkEnvironmentIdentity(stopped, {
    environmentId,
    environmentName: expectedName,
  });
  const state = await waitForBenchmarkEnvironmentStopped(
    call,
    target,
    stopped.state,
  );
  if (state === "absent") return;

  const deleted = await call("delete_environment", {
    ...target,
    acknowledge_environment_deletion: true,
  });
  assertBenchmarkEnvironmentIdentity(deleted, {
    environmentId,
    environmentName: expectedName,
  });
  assert.equal(
    deleted.state,
    "absent",
    "Benchmark environment cleanup did not report an absent final state.",
  );
}

export async function createLiveBenchmarkSession({
  environment = process.env,
  timeoutMs = 15_000,
} = {}) {
  const { baseUrl, requestedProject, token } =
    liveBenchmarkConfiguration(environment);
  let activeObserver;
  const observabilityObserver = (event) => {
    if (typeof activeObserver === "function") {
      activeObserver(event);
    }
  };

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    deploymentMode: "embedded",
    observabilityObserver,
    clientFactory: (_extra, { observabilityObserver: observer } = {}) =>
      new GitLabClient({
        baseUrl,
        token,
        timeoutMs,
        observabilityObserver: observer,
      }),
  });
  const client = new Client({
    name: "gitlab-mcp-workload-benchmark",
    version: "0.1.0",
  });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const rawCall = async (name, args = {}) =>
    client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const response = await rawCall(name, args);
    if (response.isError === true) {
      throw toolError(name, response);
    }
    return response.structuredContent?.result;
  };
  const expectError = async (name, args = {}, predicate = () => true) => {
    const response = await rawCall(name, args);
    assert.equal(response.isError, true, `${name} unexpectedly succeeded.`);
    const result = response.structuredContent?.result;
    assert.equal(
      predicate(result),
      true,
      `${name} returned an unexpected error shape.`,
    );
    return result;
  };

  let resolved;
  try {
    const projectInfo = await call("get_project", {
      project: requestedProject,
    });
    const validated = validateResolvedDisposableIntegrationProject(
      projectInfo,
      environment,
    );
    assertRequestedBenchmarkProject(requestedProject, validated);
    assert.ok(
      projectInfo.default_branch,
      "The disposable benchmark project must have a default branch.",
    );
    resolved = Object.freeze({
      ...validated,
      defaultBranch: projectInfo.default_branch,
      projectInfo,
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }

  const cleanupEnvironment = ({ environmentId, environmentName }) =>
    cleanupBenchmarkEnvironment(call, {
      projectId: resolved.projectId,
      environmentId,
      environmentName,
    });

  try {
    await resetStaleBenchmarkFixtures({
      project: resolved.projectId,
      defaultBranch: resolved.defaultBranch,
      call,
      cleanupBenchmarkEnvironment: cleanupEnvironment,
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }

  const measured = async (observe, operation) => {
    if (activeObserver) {
      throw new Error("Nested live benchmark measurement is not supported.");
    }
    activeObserver = observe;
    try {
      return await operation();
    } finally {
      activeObserver = undefined;
    }
  };

  return Object.freeze({
    baseUrl,
    requestedProject,
    project: resolved.projectId,
    projectPath: resolved.projectPath,
    defaultBranch: resolved.defaultBranch,
    projectInfo: resolved.projectInfo,
    fixtureConfigurationId: `gitlab-project-${resolved.projectId}-v1`,
    call,
    rawCall,
    expectError,
    measured,
    cleanupBenchmarkEnvironment: cleanupEnvironment,
    runId: benchmarkRunId(),
    close: async () => {
      activeObserver = undefined;
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  });
}
