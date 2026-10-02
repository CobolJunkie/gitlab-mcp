import assert from "node:assert/strict";
import test from "node:test";

import { WORKLOAD_MANIFEST } from "../benchmarks/workload-scenarios.mjs";
import {
  STANDARD_WORKLOAD_METRICS,
  aggregateScenarioResults,
  assertExecutionSafety,
  assertSecretSafeReport,
  buildWorkloadReport,
  deriveScenarioMetrics,
  measurementsFromObservabilityEvents,
  renderWorkloadMarkdown,
  selectedScenariosForMode,
  validateWorkloadManifest,
} from "../scripts/lib/workload-benchmark.mjs";

async function manifest() {
  return structuredClone(WORKLOAD_MANIFEST);
}

function measurements(overrides = {}) {
  return {
    wallDurationMs: 25,
    toolCalls: 2,
    gitlabLogicalRequests: 4,
    gitlabPhysicalAttempts: 5,
    gitlabResponseBytes: 1000,
    mcpResultBytes: 500,
    presentationTruncations: 1,
    retries: 1,
    cacheHits: 2,
    cacheMisses: 1,
    admissionRejections: 0,
    ...overrides,
  };
}

function result(scenarioId, overrides = {}) {
  return {
    scenarioId,
    success: true,
    finalStateVerified: true,
    forbiddenEffectsObserved: [],
    measurements: measurements(),
    ...overrides,
  };
}

test("BENCH-02 manifest defines broad deterministic workload coverage", async () => {
  const workload = await manifest();
  assert.equal(validateWorkloadManifest(workload), true);
  assert.ok(workload.scenarios.length >= 30);
  assert.deepEqual(workload.standardMetrics, STANDARD_WORKLOAD_METRICS);

  const ids = workload.scenarios.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(
    workload.scenarios.every(
      (scenario) =>
        scenario.fixtureState.length > 0 &&
        scenario.fixtureSetup.length > 0 &&
        scenario.permittedEffects.length > 0 &&
        scenario.forbiddenEffects.length > 0 &&
        scenario.expectedFinalState.length > 0,
    ),
  );

  const mutations = workload.scenarios.filter(
    ({ mutation }) => mutation !== "none",
  );
  assert.ok(mutations.length >= 8);
  assert.ok(
    mutations.every(
      (scenario) =>
        scenario.requiresDisposable &&
        scenario.cleanup.length > 0 &&
        workload.executionProfiles[scenario.execution].warmupRepetitions === 0,
    ),
  );
});

test("manifest validation fails closed on unsafe mutation metadata", async () => {
  const workload = await manifest();
  const unsafe = structuredClone(workload);
  const mutation = unsafe.scenarios.find(
    (scenario) => scenario.mutation !== "none",
  );
  mutation.requiresDisposable = false;
  assert.throws(
    () => validateWorkloadManifest(unsafe),
    /must require a disposable target/,
  );

  const noCleanup = structuredClone(workload);
  const noCleanupMutation = noCleanup.scenarios.find(
    (scenario) => scenario.mutation !== "none",
  );
  noCleanupMutation.cleanup = [];
  assert.throws(
    () => validateWorkloadManifest(noCleanup),
    /must declare bounded cleanup/,
  );
});

test("correctness mode excludes destructive scenarios explicitly deferred from CI", async () => {
  const workload = await manifest();
  const correctness = selectedScenariosForMode(workload, "correctness");
  const benchmark = selectedScenariosForMode(workload, "benchmark");

  assert.ok(correctness.length < benchmark.length);
  assert.equal(benchmark.length, workload.scenarios.length);
  assert.ok(
    correctness.every((scenario) => scenario.execution.correctness === true),
  );
  assert.throws(
    () => selectedScenariosForMode(workload, "unknown"),
    /Unknown workload execution mode/,
  );
});

test("mutation execution requires a positively verified disposable target", async () => {
  const workload = await manifest();
  const reads = workload.scenarios.filter(
    (scenario) =>
      scenario.mutation === "none" && scenario.requiresDisposable === false,
  );
  const writes = workload.scenarios.filter(
    (scenario) => scenario.mutation !== "none",
  );

  assert.equal(
    assertExecutionSafety(reads, {
      mode: "correctness",
      disposableTargetVerified: false,
    }),
    true,
  );
  assert.throws(
    () =>
      assertExecutionSafety(writes, {
        mode: "benchmark",
        disposableTargetVerified: false,
      }),
    /positively verified disposable target/,
  );
  const isolatedDisposableRead = workload.scenarios.filter(
    (scenario) => scenario.id === "safety.read-only-mutation",
  );
  assert.throws(
    () =>
      assertExecutionSafety(isolatedDisposableRead, {
        mode: "correctness",
        disposableTargetVerified: false,
      }),
    /positively verified disposable target/,
  );
  assert.equal(
    assertExecutionSafety(writes, {
      mode: "benchmark",
      disposableTargetVerified: true,
    }),
    true,
  );
  assert.throws(
    () => assertExecutionSafety([], { mode: "correctness" }),
    /At least one workload scenario/,
  );
});

test("MET-01 observability events map to BENCH-02 measurements", () => {
  const observed = measurementsFromObservabilityEvents(
    [
      { metric: "gitlab_mcp.tool.calls" },
      { metric: "gitlab_mcp.tool.calls", value: 2 },
      { metric: "gitlab_mcp.gitlab.request.duration", value: 0.01 },
      { metric: "gitlab_mcp.gitlab.request.duration", value: 0.02 },
      { metric: "gitlab_mcp.gitlab.response.size", value: 700 },
      { metric: "gitlab_mcp.gitlab.response.size", value: 300 },
      { metric: "gitlab_mcp.tool.result.size", value: 400 },
      { metric: "gitlab_mcp.tool.presentation.truncations" },
      { metric: "gitlab_mcp.gitlab.retries" },
      {
        metric: "gitlab_mcp.cache.requests",
        value: 2,
        attributes: { result: "hit" },
      },
      {
        metric: "gitlab_mcp.cache.requests",
        attributes: { result: "miss" },
      },
      { metric: "gitlab_mcp.http.admission.rejections" },
      { metric: "gitlab_mcp.tool.active", value: -1 },
      { metric: "future.metric", value: 99 },
      null,
    ],
    { wallDurationMs: 12.5 },
  );

  assert.deepEqual(observed, {
    wallDurationMs: 12.5,
    toolCalls: 3,
    gitlabLogicalRequests: 2,
    gitlabPhysicalAttempts: 3,
    gitlabResponseBytes: 1000,
    mcpResultBytes: 400,
    presentationTruncations: 1,
    retries: 1,
    cacheHits: 2,
    cacheMisses: 1,
    admissionRejections: 1,
  });
});

test("derived amplification metrics use documented denominators", () => {
  const derived = deriveScenarioMetrics(measurements());
  assert.equal(derived.gitlabApiAmplification, 2);
  assert.equal(derived.workflowApiAmplification, 4);
  assert.equal(derived.contextAmplification, 0.5);

  const zero = deriveScenarioMetrics(
    measurements({
      toolCalls: 0,
      gitlabLogicalRequests: 0,
      gitlabPhysicalAttempts: 0,
      gitlabResponseBytes: 0,
      mcpResultBytes: 0,
    }),
    { completed: false },
  );
  assert.equal(zero.gitlabApiAmplification, null);
  assert.equal(zero.workflowApiAmplification, null);
  assert.equal(zero.contextAmplification, null);
  assert.throws(
    () => deriveScenarioMetrics(measurements({ retries: -1 })),
    /finite non-negative number/,
  );
});

test("aggregation is deterministic and reports safety separately", () => {
  const aggregate = aggregateScenarioResults([
    result("zeta", {
      success: false,
      finalStateVerified: false,
      forbiddenEffectsObserved: ["modified unrelated issue"],
    }),
    result("alpha"),
  ]);

  assert.deepEqual(
    aggregate.results.map(({ scenarioId }) => scenarioId),
    ["alpha", "zeta"],
  );
  assert.equal(aggregate.scenarioCount, 2);
  assert.equal(aggregate.successfulScenarios, 1);
  assert.equal(aggregate.failedScenarios, 1);
  assert.equal(aggregate.finalStateFailures, 1);
  assert.equal(aggregate.safetyViolationCount, 1);
  assert.deepEqual(aggregate.safetyViolations, [
    { scenarioId: "zeta", effect: "modified unrelated issue" },
  ]);
  assert.equal(aggregate.totals.toolCalls, 4);
  assert.equal(aggregate.totals.gitlabLogicalRequests, 8);
  assert.equal(aggregate.totals.gitlabApiAmplification, 2);

  const completed = aggregateScenarioResults([result("one"), result("two")]);
  assert.equal(completed.totals.gitlabLogicalRequests, 8);
  assert.equal(completed.totals.workflowApiAmplification, 4);

  assert.throws(
    () => aggregateScenarioResults([result("same"), result("same")]),
    /Duplicate scenario result id/,
  );
});

test("report metadata is deterministic and excludes secret-bearing fields", async () => {
  const workload = await manifest();
  const report = buildWorkloadReport({
    commitSha: "a".repeat(40),
    serverVersion: "0.1.1",
    workload: workload.workload,
    workloadVersion: workload.workloadVersion,
    fixtureConfigurationId: "disposable-v1",
    mode: "correctness",
    repetitions: 1,
    generatedAt: "2026-09-13T16:00:00.000Z",
    metricProvenance: workload.metricProvenance,
    results: [result("context.identity")],
  });
  const second = buildWorkloadReport({
    commitSha: "a".repeat(40),
    serverVersion: "0.1.1",
    workload: workload.workload,
    workloadVersion: workload.workloadVersion,
    fixtureConfigurationId: "disposable-v1",
    mode: "correctness",
    repetitions: 1,
    generatedAt: "2026-09-13T16:00:00.000Z",
    metricProvenance: workload.metricProvenance,
    results: [result("context.identity")],
  });

  assert.deepEqual(report, second);
  assert.equal(report.classification, "benchmark");
  assert.equal(assertSecretSafeReport(report), true);
  assert.match(renderWorkloadMarkdown(report), /Safety violations: 0/);

  assert.throws(
    () =>
      assertSecretSafeReport({
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
      }),
    /Secret-bearing field/,
  );
  assert.throws(
    () =>
      assertSecretSafeReport({
        diagnostic: "glpat-abcdefghijklmnopqrstuv",
      }),
    /Potential secret material/,
  );
  assert.throws(
    () =>
      buildWorkloadReport({
        commitSha: "short",
        serverVersion: "0.1.1",
        workload: workload.workload,
        workloadVersion: workload.workloadVersion,
        fixtureConfigurationId: "disposable-v1",
        mode: "correctness",
        repetitions: 1,
        generatedAt: "2026-09-13T16:00:00.000Z",
        metricProvenance: workload.metricProvenance,
        results: [result("context.identity")],
      }),
    /full 40-character hexadecimal Git SHA/,
  );
});
