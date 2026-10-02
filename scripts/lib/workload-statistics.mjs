import {
  STANDARD_WORKLOAD_METRICS,
  assertSecretSafeReport,
  renderWorkloadMarkdown,
} from "./workload-benchmark.mjs";

function normalizedSampleMeasurements(sample, index) {
  return Object.fromEntries(
    STANDARD_WORKLOAD_METRICS.map((metric) => {
      const value = Number(sample?.measurements?.[metric]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          `Sample ${index} metric ${metric} must be a finite non-negative number.`,
        );
      }
      return [metric, value];
    }),
  );
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

export function summarizeValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = values.map(Number).sort((left, right) => left - right);
  if (sorted.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Statistical samples must be finite non-negative numbers.");
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    mean: sum / sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

export function summarizeScenarioSamples(result) {
  const samples = Array.isArray(result?.samples) ? result.samples : [];
  const retainedSamples = samples.map(normalizedSampleMeasurements);
  const metrics = {};
  for (const metric of STANDARD_WORKLOAD_METRICS) {
    metrics[metric] = summarizeValues(
      retainedSamples.map((sample) => sample[metric]),
    );
  }
  return {
    scenarioId: result.scenarioId,
    measuredRepetitions: retainedSamples.length,
    warmupsCompleted: Number.isSafeInteger(result.warmupsCompleted)
      ? result.warmupsCompleted
      : 0,
    samples: retainedSamples,
    metrics,
  };
}

export function addWorkloadStatistics(report, rawResults) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TypeError("Workload report must be an object.");
  }
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    throw new Error("Raw workload results are required for statistics.");
  }
  const enriched = {
    ...structuredClone(report),
    repetitionPolicy: "per-scenario-profile",
    scenarioStatistics: rawResults
      .map(summarizeScenarioSamples)
      .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
  };
  assertSecretSafeReport(enriched);
  return enriched;
}

function printable(value) {
  return value === null ? "n/a" : Number(value.toFixed(3)).toString();
}

export function renderStatisticalWorkloadMarkdown(report) {
  assertSecretSafeReport(report);
  const base = renderWorkloadMarkdown(report).trimEnd();
  if (!Array.isArray(report.scenarioStatistics)) {
    return `${base}\n`;
  }
  const lines = [base];
  if (report.surfaceProvenance) {
    lines.push(
      "",
      "## Surface provenance",
      "",
      `- Mode: \`${report.surfaceProvenance.mode}\``,
      `- Tool count: ${report.surfaceProvenance.toolCount}`,
      `- Definition fingerprint: \`${report.surfaceProvenance.definitionFingerprint}\``,
    );
  }
  lines.push(
    "",
    "## Repeated-run statistics",
    "",
    "Statistics are calculated per scenario from measured repetitions; fixture setup, warm-ups, verification, and cleanup are excluded from the measured window.",
    "",
    "| Scenario | Samples | Warm-ups | Wall ms mean | Wall ms median | Wall ms p95 | GitLab requests mean | MCP bytes mean |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const entry of report.scenarioStatistics) {
    const wall = entry.metrics.wallDurationMs;
    const requests = entry.metrics.gitlabLogicalRequests;
    const bytes = entry.metrics.mcpResultBytes;
    lines.push(
      `| \`${entry.scenarioId}\` | ${entry.measuredRepetitions} | ${entry.warmupsCompleted} | ${printable(wall?.mean ?? null)} | ${printable(wall?.median ?? null)} | ${printable(wall?.p95 ?? null)} | ${printable(requests?.mean ?? null)} | ${printable(bytes?.mean ?? null)} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
