import assert from "node:assert/strict";
import test from "node:test";

import {
  addWorkloadStatistics,
  renderStatisticalWorkloadMarkdown,
  summarizeScenarioSamples,
  summarizeValues,
} from "../scripts/lib/workload-statistics.mjs";

function measurements(wallDurationMs, toolCalls = 1) {
  return {
    wallDurationMs,
    toolCalls,
    gitlabLogicalRequests: toolCalls * 2,
    gitlabPhysicalAttempts: toolCalls * 2,
    gitlabResponseBytes: toolCalls * 100,
    mcpResultBytes: toolCalls * 50,
    presentationTruncations: 0,
    retries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    admissionRejections: 0,
  };
}

test("summarizeValues produces deterministic nearest-rank percentiles", () => {
  assert.deepEqual(summarizeValues([50, 10, 40, 20, 30]), {
    min: 10,
    mean: 30,
    median: 30,
    p95: 50,
    max: 50,
  });
  assert.equal(summarizeValues([]), null);
  assert.throws(() => summarizeValues([1, -1]), /finite non-negative/);
});

test("scenario statistics retain exact measured samples and repetition counts", () => {
  const expectedSamples = [
    measurements(10),
    measurements(20, 2),
    measurements(30, 3),
  ];
  const summary = summarizeScenarioSamples({
    scenarioId: "context.identity",
    warmupsCompleted: 3,
    samples: expectedSamples.map((entry) => ({ measurements: entry })),
  });

  assert.equal(summary.measuredRepetitions, 3);
  assert.equal(summary.warmupsCompleted, 3);
  assert.deepEqual(summary.samples, expectedSamples);
  assert.deepEqual(summary.metrics.wallDurationMs, {
    min: 10,
    mean: 20,
    median: 20,
    p95: 30,
    max: 30,
  });
  assert.equal(summary.metrics.gitlabLogicalRequests.mean, 4);
});

test("statistical report enrichment is deterministic and markdown-visible", () => {
  const base = {
    schemaVersion: 1,
    classification: "benchmark",
    workload: "gitlab-mcp-synthetic-v1",
    workloadVersion: 1,
    commitSha: "a".repeat(40),
    serverVersion: "0.1.1",
    fixtureConfigurationId: "gitlab-project-15-v1",
    mode: "benchmark",
    repetitions: 30,
    generatedAt: "2026-09-13T16:00:00.000Z",
    metricProvenance: {
      contract: "gitlab-mcp.metric-contract.v1",
      source: "in_process_observer",
      collection: "scenario_scoped",
    },
    surfaceProvenance: {
      mode: "all",
      toolCount: 147,
      definitionFingerprint: `sha256:${"a".repeat(64)}`,
    },
    aggregate: {
      scenarioCount: 1,
      successfulScenarios: 1,
      failedScenarios: 0,
      finalStateFailures: 0,
      safetyViolationCount: 0,
      safetyViolations: [],
      totals: {
        ...measurements(60, 3),
        gitlabApiAmplification: 2,
        workflowApiAmplification: 6,
        contextAmplification: 0.5,
      },
      results: [
        {
          scenarioId: "context.identity",
          success: true,
          finalStateVerified: true,
          forbiddenEffectsObserved: [],
          measurements: {
            ...measurements(60, 3),
            gitlabApiAmplification: 2,
            workflowApiAmplification: 6,
            contextAmplification: 0.5,
          },
        },
      ],
    },
  };
  const raw = [
    {
      scenarioId: "context.identity",
      warmupsCompleted: 1,
      samples: [
        { measurements: measurements(10) },
        { measurements: measurements(20) },
      ],
    },
  ];

  const report = addWorkloadStatistics(base, raw);
  assert.equal(report.repetitionPolicy, "per-scenario-profile");
  assert.equal(report.scenarioStatistics[0].measuredRepetitions, 2);
  assert.deepEqual(report.scenarioStatistics[0].samples, [
    measurements(10),
    measurements(20),
  ]);
  const markdown = renderStatisticalWorkloadMarkdown(report);
  assert.match(markdown, /Surface provenance/);
  assert.match(markdown, /Tool count: 147/);
  assert.match(
    markdown,
    new RegExp(report.surfaceProvenance.definitionFingerprint),
  );
  assert.match(markdown, /Repeated-run statistics/);
  assert.match(markdown, /context\.identity/);
});
