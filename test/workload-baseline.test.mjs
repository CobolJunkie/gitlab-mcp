import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WORKLOAD_MANIFEST } from "../benchmarks/workload-scenarios.mjs";
import {
  STANDARD_WORKLOAD_METRICS,
  buildWorkloadReport,
} from "../scripts/lib/workload-benchmark.mjs";
import {
  promoteWorkloadBaseline,
  workloadExecutionProvenance,
} from "../scripts/lib/workload-baseline.mjs";

const SURFACE_BASELINE = JSON.parse(
  await readFile("benchmarks/surface-baseline.json", "utf8"),
);

function measurements() {
  return Object.fromEntries(
    STANDARD_WORKLOAD_METRICS.map((metric) => [metric, 0]),
  );
}

function zeroSummary() {
  return { min: 0, mean: 0, median: 0, p95: 0, max: 0 };
}

function promotableReport() {
  const results = WORKLOAD_MANIFEST.scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    success: true,
    finalStateVerified: true,
    forbiddenEffectsObserved: [],
    measurements: measurements(),
  }));
  const report = buildWorkloadReport({
    commitSha: "a".repeat(40),
    serverVersion: "0.1.1",
    workload: WORKLOAD_MANIFEST.workload,
    workloadVersion: WORKLOAD_MANIFEST.workloadVersion,
    fixtureConfigurationId: "disposable-fixture-1",
    mode: "benchmark",
    repetitions: 30,
    generatedAt: "2026-09-13T18:00:00.000Z",
    metricProvenance: WORKLOAD_MANIFEST.metricProvenance,
    results,
  });
  report.executionProvenance = {
    pipelineId: "1234",
    pipelineSource: "schedule",
    commitRef: "main",
    commitSha: "a".repeat(40),
    protectedRef: true,
  };
  report.surfaceProvenance = {
    mode: "all",
    toolCount: SURFACE_BASELINE.surfaces.all.toolCount,
    definitionFingerprint: SURFACE_BASELINE.surfaces.all.definitionFingerprint,
  };
  report.repetitionPolicy = "per-scenario-profile";
  report.scenarioStatistics = WORKLOAD_MANIFEST.scenarios.map((scenario) => {
    const profile = WORKLOAD_MANIFEST.executionProfiles[scenario.execution];
    return {
      scenarioId: scenario.id,
      measuredRepetitions: profile.benchmarkRepetitions,
      warmupsCompleted: profile.warmupRepetitions,
      samples: Array.from(
        { length: profile.benchmarkRepetitions },
        measurements,
      ),
      metrics: Object.fromEntries(
        STANDARD_WORKLOAD_METRICS.map((metric) => [metric, zeroSummary()]),
      ),
    };
  });
  return report;
}

test("execution provenance records protected CI context without credentials", () => {
  assert.deepEqual(
    workloadExecutionProvenance({
      CI_PIPELINE_ID: "88",
      CI_PIPELINE_SOURCE: "web",
      CI_COMMIT_REF_NAME: "main",
      CI_COMMIT_SHA: "b".repeat(40),
      CI_COMMIT_REF_PROTECTED: "true",
    }),
    {
      pipelineId: "88",
      pipelineSource: "web",
      commitRef: "main",
      commitSha: "b".repeat(40),
      protectedRef: true,
    },
  );
});

test("baseline promotion binds a full successful protected run to the all surface", () => {
  const baseline = promoteWorkloadBaseline({
    report: promotableReport(),
    manifest: WORKLOAD_MANIFEST,
    surfaceBaseline: SURFACE_BASELINE,
  });

  assert.equal(baseline.baseline, "gitlab-mcp-synthetic-all-surface-v1");
  assert.equal(baseline.surface.mode, "all");
  assert.equal(baseline.surface.toolCount, 147);
  assert.equal(
    baseline.surface.definitionFingerprint,
    SURFACE_BASELINE.surfaces.all.definitionFingerprint,
  );
  assert.equal(baseline.promotion.pipelineId, "1234");
  assert.equal(baseline.promotion.pipelineSource, "schedule");
  assert.equal(baseline.report.aggregate.scenarioCount, 35);
});

test("baseline promotion rejects malformed report identity", () => {
  const invalidSchema = promotableReport();
  invalidSchema.schemaVersion += 1;
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report: invalidSchema,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /schemaVersion/,
  );

  const invalidCommit = promotableReport();
  invalidCommit.commitSha = "abc1234";
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report: invalidCommit,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /full 40-character hexadecimal Git SHA/,
  );

  const invalidTimestamp = promotableReport();
  invalidTimestamp.generatedAt = "not-a-timestamp";
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report: invalidTimestamp,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /ISO-8601-compatible timestamp/,
  );

  const invalidFixture = promotableReport();
  invalidFixture.fixtureConfigurationId = "fixture with spaces";
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report: invalidFixture,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /bounded non-secret identifier/,
  );
});

test("baseline promotion rejects a report from a different all surface", () => {
  const report = promotableReport();
  report.surfaceProvenance.definitionFingerprint = `sha256:${"f".repeat(64)}`;

  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /surface provenance does not match/,
  );
});

test("baseline promotion rejects unprotected or non-CI runs", () => {
  const unprotected = promotableReport();
  unprotected.executionProvenance.protectedRef = false;
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report: unprotected,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /protected-ref/,
  );

  const missingPipeline = promotableReport();
  missingPipeline.executionProvenance.pipelineId = null;
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report: missingPipeline,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /pipelineId/,
  );
});

test("baseline promotion rejects mismatched CI commit provenance", () => {
  const report = promotableReport();
  report.executionProvenance.commitSha = "b".repeat(40);

  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /does not match protected CI execution provenance/,
  );
});

test("baseline promotion rejects partial or failed workloads", () => {
  const report = promotableReport();
  report.aggregate.results.pop();
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /full canonical workload exactly/,
  );

  const failed = promotableReport();
  failed.aggregate.failedScenarios = 1;
  failed.aggregate.successfulScenarios -= 1;
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report: failed,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /complete successful workload/,
  );
});

test("baseline promotion rejects non-canonical repetition provenance", () => {
  const report = promotableReport();
  report.scenarioStatistics[0].measuredRepetitions += 1;
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /repetition provenance/,
  );
});

test("baseline promotion rejects inconsistent aggregate measurements", () => {
  const report = promotableReport();
  report.aggregate.totals.toolCalls = 1;

  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /aggregate\.totals\.toolCalls/,
  );
});

test("baseline promotion rejects statistical summaries not derived from retained samples", () => {
  const report = promotableReport();
  const summary = report.scenarioStatistics[0].metrics.wallDurationMs;
  summary.p95 = 1;
  summary.max = 1;

  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /retained samples/,
  );
});

test("baseline promotion rejects retained samples inconsistent with aggregate measurements", () => {
  const report = promotableReport();
  report.scenarioStatistics[0].samples[0].wallDurationMs = 1;

  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /samples do not match result/,
  );
});

test("baseline promotion rejects inconsistent derived scenario metrics", () => {
  const report = promotableReport();
  report.aggregate.results[0].measurements.workflowApiAmplification = 1;

  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /workflowApiAmplification/,
  );
});

test("baseline promotion rejects secret-shaped execution provenance", () => {
  const report = promotableReport();
  report.executionProvenance.commitRef =
    "Bearer benchmark-secret-token-value-1234567890";
  assert.throws(
    () =>
      promoteWorkloadBaseline({
        report,
        manifest: WORKLOAD_MANIFEST,
        surfaceBaseline: SURFACE_BASELINE,
      }),
    /secret/i,
  );
});
