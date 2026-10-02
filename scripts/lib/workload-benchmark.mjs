export const WORKLOAD_REPORT_SCHEMA_VERSION = 1;
export const WORKLOAD_CLASSIFICATION = "benchmark";
export const WORKLOAD_MODES = Object.freeze(["correctness", "benchmark"]);

export const REQUIRED_SCENARIO_CATEGORIES = Object.freeze([
  "context",
  "repository",
  "issues",
  "merge_request_review",
  "merge_request_mutation",
  "ci_diagnosis",
  "ci_operations",
  "governance",
  "release_deployment",
  "failure_safety",
]);

export const STANDARD_WORKLOAD_METRICS = Object.freeze([
  "wallDurationMs",
  "toolCalls",
  "gitlabLogicalRequests",
  "gitlabPhysicalAttempts",
  "gitlabResponseBytes",
  "mcpResultBytes",
  "presentationTruncations",
  "retries",
  "cacheHits",
  "cacheMisses",
  "admissionRejections",
]);

const MUTATION_LEVELS = new Set(["none", "write", "destructive"]);
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:authorization|password|private_token|secret|token|value)(?:$|_)/i;
const SECRET_VALUE_MARKERS = Object.freeze([
  "glpat-",
  "bearer ",
  "bearer\t",
  "private-token",
  "private_token",
  "private token",
  "authorization",
]);

function containsSecretShapedValue(value) {
  const normalized = value.toLowerCase();
  return SECRET_VALUE_MARKERS.some((marker) => normalized.includes(marker));
}

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

function assertStrings(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`));
  return value;
}

function assertInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new Error(
      `${label} must be a ${positive ? "positive" : "non-negative"} safe integer.`,
    );
  }
  return value;
}

function assertMeasurement(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function validateExecutionProfiles(profiles) {
  assertObject(profiles, "executionProfiles");
  for (const [name, profile] of Object.entries(profiles)) {
    assertString(name, "execution profile name");
    assertObject(profile, `executionProfiles.${name}`);
    if (typeof profile.correctness !== "boolean") {
      throw new TypeError(
        `executionProfiles.${name}.correctness must be boolean.`,
      );
    }
    assertInteger(
      profile.benchmarkRepetitions,
      `executionProfiles.${name}.benchmarkRepetitions`,
      { positive: true },
    );
    assertInteger(
      profile.warmupRepetitions,
      `executionProfiles.${name}.warmupRepetitions`,
    );
  }
}

function validateScenario(scenario, index, profiles) {
  assertObject(scenario, `scenarios[${index}]`);
  assertString(scenario.id, `scenarios[${index}].id`);
  assertString(scenario.category, `scenario ${scenario.id}.category`);
  assertString(scenario.goal, `scenario ${scenario.id}.goal`);
  if (!MUTATION_LEVELS.has(scenario.mutation)) {
    throw new Error(
      `Scenario ${scenario.id} mutation must be none, write, or destructive.`,
    );
  }
  if (typeof scenario.requiresDisposable !== "boolean") {
    throw new TypeError(
      `Scenario ${scenario.id} requiresDisposable must be boolean.`,
    );
  }
  assertString(scenario.fixtureState, `scenario ${scenario.id}.fixtureState`);
  assertStrings(scenario.fixtureSetup, `scenario ${scenario.id}.fixtureSetup`);
  assertStrings(
    scenario.permittedEffects,
    `scenario ${scenario.id}.permittedEffects`,
  );
  assertStrings(
    scenario.forbiddenEffects,
    `scenario ${scenario.id}.forbiddenEffects`,
  );
  assertStrings(
    scenario.expectedFinalState,
    `scenario ${scenario.id}.expectedFinalState`,
  );
  assertStrings(scenario.cleanup, `scenario ${scenario.id}.cleanup`, {
    allowEmpty: true,
  });
  if (scenario.metrics !== "standard") {
    throw new Error(
      `Scenario ${scenario.id} must declare the standard metric profile.`,
    );
  }
  assertString(scenario.execution, `scenario ${scenario.id}.execution`);
  const profile = profiles[scenario.execution];
  if (!profile) {
    throw new Error(
      `Scenario ${scenario.id} references unknown execution profile ${scenario.execution}.`,
    );
  }
  if (scenario.mutation !== "none") {
    if (!scenario.requiresDisposable) {
      throw new Error(
        `Mutation scenario ${scenario.id} must require a disposable target.`,
      );
    }
    if (scenario.cleanup.length === 0) {
      throw new Error(
        `Mutation scenario ${scenario.id} must declare bounded cleanup.`,
      );
    }
    if (profile.warmupRepetitions !== 0) {
      throw new Error(
        `Mutation scenario ${scenario.id} must not perform untracked warm-up mutations.`,
      );
    }
  }
}

export function validateWorkloadManifest(manifest) {
  assertObject(manifest, "workload manifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error("Workload manifest schemaVersion must be 1.");
  }
  if (manifest.classification !== WORKLOAD_CLASSIFICATION) {
    throw new Error(
      `Workload manifest classification must be ${WORKLOAD_CLASSIFICATION}.`,
    );
  }
  assertString(manifest.workload, "workload");
  assertInteger(manifest.workloadVersion, "workloadVersion", {
    positive: true,
  });
  const provenance = assertObject(
    manifest.metricProvenance,
    "metricProvenance",
  );
  assertString(provenance.contract, "metricProvenance.contract");
  assertString(provenance.source, "metricProvenance.source");
  assertString(provenance.collection, "metricProvenance.collection");
  assertStrings(manifest.standardMetrics, "standardMetrics");
  if (
    manifest.standardMetrics.length !== STANDARD_WORKLOAD_METRICS.length ||
    STANDARD_WORKLOAD_METRICS.some(
      (metric, index) => manifest.standardMetrics[index] !== metric,
    )
  ) {
    throw new Error(
      "Workload manifest standardMetrics must match the canonical metric order.",
    );
  }

  validateExecutionProfiles(manifest.executionProfiles);
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length < 30) {
    throw new Error("Workload manifest must define at least 30 scenarios.");
  }

  const ids = new Set();
  const categories = new Set();
  manifest.scenarios.forEach((scenario, index) => {
    validateScenario(scenario, index, manifest.executionProfiles);
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate workload scenario id: ${scenario.id}.`);
    }
    ids.add(scenario.id);
    categories.add(scenario.category);
  });
  for (const category of REQUIRED_SCENARIO_CATEGORIES) {
    if (!categories.has(category)) {
      throw new Error(
        `Workload manifest is missing required scenario category ${category}.`,
      );
    }
  }
  return true;
}

function resolvedScenario(manifest, scenario) {
  return {
    ...scenario,
    execution: structuredClone(manifest.executionProfiles[scenario.execution]),
  };
}

export function selectedScenariosForMode(manifest, mode) {
  validateWorkloadManifest(manifest);
  if (!WORKLOAD_MODES.includes(mode)) {
    throw new Error(`Unknown workload execution mode: ${mode}.`);
  }
  return manifest.scenarios
    .filter(
      (scenario) =>
        mode === "benchmark" ||
        manifest.executionProfiles[scenario.execution].correctness,
    )
    .map((scenario) => resolvedScenario(manifest, scenario));
}

export function assertExecutionSafety(
  scenarios,
  { mode, disposableTargetVerified = false } = {},
) {
  if (!WORKLOAD_MODES.includes(mode)) {
    throw new Error(`Unknown workload execution mode: ${mode}.`);
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("At least one workload scenario must be selected.");
  }
  const unsafe = scenarios.filter(
    (scenario) =>
      scenario.mutation !== "none" || scenario.requiresDisposable === true,
  );
  if (unsafe.length > 0 && disposableTargetVerified !== true) {
    throw new Error(
      `Refusing ${mode} workload: ${unsafe.length} selected scenario(s) require a positively verified disposable target.`,
    );
  }
  return true;
}

export function measurementsFromObservabilityEvents(
  events,
  { wallDurationMs = 0 } = {},
) {
  if (!Array.isArray(events)) {
    throw new TypeError("Observability events must be an array.");
  }
  const result = Object.fromEntries(
    STANDARD_WORKLOAD_METRICS.map((metric) => [metric, 0]),
  );
  result.wallDurationMs = assertMeasurement(wallDurationMs, "wallDurationMs");

  for (const event of events) {
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.metric !== "string"
    ) {
      continue;
    }
    const value = event.value === undefined ? 1 : Number(event.value);
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    switch (event.metric) {
      case "gitlab_mcp.tool.calls":
        result.toolCalls += value;
        break;
      case "gitlab_mcp.gitlab.request.duration":
        result.gitlabLogicalRequests += 1;
        break;
      case "gitlab_mcp.gitlab.response.size":
        result.gitlabResponseBytes += value;
        break;
      case "gitlab_mcp.tool.result.size":
        result.mcpResultBytes += value;
        break;
      case "gitlab_mcp.tool.presentation.truncations":
        result.presentationTruncations += value;
        break;
      case "gitlab_mcp.gitlab.retries":
        result.retries += value;
        break;
      case "gitlab_mcp.cache.requests":
        if (event.attributes?.result === "hit") {
          result.cacheHits += value;
        } else if (event.attributes?.result === "miss") {
          result.cacheMisses += value;
        }
        break;
      case "gitlab_mcp.http.admission.rejections":
        result.admissionRejections += value;
        break;
      default:
        break;
    }
  }
  result.gitlabPhysicalAttempts = result.gitlabLogicalRequests + result.retries;
  return result;
}

function completionCount(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "completed must be boolean or a non-negative safe integer.",
    );
  }
  return value;
}

function completedExecutions(result) {
  if (result?.success !== true) return 0;
  return Array.isArray(result.samples) ? result.samples.length : 1;
}

export function deriveScenarioMetrics(measurements, { completed = true } = {}) {
  assertObject(measurements, "scenario measurements");
  const normalized = {};
  for (const metric of STANDARD_WORKLOAD_METRICS) {
    normalized[metric] = assertMeasurement(
      measurements[metric],
      `scenario measurements.${metric}`,
    );
  }
  const completedCount = completionCount(completed);
  return {
    ...normalized,
    gitlabApiAmplification:
      normalized.toolCalls > 0
        ? normalized.gitlabLogicalRequests / normalized.toolCalls
        : null,
    workflowApiAmplification:
      completedCount > 0
        ? normalized.gitlabLogicalRequests / completedCount
        : null,
    contextAmplification:
      normalized.gitlabResponseBytes > 0
        ? normalized.mcpResultBytes / normalized.gitlabResponseBytes
        : null,
  };
}

function normalizeResult(result, index) {
  assertObject(result, `results[${index}]`);
  assertString(result.scenarioId, `results[${index}].scenarioId`);
  if (typeof result.success !== "boolean") {
    throw new TypeError(`Result ${result.scenarioId} success must be boolean.`);
  }
  if (typeof result.finalStateVerified !== "boolean") {
    throw new TypeError(
      `Result ${result.scenarioId} finalStateVerified must be boolean.`,
    );
  }
  assertStrings(
    result.forbiddenEffectsObserved,
    `result ${result.scenarioId}.forbiddenEffectsObserved`,
    { allowEmpty: true },
  );
  return {
    scenarioId: result.scenarioId,
    success: result.success,
    finalStateVerified: result.finalStateVerified,
    forbiddenEffectsObserved: [...result.forbiddenEffectsObserved].sort(
      (left, right) => (left > right) - (left < right),
    ),
    measurements: deriveScenarioMetrics(result.measurements, {
      completed: completedExecutions(result),
    }),
  };
}

export function aggregateScenarioResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("At least one scenario result is required.");
  }
  const normalized = results
    .map((result, index) => normalizeResult(result, index))
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  const ids = new Set();
  for (const entry of normalized) {
    if (ids.has(entry.scenarioId)) {
      throw new Error(`Duplicate scenario result id: ${entry.scenarioId}.`);
    }
    ids.add(entry.scenarioId);
  }

  const totals = Object.fromEntries(
    STANDARD_WORKLOAD_METRICS.map((metric) => [metric, 0]),
  );
  let successfulScenarios = 0;
  let finalStateFailures = 0;
  const safetyViolations = [];
  for (const entry of normalized) {
    successfulScenarios += entry.success ? 1 : 0;
    finalStateFailures += entry.finalStateVerified ? 0 : 1;
    for (const metric of STANDARD_WORKLOAD_METRICS) {
      totals[metric] += entry.measurements[metric];
    }
    entry.forbiddenEffectsObserved.forEach((effect) =>
      safetyViolations.push({ scenarioId: entry.scenarioId, effect }),
    );
  }
  const completedCount = results.reduce(
    (total, result) => total + completedExecutions(result),
    0,
  );
  const totalMeasurements = deriveScenarioMetrics(totals, {
    completed: completedCount,
  });

  return {
    scenarioCount: normalized.length,
    successfulScenarios,
    failedScenarios: normalized.length - successfulScenarios,
    finalStateFailures,
    safetyViolationCount: safetyViolations.length,
    safetyViolations,
    totals: totalMeasurements,
    results: normalized,
  };
}

export function assertSecretSafeReport(value, path = "report") {
  if (typeof value === "string") {
    if (containsSecretShapedValue(value)) {
      throw new Error(`Potential secret material detected at ${path}.`);
    }
    return true;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretSafeReport(entry, `${path}[${index}]`),
    );
    return true;
  }
  if (!value || typeof value !== "object") {
    return true;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      SECRET_KEY_PATTERN.test(key) &&
      entry !== undefined &&
      entry !== null &&
      entry !== ""
    ) {
      throw new Error(`Secret-bearing field ${path}.${key} is not reportable.`);
    }
    assertSecretSafeReport(entry, `${path}.${key}`);
  }
  return true;
}

export function buildWorkloadReport({
  commitSha,
  serverVersion,
  workload,
  workloadVersion,
  fixtureConfigurationId,
  mode,
  repetitions,
  generatedAt,
  metricProvenance,
  results,
}) {
  if (!/^[0-9a-f]{40}$/i.test(commitSha || "")) {
    throw new Error(
      "commitSha must be a full 40-character hexadecimal Git SHA.",
    );
  }
  assertString(serverVersion, "serverVersion");
  assertString(workload, "workload");
  assertInteger(workloadVersion, "workloadVersion", { positive: true });
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(fixtureConfigurationId || "")) {
    throw new Error(
      "fixtureConfigurationId must be a bounded non-secret identifier.",
    );
  }
  if (!WORKLOAD_MODES.includes(mode)) {
    throw new Error(`Unknown workload execution mode: ${mode}.`);
  }
  assertInteger(repetitions, "repetitions", { positive: true });
  assertString(generatedAt, "generatedAt");
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new TypeError(
      "generatedAt must be an ISO-8601-compatible timestamp.",
    );
  }

  const report = {
    schemaVersion: WORKLOAD_REPORT_SCHEMA_VERSION,
    classification: WORKLOAD_CLASSIFICATION,
    workload,
    workloadVersion,
    commitSha: commitSha.toLowerCase(),
    serverVersion,
    fixtureConfigurationId,
    mode,
    repetitions,
    generatedAt,
    metricProvenance: structuredClone(
      assertObject(metricProvenance, "metricProvenance"),
    ),
    aggregate: aggregateScenarioResults(results),
  };
  assertSecretSafeReport(report);
  return report;
}

function ratio(value) {
  return value === null ? "n/a" : value.toFixed(3);
}

export function renderWorkloadMarkdown(report) {
  assertSecretSafeReport(report);
  const { aggregate } = report;
  const lines = [
    "# GitLab MCP synthetic workload report",
    "",
    `- Workload: \`${report.workload}\` v${report.workloadVersion}`,
    `- Commit: \`${report.commitSha}\``,
    `- Server: \`${report.serverVersion}\``,
    `- Fixture: \`${report.fixtureConfigurationId}\``,
    `- Mode: \`${report.mode}\``,
    `- Repetitions: ${report.repetitions}`,
    `- Scenarios: ${aggregate.successfulScenarios}/${aggregate.scenarioCount} successful`,
    `- Safety violations: ${aggregate.safetyViolationCount}`,
    `- Final-state validation failures: ${aggregate.finalStateFailures}`,
    "",
    "## Aggregate measurements",
    "",
    "| Measurement | Value |",
    "| --- | ---: |",
    `| Tool calls | ${aggregate.totals.toolCalls} |`,
    `| GitLab logical requests | ${aggregate.totals.gitlabLogicalRequests} |`,
    `| GitLab physical attempts | ${aggregate.totals.gitlabPhysicalAttempts} |`,
    `| GitLab response bytes | ${aggregate.totals.gitlabResponseBytes} |`,
    `| MCP result bytes | ${aggregate.totals.mcpResultBytes} |`,
    `| Presentation truncations | ${aggregate.totals.presentationTruncations} |`,
    `| Retries | ${aggregate.totals.retries} |`,
    `| Cache hits | ${aggregate.totals.cacheHits} |`,
    `| Cache misses | ${aggregate.totals.cacheMisses} |`,
    `| Admission rejections | ${aggregate.totals.admissionRejections} |`,
    `| GitLab API amplification | ${ratio(aggregate.totals.gitlabApiAmplification)} |`,
    `| Workflow API amplification | ${ratio(aggregate.totals.workflowApiAmplification)} |`,
    `| Context amplification | ${ratio(aggregate.totals.contextAmplification)} |`,
    "",
    "## Scenario results",
    "",
    "| Scenario | Success | Final state | Tool calls | GitLab requests | MCP bytes |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  ];
  for (const entry of aggregate.results) {
    lines.push(
      `| \`${entry.scenarioId}\` | ${entry.success ? "yes" : "no"} | ${entry.finalStateVerified ? "verified" : "failed"} | ${entry.measurements.toolCalls} | ${entry.measurements.gitlabLogicalRequests} | ${entry.measurements.mcpResultBytes} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
