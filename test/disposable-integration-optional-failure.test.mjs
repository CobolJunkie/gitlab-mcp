import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_REQUIRED_CAPABILITIES,
  validateDisposableIntegrationReport,
} from "../scripts/lib/disposable-integration-report-gate.mjs";

function passedCapability(name) {
  return { name, status: "passed", required: true };
}

test("rejects a failed optional capability that was actually attempted", () => {
  const report = {
    schemaVersion: 1,
    commitSha: "58df03b7ad138fafe28e22b8a48b9cd9f13081b9",
    runId: "optional-failure-regression",
    completedAt: "2026-08-17T00:00:00.000Z",
    overallStatus: "success",
    capabilities: [
      ...BASE_REQUIRED_CAPABILITIES.map(passedCapability),
      { name: "webhook_event_list", status: "failed", required: false },
    ],
    cleanup: [
      { resource: "issue", cleaned: true },
      { resource: "branch", cleaned: true },
    ],
    flags: {
      mergeRequestCoverage: false,
      artifactCoverage: false,
      optionalCoverageEnabled: false,
    },
  };

  assert.throws(
    () => validateDisposableIntegrationReport(report),
    /attempted capabilities must not fail.*webhook_event_list/u,
  );
});
