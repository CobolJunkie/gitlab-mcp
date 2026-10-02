#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { WORKLOAD_MANIFEST } from "../benchmarks/workload-scenarios.mjs";
import { SERVER_VERSION } from "../server/src/version.mjs";
import {
  assertSecretSafeReport,
  buildWorkloadReport,
  selectedScenariosForMode,
} from "./lib/workload-benchmark.mjs";
import { workloadExecutionProvenance } from "./lib/workload-baseline.mjs";
import { executeWorkload } from "./lib/workload-execution.mjs";
import { createLiveWorkloadHandlers } from "./lib/workload-live-handlers.mjs";
import { createLiveBenchmarkSession } from "./lib/workload-live-session.mjs";
import { assertLiveBenchmarkCheckoutProvenance } from "./lib/workload-promotion-checkout.mjs";
import {
  addWorkloadStatistics,
  renderStatisticalWorkloadMarkdown,
} from "./lib/workload-statistics.mjs";
import { auditCanonicalSurfaces } from "./lib/surface-audit.mjs";

const execFileAsync = promisify(execFile);

function optionValue(prefix) {
  return process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function selectedIds() {
  const raw =
    optionValue("--scenarios=") || process.env.BENCHMARK_WORKLOAD_SCENARIOS;
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(
      "BENCHMARK_WORKLOAD_SCENARIOS must select at least one ID.",
    );
  }
  return new Set(ids);
}

function fullCommitSha(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  const invalidCharacter = [...normalized].some(
    (character) => !"0123456789abcdef".includes(character),
  );
  if (normalized.length !== 40 || invalidCharacter) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return normalized;
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" });
  return stdout.trim();
}

async function benchmarkCommitSha() {
  const explicitCommitSha = optionValue("--commit-sha=");
  const ciCommitSha = process.env.CI_COMMIT_SHA;
  const attributedCommitSha = fullCommitSha(
    explicitCommitSha || ciCommitSha || "",
    "Live workload benchmark commit SHA",
  );

  if (ciCommitSha) {
    assertLiveBenchmarkCheckoutProvenance({
      benchmarkCommitSha: attributedCommitSha,
      checkoutCommitSha: fullCommitSha(ciCommitSha, "CI_COMMIT_SHA"),
      trackedChanges: "",
    });
    return attributedCommitSha;
  }

  const [checkoutCommitSha, trackedChanges] = await Promise.all([
    gitOutput(["rev-parse", "HEAD"]),
    gitOutput(["status", "--porcelain=v1", "--untracked-files=no"]),
  ]);
  assertLiveBenchmarkCheckoutProvenance({
    benchmarkCommitSha: attributedCommitSha,
    checkoutCommitSha,
    trackedChanges,
  });
  return attributedCommitSha;
}

async function writeOutput(path, content) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return absolute;
}

const mode =
  optionValue("--mode=") ||
  process.env.BENCHMARK_WORKLOAD_MODE ||
  "correctness";
let scenarios = selectedScenariosForMode(WORKLOAD_MANIFEST, mode);
const ids = selectedIds();
if (ids) {
  const known = new Set(scenarios.map(({ id }) => id));
  const unknown = [...ids].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Selected scenario(s) are not available in ${mode} mode: ${unknown.join(", ")}.`,
    );
  }
  scenarios = scenarios.filter(({ id }) => ids.has(id));
}
if (scenarios.length === 0) {
  throw new Error("No live workload scenarios were selected.");
}

const commitSha = await benchmarkCommitSha();
const jsonOutput =
  optionValue("--json-out=") ||
  process.env.BENCHMARK_WORKLOAD_JSON ||
  "benchmark-results/workload-report.json";
const markdownOutput =
  optionValue("--markdown-out=") ||
  process.env.BENCHMARK_WORKLOAD_MARKDOWN ||
  "benchmark-results/workload-report.md";

const session = await createLiveBenchmarkSession();
try {
  const handlers = createLiveWorkloadHandlers(session);

  const results = await executeWorkload({
    scenarios,
    mode,
    disposableTargetVerified: true,
    handlers,
  });

  const repetitions =
    mode === "benchmark"
      ? Math.max(
          ...scenarios.map(
            (scenario) => scenario.execution.benchmarkRepetitions,
          ),
        )
      : 1;
  const baseReport = buildWorkloadReport({
    commitSha,
    serverVersion: SERVER_VERSION,
    workload: WORKLOAD_MANIFEST.workload,
    workloadVersion: WORKLOAD_MANIFEST.workloadVersion,
    fixtureConfigurationId: session.fixtureConfigurationId,
    mode,
    repetitions,
    generatedAt: new Date().toISOString(),
    metricProvenance: WORKLOAD_MANIFEST.metricProvenance,
    results,
  });
  const failureDiagnostics = results
    .filter((result) => !result.success && result.failurePhase)
    .map((result) => ({
      scenarioId: result.scenarioId,
      failurePhase: result.failurePhase,
    }));
  if (failureDiagnostics.length > 0) {
    baseReport.failureDiagnostics = failureDiagnostics;
  }
  baseReport.executionProvenance = workloadExecutionProvenance();
  const surfaces = await auditCanonicalSurfaces();
  baseReport.surfaceProvenance = {
    mode: surfaces.all.mode,
    toolCount: surfaces.all.toolCount,
    definitionFingerprint: surfaces.all.definitionFingerprint,
  };
  const report = addWorkloadStatistics(baseReport, results);
  assertSecretSafeReport(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderStatisticalWorkloadMarkdown(report);

  const [jsonPath, markdownPath] = await Promise.all([
    writeOutput(jsonOutput, json),
    writeOutput(markdownOutput, markdown),
  ]);
  console.log(
    JSON.stringify(
      {
        mode,
        fixtureConfigurationId: session.fixtureConfigurationId,
        scenarioCount: report.aggregate.scenarioCount,
        successfulScenarios: report.aggregate.successfulScenarios,
        failedScenarios: report.aggregate.failedScenarios,
        safetyViolationCount: report.aggregate.safetyViolationCount,
        finalStateFailures: report.aggregate.finalStateFailures,
        jsonOutput: jsonPath,
        markdownOutput: markdownPath,
      },
      null,
      2,
    ),
  );

  if (
    report.aggregate.failedScenarios > 0 ||
    report.aggregate.safetyViolationCount > 0 ||
    report.aggregate.finalStateFailures > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await session.close();
}
