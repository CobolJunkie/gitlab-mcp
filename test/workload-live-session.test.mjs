import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRequestedBenchmarkProject,
  benchmarkRunId,
  cleanupBenchmarkEnvironment,
  liveBenchmarkConfiguration,
} from "../scripts/lib/workload-live-session.mjs";

test("live benchmark configuration fails closed without disposable approval", () => {
  assert.throws(
    () =>
      liveBenchmarkConfiguration({
        GITLAB_INTEGRATION_PROJECT: "fixture/project",
        GITLAB_INTEGRATION_DISPOSABLE_TOKEN: "fixture-token",
        GITLAB_INTEGRATION_DISPOSABLE: "false",
        CI_SERVER_URL: "https://gitlab.example.com",
      }),
    /GITLAB_INTEGRATION_DISPOSABLE=true/,
  );
});

test("live benchmark configuration requires project and token without exposing them", () => {
  assert.throws(
    () =>
      liveBenchmarkConfiguration({
        GITLAB_INTEGRATION_DISPOSABLE: "true",
        CI_SERVER_URL: "https://gitlab.example.com",
      }),
    /GITLAB_INTEGRATION_PROJECT/,
  );
  assert.throws(
    () =>
      liveBenchmarkConfiguration({
        GITLAB_INTEGRATION_PROJECT: "fixture/project",
        GITLAB_INTEGRATION_DISPOSABLE: "true",
        CI_SERVER_URL: "https://gitlab.example.com",
      }),
    /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/,
  );
});

test("live benchmark configuration normalizes the GitLab base URL", () => {
  const config = liveBenchmarkConfiguration({
    GITLAB_INTEGRATION_PROJECT: "fixture/project",
    GITLAB_INTEGRATION_DISPOSABLE_TOKEN: "fixture-token",
    GITLAB_INTEGRATION_DISPOSABLE: "true",
    CI_SERVER_URL: "https://gitlab.example.com/",
  });
  assert.equal(config.baseUrl, "https://gitlab.example.com");
  assert.equal(config.requestedProject, "fixture/project");
});

test("resolved benchmark project must match the requested path or numeric ID", () => {
  assert.equal(
    assertRequestedBenchmarkProject("group/disposable", {
      projectId: "42",
      projectPath: "group/disposable",
    }),
    true,
  );
  assert.equal(
    assertRequestedBenchmarkProject("42", {
      projectId: "42",
      projectPath: "group/disposable",
    }),
    true,
  );

  assert.throws(
    () =>
      assertRequestedBenchmarkProject("group/expected", {
        projectId: "42",
        projectPath: "group/other",
      }),
    /does not match GITLAB_INTEGRATION_PROJECT/,
  );
  assert.throws(
    () =>
      assertRequestedBenchmarkProject("41", {
        projectId: "42",
        projectPath: "group/disposable",
      }),
    /does not match GITLAB_INTEGRATION_PROJECT/,
  );
});

test("benchmark run IDs are bounded safe identifiers", () => {
  const runId = benchmarkRunId("BENCH fixture with spaces");
  assert.match(runId, /^[a-z0-9_-]+$/);
  assert.ok(runId.length < 80);
});

function cleanupCall(resolver) {
  const calls = [];
  return {
    calls,
    call: async (name, args) => {
      calls.push({ name, args });
      return resolver(name, args, calls);
    },
  };
}

function stoppedResult() {
  return {
    environment_id: 7,
    environment_name: "benchmark / fixture",
    state: "stopped",
    outcome: "stopped",
    changed: true,
  };
}

function deletedResult() {
  return {
    environment_id: 7,
    environment_name: "benchmark / fixture",
    state: "absent",
    outcome: "deleted",
    changed: true,
  };
}

test("environment teardown stops then deletes through the MCP tool surface", async () => {
  const { calls, call } = cleanupCall((name) =>
    name === "stop_environment" ? stoppedResult() : deletedResult(),
  );

  await cleanupBenchmarkEnvironment(call, {
    projectId: 42,
    environmentId: 7,
    environmentName: "benchmark / fixture",
  });

  assert.deepEqual(calls, [
    {
      name: "stop_environment",
      args: {
        project: 42,
        environment_id: 7,
        expected_environment_name: "benchmark / fixture",
        force: true,
        acknowledge_environment_stop: true,
      },
    },
    {
      name: "delete_environment",
      args: {
        project: 42,
        environment_id: 7,
        expected_environment_name: "benchmark / fixture",
        acknowledge_environment_deletion: true,
      },
    },
  ]);
});

test("environment teardown accepts the validator's canonical string project ID", async () => {
  const { calls, call } = cleanupCall((name) =>
    name === "stop_environment" ? stoppedResult() : deletedResult(),
  );

  await cleanupBenchmarkEnvironment(call, {
    projectId: "42",
    environmentId: 7,
    environmentName: "benchmark / fixture",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.project, 42);
  assert.equal(calls[1].args.project, 42);
});

test("environment teardown refuses a mismatched MCP result identity", async () => {
  const { calls, call } = cleanupCall(() => ({
    ...stoppedResult(),
    environment_name: "production",
  }));

  await assert.rejects(
    cleanupBenchmarkEnvironment(call, {
      projectId: 42,
      environmentId: 7,
      environmentName: "benchmark / fixture",
    }),
    /different environment name/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "stop_environment");
});

test("environment teardown is idempotent when the fixture is already gone", async () => {
  const { calls, call } = cleanupCall(() => ({
    environment_id: 7,
    environment_name: "benchmark / fixture",
    state: "absent",
    outcome: "already_absent",
    changed: false,
  }));

  await cleanupBenchmarkEnvironment(call, {
    projectId: 42,
    environmentId: 7,
    environmentName: "benchmark / fixture",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "stop_environment");
});

test("already stopped environments are deleted through MCP without polling", async () => {
  const { calls, call } = cleanupCall((name) => {
    if (name === "stop_environment") {
      return {
        ...stoppedResult(),
        outcome: "already_stopped",
        changed: false,
      };
    }
    return deletedResult();
  });

  await cleanupBenchmarkEnvironment(call, {
    projectId: 42,
    environmentId: 7,
    environmentName: "benchmark / fixture",
  });

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["stop_environment", "delete_environment"],
  );
});
