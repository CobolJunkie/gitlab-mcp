#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { validateSastReport } from "./lib/sast-report-gate.mjs";

async function main() {
  const reportPath = process.argv[2] ?? "gl-sast-report.json";
  let reportText;
  try {
    reportText = await readFile(reportPath, "utf8");
  } catch {
    throw new Error(`SAST report is required at ${reportPath}.`);
  }

  let report;
  try {
    report = JSON.parse(reportText);
  } catch {
    throw new Error("SAST report must contain valid JSON.");
  }

  const result = validateSastReport(report);
  console.log(`SAST gate passed: ${result.total} vulnerability findings.`);
}

try {
  await main();
} catch (error) {
  console.error(`SAST gate failed: ${error.message}`);
  process.exitCode = 1;
}
