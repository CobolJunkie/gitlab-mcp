import assert from "node:assert/strict";
import test from "node:test";

import { cleanupBenchmarkEnvironment } from "../scripts/lib/workload-live-session.mjs";

const TARGET = {
  projectId: 42,
  environmentId: 7,
  environmentName: "benchmark / fixture",
};

function stoppingResult() {
  return {
    environment_id: 7,
    environment_name: "benchmark / fixture",
    state: "stopping",
    outcome: "stop_in_progress",
    changed: false,
  };
}

test("environment cleanup waits for stopping environment before deleting", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "stop_environment") return stoppingResult();
    if (name === "get_environment") {
      return { id: 7, name: "benchmark / fixture", state: "stopped" };
    }
    if (name === "delete_environment") {
      return {
        environment_id: 7,
        environment_name: "benchmark / fixture",
        state: "absent",
        outcome: "deleted",
        changed: true,
      };
    }
    assert.fail(`Unexpected cleanup tool ${name}.`);
  };

  await cleanupBenchmarkEnvironment(call, TARGET);

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["stop_environment", "get_environment", "delete_environment"],
  );
  assert.deepEqual(calls[1].args, {
    project: 42,
    environment_id: 7,
  });
});

test("environment cleanup tolerates disappearance while waiting for stop", async () => {
  const calls = [];
  const missing = new Error("get_environment failed: not found");
  missing.name = "LiveBenchmarkToolError";
  missing.result = { status: 404 };
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "stop_environment") return stoppingResult();
    if (name === "get_environment") throw missing;
    assert.fail(
      "delete_environment must not run after the environment disappears.",
    );
  };

  await cleanupBenchmarkEnvironment(call, TARGET);

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["stop_environment", "get_environment"],
  );
});

test("environment cleanup fails closed on an unexpected post-stop state", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "stop_environment") {
      return {
        environment_id: 7,
        environment_name: "benchmark / fixture",
        state: "available",
        outcome: "stopped",
        changed: true,
      };
    }
    assert.fail(`Unexpected cleanup tool ${name}.`);
  };

  await assert.rejects(
    cleanupBenchmarkEnvironment(call, TARGET),
    /unexpected state "available" after stop/,
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["stop_environment"],
  );
});
