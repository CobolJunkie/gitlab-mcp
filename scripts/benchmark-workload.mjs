#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { WORKLOAD_MANIFEST } from "../benchmarks/workload-scenarios.mjs";
import { SERVER_VERSION } from "../server/src/version.mjs";
import {
  assertExecutionSafety,
  buildWorkloadReport,
  renderWorkloadMarkdown,
  selectedScenariosForMode,
  validateWorkloadManifest,
} from "./lib/workload-benchmark.mjs";

function optionValue(prefix) {
  return process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

const manifest = WORKLOAD_MANIFEST;
validateWorkloadManifest(manifest);

const mode = optionValue("--mode=") || "correctness";
const selected = selectedScenariosForMode(manifest, mode);

if (process.argv.includes("--check")) {
  const categoryCounts = new Map();
  for (const scenario of manifest.scenarios) {
    categoryCounts.set(
      scenario.category,
      (categoryCounts.get(scenario.category) || 0) + 1,
    );
  }
  console.log(
    JSON.stringify(
      {
        workload: manifest.workload,
        workloadVersion: manifest.workloadVersion,
        scenarioCount: manifest.scenarios.length,
        selectedScenarioCount: selected.length,
        categories: Object.fromEntries(
          [...categoryCounts.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const resultsPath = optionValue("--results=");
if (!resultsPath) {
  console.log(
    JSON.stringify(
      {
        workload: manifest.workload,
        workloadVersion: manifest.workloadVersion,
        mode,
        scenarios: selected.map(
          ({
            id,
            category,
            goal,
            mutation,
            requiresDisposable,
            execution,
          }) => ({
            id,
            category,
            goal,
            mutation,
            requiresDisposable,
            repetitions:
              mode === "benchmark" ? execution.benchmarkRepetitions : 1,
            warmupRepetitions:
              mode === "benchmark" ? execution.warmupRepetitions : 0,
          }),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const resultsDocument = JSON.parse(
  await readFile(resolve(resultsPath), "utf8"),
);
const results = Array.isArray(resultsDocument)
  ? resultsDocument
  : resultsDocument.results;
if (!Array.isArray(results)) {
  throw new TypeError(
    "Benchmark result input must be an array or contain results.",
  );
}

const disposableTargetVerified =
  resultsDocument.disposableTargetVerified === true;
const selectedById = new Map(
  selected.map((scenario) => [scenario.id, scenario]),
);
const executedIds = new Set(results.map((result) => result.scenarioId));
for (const scenarioId of executedIds) {
  if (!selectedById.has(scenarioId)) {
    throw new Error(
      `Result ${scenarioId} is not part of the selected ${mode} workload.`,
    );
  }
}
const executedScenarios = [...executedIds].map((scenarioId) =>
  selectedById.get(scenarioId),
);
assertExecutionSafety(executedScenarios, {
  mode,
  disposableTargetVerified,
});

const commitSha =
  optionValue("--commit-sha=") || process.env.CI_COMMIT_SHA || "";
const fixtureConfigurationId =
  optionValue("--fixture=") ||
  resultsDocument.fixtureConfigurationId ||
  "unspecified";
const repetitions = Number(
  optionValue("--repetitions=") || resultsDocument.repetitions || 1,
);
const generatedAt =
  optionValue("--generated-at=") ||
  resultsDocument.generatedAt ||
  new Date().toISOString();

const report = buildWorkloadReport({
  commitSha,
  serverVersion: SERVER_VERSION,
  workload: manifest.workload,
  workloadVersion: manifest.workloadVersion,
  fixtureConfigurationId,
  mode,
  repetitions,
  generatedAt,
  metricProvenance: manifest.metricProvenance,
  results,
});

const jsonOutput = optionValue("--json-out=");
const markdownOutput = optionValue("--markdown-out=");
if (jsonOutput) {
  await writeFile(
    resolve(jsonOutput),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}
if (markdownOutput) {
  await writeFile(
    resolve(markdownOutput),
    renderWorkloadMarkdown(report),
    "utf8",
  );
}
if (!jsonOutput && !markdownOutput) {
  console.log(JSON.stringify(report, null, 2));
}
