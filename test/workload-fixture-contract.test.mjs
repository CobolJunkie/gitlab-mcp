import assert from "node:assert/strict";
import test from "node:test";

import { WORKLOAD_MANIFEST } from "../benchmarks/workload-scenarios.mjs";

const FIXTURE_MUTATION_SCENARIOS = [
  "repository.compare-refs",
  "issues.inspect-thread",
  "mr.review-metadata-diff",
  "mr.review-discussions",
  "mr.merge-readiness",
  "ci.diagnose-failure",
  "ci.bounded-log",
  "governance.approvals",
  "governance.schedules",
  "governance.variables",
  "release.inspect",
  "deployment.inspect",
];

test("read workflows that prepare mutable fixtures declare disposable setup and cleanup", () => {
  const byId = new Map(
    WORKLOAD_MANIFEST.scenarios.map((scenario) => [scenario.id, scenario]),
  );

  for (const id of FIXTURE_MUTATION_SCENARIOS) {
    const scenario = byId.get(id);
    assert.ok(scenario, `Missing canonical scenario ${id}.`);
    assert.equal(scenario.mutation, "none");
    assert.equal(scenario.requiresDisposable, true);
    assert.deepEqual(scenario.permittedEffects, [
      "benchmark_owned_fixture_setup",
    ]);
    assert.ok(scenario.fixtureSetup.includes("create_benchmark_owned_fixture"));
    assert.deepEqual(scenario.cleanup, [
      "restore_benchmark_owned_fixture_idempotently",
    ]);
  }
});

test("read workflows without mutable fixtures remain side-effect free", () => {
  const scenario = WORKLOAD_MANIFEST.scenarios.find(
    ({ id }) => id === "context.identity",
  );
  assert.deepEqual(scenario.permittedEffects, ["none"]);
  assert.deepEqual(scenario.cleanup, []);
  assert.equal(scenario.requiresDisposable, false);
});
