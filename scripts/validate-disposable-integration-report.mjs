#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateDisposableIntegrationPrerequisites,
  validateDisposableIntegrationReport,
} from "./lib/disposable-integration-report-gate.mjs";

const rootPath =
  process.env.CI_PROJECT_DIR || fileURLToPath(new URL("../", import.meta.url));
const reportPath = join(rootPath, "integration", "integration-report.json");
const reportRequired =
  process.env.CI === "true" ||
  process.env.GITLAB_INTEGRATION_DISPOSABLE === "true";

async function prepareRun() {
  await rm(reportPath, { force: true });
  const result = validateDisposableIntegrationPrerequisites(process.env);
  console.log(
    result.requested
      ? "Disposable integration preflight passed; prior report evidence was cleared."
      : "Disposable integration preflight cleared prior report evidence; no disposable run was requested.",
  );
}

async function validateReport() {
  if (!reportRequired) {
    console.log(
      "Disposable integration report gate skipped: no disposable integration run was requested.",
    );
    return;
  }

  let reportText;
  try {
    reportText = await readFile(reportPath, "utf8");
  } catch {
    throw new Error(
      `Disposable integration report is required at ${reportPath}.`,
    );
  }

  let report;
  try {
    report = JSON.parse(reportText);
  } catch {
    throw new Error("Disposable integration report must contain valid JSON.");
  }

  const result = validateDisposableIntegrationReport(report, {
    expectedCommitSha: process.env.CI_COMMIT_SHA,
  });
  console.log(
    `Disposable integration report gate passed: ${result.capabilityCount} capability outcome(s), ${result.requiredCapabilityCount} required; ${result.cleanupCount} cleanup outcome(s), ${result.requiredCleanupCount} required.`,
  );
}

try {
  const mode = process.argv[2];
  if (mode === "--prepare") {
    await prepareRun();
  } else if (mode === undefined) {
    await validateReport();
  } else {
    throw new Error(`Unsupported disposable integration gate option: ${mode}.`);
  }
} catch (error) {
  console.error(`Disposable integration report gate failed: ${error.message}`);
  process.exitCode = 1;
}
