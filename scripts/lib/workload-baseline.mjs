import {
  STANDARD_WORKLOAD_METRICS,
  WORKLOAD_REPORT_SCHEMA_VERSION,
  assertSecretSafeReport,
  deriveScenarioMetrics,
} from "./workload-benchmark.mjs";
import { summarizeValues } from "./workload-statistics.mjs";

const DERIVED_WORKLOAD_METRICS = Object.freeze([
  "gitlabApiAmplification",
  "workflowApiAmplification",
  "contextAmplification",
]);
const SUMMARY_FIELDS = Object.freeze(["min", "mean", "median", "p95", "max"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertMeasurement(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function approximatelyEqual(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * 64 * scale;
}

function assertEquivalentMetric(actual, expected, label) {
  if (expected === null) {
    if (actual !== null) {
      throw new Error(`${label} must be null.`);
    }
    return;
  }
  assertMeasurement(actual, label);
  if (!approximatelyEqual(actual, expected)) {
    throw new Error(`${label} does not match its derived value.`);
  }
}

function standardMeasurements(value, label) {
  const measurements = assertObject(value, label);
  return Object.fromEntries(
    STANDARD_WORKLOAD_METRICS.map((metric) => [
      metric,
      assertMeasurement(measurements[metric], `${label}.${metric}`),
    ]),
  );
}

function assertMeasurementSet(value, expected, label) {
  const measurements = assertObject(value, label);
  for (const metric of [
    ...STANDARD_WORKLOAD_METRICS,
    ...DERIVED_WORKLOAD_METRICS,
  ]) {
    assertEquivalentMetric(
      measurements[metric],
      expected[metric],
      `${label}.${metric}`,
    );
  }
}

function assertStatisticalSummary(summary, expected, label) {
  const values = assertObject(summary, label);
  for (const field of SUMMARY_FIELDS) {
    assertMeasurement(values[field], `${label}.${field}`);
  }
  if (
    values.min > values.mean ||
    values.mean > values.max ||
    values.min > values.median ||
    values.median > values.p95 ||
    values.p95 > values.max
  ) {
    throw new Error(`${label} has inconsistent statistical ordering.`);
  }
  for (const field of SUMMARY_FIELDS) {
    if (!approximatelyEqual(values[field], expected[field])) {
      throw new Error(`${label}.${field} does not match retained samples.`);
    }
  }
}

function retainedSamples(value, repetitions, label) {
  if (!Array.isArray(value) || value.length !== repetitions) {
    throw new Error(`${label} must retain every measured repetition.`);
  }
  return value.map((entry, index) =>
    standardMeasurements(entry, `${label}[${index}]`),
  );
}

function sortedIds(entries, label) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`${label} must be an array.`);
  }
  return entries
    .map((entry, index) =>
      assertString(entry?.scenarioId, `${label}[${index}].scenarioId`),
    )
    .sort((left, right) => left.localeCompare(right));
}

function assertExactScenarioIds(actualEntries, expectedIds, label) {
  const actualIds = sortedIds(actualEntries, label);
  const expected = [...expectedIds].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    actualIds.length !== expected.length ||
    actualIds.some((id, index) => id !== expected[index])
  ) {
    throw new Error(`${label} must cover the full canonical workload exactly.`);
  }
}

function assertAllSurface(value, label) {
  const surface = assertObject(value, label);
  if (surface.mode !== "all") {
    throw new Error(`${label}.mode must be all.`);
  }
  if (!Number.isSafeInteger(surface.toolCount) || surface.toolCount <= 0) {
    throw new Error(`${label}.toolCount must be a positive integer.`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(surface.definitionFingerprint || "")) {
    throw new Error(`${label}.definitionFingerprint is invalid.`);
  }
  return surface;
}

function assertReportIdentity(report) {
  if (report.schemaVersion !== WORKLOAD_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `Report schemaVersion must be ${WORKLOAD_REPORT_SCHEMA_VERSION}.`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(report.commitSha || "")) {
    throw new Error(
      "report.commitSha must be a full 40-character hexadecimal Git SHA.",
    );
  }
  assertString(report.serverVersion, "report.serverVersion");
  assertString(report.generatedAt, "report.generatedAt");
  if (Number.isNaN(Date.parse(report.generatedAt))) {
    throw new TypeError(
      "report.generatedAt must be an ISO-8601-compatible timestamp.",
    );
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(report.fixtureConfigurationId || "")) {
    throw new Error(
      "report.fixtureConfigurationId must be a bounded non-secret identifier.",
    );
  }
}

export function workloadExecutionProvenance(env = process.env) {
  const pipelineId = env.CI_PIPELINE_ID ? String(env.CI_PIPELINE_ID) : null;
  const pipelineSource = env.CI_PIPELINE_SOURCE || "local";
  const commitRef =
    env.CI_COMMIT_REF_NAME ||
    env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ||
    "local";
  const commitSha = env.CI_COMMIT_SHA ? String(env.CI_COMMIT_SHA) : null;
  return {
    pipelineId,
    pipelineSource,
    commitRef,
    commitSha,
    protectedRef: env.CI_COMMIT_REF_PROTECTED === "true",
  };
}

function assertPromotableReportMetadata(report, manifest) {
  if (report.classification !== "benchmark") {
    throw new Error("Only benchmark-classified reports can be promoted.");
  }
  if (report.mode !== "benchmark") {
    throw new Error("Only benchmark-mode reports can be promoted.");
  }
  if (report.repetitionPolicy !== "per-scenario-profile") {
    throw new Error(
      "Baseline promotion requires per-scenario-profile repetition provenance.",
    );
  }
  if (
    report.workload !== manifest.workload ||
    report.workloadVersion !== manifest.workloadVersion
  ) {
    throw new Error(
      "Report workload identity does not match the canonical manifest.",
    );
  }
}

function assertPromotableAggregate(report, scenarios, expectedIds) {
  const aggregate = assertObject(report.aggregate, "report.aggregate");
  if (
    aggregate.scenarioCount !== scenarios.length ||
    aggregate.successfulScenarios !== scenarios.length ||
    aggregate.failedScenarios !== 0 ||
    aggregate.safetyViolationCount !== 0 ||
    aggregate.finalStateFailures !== 0
  ) {
    throw new Error(
      "Only a complete successful workload with no safety/final-state failures can be promoted.",
    );
  }
  if (
    !Array.isArray(aggregate.safetyViolations) ||
    aggregate.safetyViolations.length !== 0
  ) {
    throw new Error("Promotable aggregate safety violations must be empty.");
  }

  assertExactScenarioIds(
    aggregate.results,
    expectedIds,
    "report.aggregate.results",
  );
  assertExactScenarioIds(
    report.scenarioStatistics,
    expectedIds,
    "report.scenarioStatistics",
  );
  return aggregate;
}

function assertPromotionSafeScenarioResult(result, scenarioId) {
  if (
    result.success !== true ||
    result.finalStateVerified !== true ||
    !Array.isArray(result.forbiddenEffectsObserved) ||
    result.forbiddenEffectsObserved.length !== 0
  ) {
    throw new Error(`Scenario ${scenarioId} is not promotion-safe.`);
  }
}

function assertScenarioRepetitionProvenance(statistics, profile, scenarioId) {
  if (
    statistics.measuredRepetitions !== profile.benchmarkRepetitions ||
    statistics.warmupsCompleted !== profile.warmupRepetitions
  ) {
    throw new Error(
      `Scenario ${scenarioId} repetition provenance does not match the canonical profile.`,
    );
  }
}

function validateScenarioStatistics(result, statistics, scenarioId) {
  const scenarioMeasurements = standardMeasurements(
    result.measurements,
    `result ${scenarioId}.measurements`,
  );
  const expectedScenarioMeasurements = deriveScenarioMetrics(
    scenarioMeasurements,
    { completed: statistics.measuredRepetitions },
  );
  assertMeasurementSet(
    result.measurements,
    expectedScenarioMeasurements,
    `result ${scenarioId}.measurements`,
  );

  const samples = retainedSamples(
    statistics.samples,
    statistics.measuredRepetitions,
    `statistics ${scenarioId}.samples`,
  );
  const metricStatistics = assertObject(
    statistics.metrics,
    `statistics ${scenarioId}.metrics`,
  );
  for (const metric of STANDARD_WORKLOAD_METRICS) {
    const sampleValues = samples.map((sample) => sample[metric]);
    const sampleTotal = sampleValues.reduce((total, value) => total + value, 0);
    if (!approximatelyEqual(sampleTotal, scenarioMeasurements[metric])) {
      throw new Error(
        `statistics ${scenarioId}.samples do not match result ${scenarioId}.measurements.${metric}.`,
      );
    }
    assertStatisticalSummary(
      metricStatistics[metric],
      summarizeValues(sampleValues),
      `statistics ${scenarioId}.metrics.${metric}`,
    );
  }
  return scenarioMeasurements;
}

function aggregatePromotionMeasurements({
  scenarios,
  manifest,
  resultsById,
  statisticsById,
}) {
  const aggregateStandardTotals = Object.fromEntries(
    STANDARD_WORKLOAD_METRICS.map((metric) => [metric, 0]),
  );
  let aggregateMeasuredRepetitions = 0;

  for (const scenario of scenarios) {
    const result = assertObject(
      resultsById.get(scenario.id),
      `result ${scenario.id}`,
    );
    assertPromotionSafeScenarioResult(result, scenario.id);

    const profile = assertObject(
      manifest.executionProfiles?.[scenario.execution],
      `execution profile ${scenario.execution}`,
    );
    const statistics = assertObject(
      statisticsById.get(scenario.id),
      `statistics ${scenario.id}`,
    );
    assertScenarioRepetitionProvenance(statistics, profile, scenario.id);

    const scenarioMeasurements = validateScenarioStatistics(
      result,
      statistics,
      scenario.id,
    );
    for (const metric of STANDARD_WORKLOAD_METRICS) {
      aggregateStandardTotals[metric] += scenarioMeasurements[metric];
    }
    aggregateMeasuredRepetitions += statistics.measuredRepetitions;
  }

  return { aggregateStandardTotals, aggregateMeasuredRepetitions };
}

function assertAggregatePromotionMeasurements(
  aggregate,
  aggregateStandardTotals,
  aggregateMeasuredRepetitions,
) {
  const expectedAggregateMeasurements = deriveScenarioMetrics(
    aggregateStandardTotals,
    { completed: aggregateMeasuredRepetitions },
  );
  assertMeasurementSet(
    aggregate.totals,
    expectedAggregateMeasurements,
    "report.aggregate.totals",
  );
}

function assertRepetitionSummary(report, scenarios, manifest) {
  const expectedRepetitions = Math.max(
    ...scenarios.map(
      (scenario) =>
        manifest.executionProfiles[scenario.execution].benchmarkRepetitions,
    ),
  );
  if (report.repetitions !== expectedRepetitions) {
    throw new Error(
      "Report repetition summary does not match the canonical workload.",
    );
  }
}

function assertMetricProvenance(report, manifest) {
  const reportMetricProvenance = assertObject(
    report.metricProvenance,
    "report.metricProvenance",
  );
  const manifestMetricProvenance = assertObject(
    manifest.metricProvenance,
    "manifest.metricProvenance",
  );
  for (const key of ["contract", "source", "collection"]) {
    if (reportMetricProvenance[key] !== manifestMetricProvenance[key]) {
      throw new Error(`Metric provenance mismatch for ${key}.`);
    }
  }
}

function assertExecutionProvenance(report) {
  const execution = assertObject(
    report.executionProvenance,
    "report.executionProvenance",
  );
  if (execution.protectedRef !== true) {
    throw new Error(
      "Baseline promotion requires a protected-ref benchmark run.",
    );
  }
  if (!new Set(["schedule", "web"]).has(execution.pipelineSource)) {
    throw new Error(
      "Baseline promotion requires a protected scheduled or manual/web pipeline.",
    );
  }
  if (!/^\d+$/.test(execution.pipelineId || "")) {
    throw new Error(
      "report.executionProvenance.pipelineId must be a numeric GitLab pipeline ID.",
    );
  }
  assertString(execution.commitRef, "report.executionProvenance.commitRef");
  if (!/^[0-9a-f]{40}$/i.test(execution.commitSha || "")) {
    throw new Error(
      "report.executionProvenance.commitSha must be a full Git commit SHA.",
    );
  }
  if (execution.commitSha.toLowerCase() !== report.commitSha.toLowerCase()) {
    throw new Error(
      "Report commit SHA does not match protected CI execution provenance.",
    );
  }
  return execution;
}

function assertSurfaceProvenance(report, surfaceBaseline) {
  const reportSurface = assertAllSurface(
    report.surfaceProvenance,
    "report.surfaceProvenance",
  );
  const allSurface = assertAllSurface(
    surfaceBaseline.surfaces?.all,
    "surfaceBaseline.surfaces.all",
  );
  if (
    reportSurface.toolCount !== allSurface.toolCount ||
    reportSurface.definitionFingerprint !== allSurface.definitionFingerprint
  ) {
    throw new Error(
      "Report surface provenance does not match the canonical all surface.",
    );
  }
  return allSurface;
}

export function promoteWorkloadBaseline({ report, manifest, surfaceBaseline }) {
  assertObject(report, "workload report");
  assertObject(manifest, "workload manifest");
  assertObject(surfaceBaseline, "surface baseline");
  assertReportIdentity(report);
  assertPromotableReportMetadata(report, manifest);

  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : [];
  if (scenarios.length === 0) {
    throw new Error("Canonical workload manifest has no scenarios.");
  }
  const expectedIds = scenarios.map(({ id }) => id);
  const aggregate = assertPromotableAggregate(report, scenarios, expectedIds);
  const resultsById = new Map(
    aggregate.results.map((entry) => [entry.scenarioId, entry]),
  );
  const statisticsById = new Map(
    report.scenarioStatistics.map((entry) => [entry.scenarioId, entry]),
  );
  const { aggregateStandardTotals, aggregateMeasuredRepetitions } =
    aggregatePromotionMeasurements({
      scenarios,
      manifest,
      resultsById,
      statisticsById,
    });
  assertAggregatePromotionMeasurements(
    aggregate,
    aggregateStandardTotals,
    aggregateMeasuredRepetitions,
  );
  assertRepetitionSummary(report, scenarios, manifest);
  assertMetricProvenance(report, manifest);

  const execution = assertExecutionProvenance(report);
  const allSurface = assertSurfaceProvenance(report, surfaceBaseline);
  const baseline = {
    schemaVersion: 1,
    classification: "benchmark",
    baseline: "gitlab-mcp-synthetic-all-surface-v1",
    surface: {
      mode: "all",
      toolCount: allSurface.toolCount,
      definitionFingerprint: allSurface.definitionFingerprint,
    },
    promotion: {
      sourceCommitSha: report.commitSha,
      generatedAt: report.generatedAt,
      serverVersion: report.serverVersion,
      fixtureConfigurationId: report.fixtureConfigurationId,
      pipelineId: execution.pipelineId,
      pipelineSource: execution.pipelineSource,
      commitRef: execution.commitRef,
    },
    report: structuredClone(report),
  };
  assertSecretSafeReport(baseline);
  return baseline;
}
