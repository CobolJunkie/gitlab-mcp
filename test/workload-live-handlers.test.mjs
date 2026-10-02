import assert from "node:assert/strict";
import test from "node:test";

import { WORKLOAD_MANIFEST } from "../benchmarks/workload-scenarios.mjs";
import { createLiveWorkloadHandlers } from "../scripts/lib/workload-live-handlers.mjs";

function inertSession() {
  return {
    runId: "benchmark-test",
    project: 15,
    projectPath: "fixture/project",
    projectInfo: { readme_url: "https://example.invalid/README.md" },
    defaultBranch: "main",
    call: async () => {
      throw new Error("handler coverage test must not execute tools");
    },
    expectError: async () => {
      throw new Error("handler coverage test must not execute tools");
    },
    measured: async () => {
      throw new Error("handler coverage test must not execute tools");
    },
  };
}

test("every canonical BENCH-02 scenario has one live handler", () => {
  const handlers = createLiveWorkloadHandlers(inertSession());
  const expected = WORKLOAD_MANIFEST.scenarios.map(({ id }) => id).sort();
  const actual = Object.keys(handlers).sort();
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
});
