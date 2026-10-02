#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { WORKLOAD_MANIFEST } from "../benchmarks/workload-scenarios.mjs";
import { promoteWorkloadBaseline } from "./lib/workload-baseline.mjs";
import { assertPromotionCheckoutProvenance } from "./lib/workload-promotion-checkout.mjs";

const execFileAsync = promisify(execFile);

function optionValue(prefix) {
  return process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" });
  return stdout.trim();
}

const reportPath = optionValue("--report=");
if (!reportPath) {
  throw new Error(
    "Baseline promotion requires --report=<workload-report.json>.",
  );
}
const outputPath = optionValue("--out=") || "benchmarks/workload-baseline.json";

const [report, surfaceBaseline, checkoutCommitSha, trackedChanges] =
  await Promise.all([
    readFile(resolve(reportPath), "utf8").then(JSON.parse),
    readFile(resolve("benchmarks/surface-baseline.json"), "utf8").then(
      JSON.parse,
    ),
    gitOutput(["rev-parse", "HEAD"]),
    gitOutput(["status", "--porcelain=v1", "--untracked-files=no"]),
  ]);
assertPromotionCheckoutProvenance({
  reportCommitSha: report.commitSha,
  checkoutCommitSha,
  trackedChanges,
});
const baseline = promoteWorkloadBaseline({
  report,
  manifest: WORKLOAD_MANIFEST,
  surfaceBaseline,
});
const absoluteOutput = resolve(outputPath);
await mkdir(dirname(absoluteOutput), { recursive: true });
await writeFile(
  absoluteOutput,
  `${JSON.stringify(baseline, null, 2)}\n`,
  "utf8",
);

console.log(
  JSON.stringify(
    {
      baseline: baseline.baseline,
      sourceCommitSha: baseline.promotion.sourceCommitSha,
      surfaceMode: baseline.surface.mode,
      surfaceToolCount: baseline.surface.toolCount,
      surfaceDefinitionFingerprint: baseline.surface.definitionFingerprint,
      output: absoluteOutput,
    },
    null,
    2,
  ),
);
