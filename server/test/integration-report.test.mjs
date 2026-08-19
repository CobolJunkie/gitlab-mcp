import assert from "node:assert/strict";
import test from "node:test";

import {
  createReport,
  addCapability,
  addCleanup,
  finalizeReport,
  sanitizeError,
  trackedCall,
  reportByteLength,
  serializeReport,
} from "../../scripts/integration-report.mjs";

test("createReport produces a valid initial report", () => {
  const report = createReport({ runId: "test-run-1", commitSha: "abc123" });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runId, "test-run-1");
  assert.equal(report.commitSha, "abc123");
  assert.equal(report.overallStatus, "incomplete");
  assert.equal(report.completedAt, null);
  assert.equal(report.capabilities.length, 0);
  assert.equal(report.cleanup.length, 0);
  assert.equal(report.flags.mergeRequestCoverage, false);
  assert.equal(report.flags.artifactCoverage, false);
  assert.equal(report.flags.optionalCoverageEnabled, false);
});

test("createReport omits commitSha when not provided", () => {
  const report = createReport({ runId: "test-run-2" });
  assert.equal(report.commitSha, undefined);
});

test("addCapability records a passed capability", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "get_current_user", "passed", {
    category: "identity",
    required: true,
  });
  assert.equal(report.capabilities.length, 1);
  assert.equal(report.capabilities[0].name, "get_current_user");
  assert.equal(report.capabilities[0].status, "passed");
  assert.equal(report.capabilities[0].category, "identity");
  assert.equal(report.capabilities[0].required, true);
  assert.equal(report.capabilities[0].reason, undefined);
});

test("addCapability records a skipped capability with reason", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "merge_request_mutation", "skipped", {
    reason: "Feature not enabled",
    category: "merge_request_mutation",
    required: false,
  });
  assert.equal(report.capabilities[0].status, "skipped");
  assert.equal(report.capabilities[0].reason, "Feature not enabled");
  assert.equal(report.capabilities[0].required, false);
});

test("addCapability records an unsupported capability", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "pipeline_schedules", "unsupported", {
    reason: "Tier-gated: requires GitLab Premium",
    category: "tier_gated",
    required: false,
  });
  assert.equal(report.capabilities[0].status, "unsupported");
  assert.equal(report.capabilities[0].category, "tier_gated");
});

test("addCapability records a failed capability", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "create_issue", "failed", {
    reason: "API returned 403",
    category: "issue_mutation",
    required: true,
  });
  assert.equal(report.capabilities[0].status, "failed");
  assert.equal(report.capabilities[0].reason, "API returned 403");
});

test("addCleanup records successful cleanup", () => {
  const report = createReport({ runId: "test" });
  addCleanup(report, "issue", true);
  assert.equal(report.cleanup.length, 1);
  assert.equal(report.cleanup[0].resource, "issue");
  assert.equal(report.cleanup[0].cleaned, true);
  assert.equal(report.cleanup[0].error, undefined);
});

test("addCleanup records failed cleanup with sanitized error", () => {
  const report = createReport({ runId: "test" });
  addCleanup(report, "branch", false, "Failed to delete: 403 Forbidden");
  assert.equal(report.cleanup[0].cleaned, false);
  assert.equal(report.cleanup[0].error, "Failed to delete: 403 Forbidden");
});

test("finalizeReport sets completedAt and overallStatus", () => {
  const report = createReport({ runId: "test" });
  assert.equal(report.overallStatus, "incomplete");
  finalizeReport(report, "success");
  assert.equal(report.overallStatus, "success");
  assert.ok(report.completedAt);
  assert.ok(typeof report.completedAt === "string");
  assert.ok(report.completedAt.endsWith("Z"));
});

test("finalizeReport can set failure status", () => {
  const report = createReport({ runId: "test" });
  finalizeReport(report, "failure");
  assert.equal(report.overallStatus, "failure");
});

test("sanitizeError redacts bearer tokens", () => {
  const result = sanitizeError(
    "Authorization: Bearer super-secret-token-value-here-1234",
  );
  assert.doesNotMatch(result, /super-secret/);
  assert.match(result, /Bearer \[REDACTED\]/);
});

test("sanitizeError redacts glpat tokens", () => {
  const result = sanitizeError(
    "Failed with glpat-abcdefghij1234567890abcdefghij",
  );
  assert.doesNotMatch(result, /glpat-abcdefghij/);
  assert.match(result, /\[REDACTED\]/);
});

test("sanitizeError redacts long hex strings", () => {
  const result = sanitizeError(
    "Error at sha aabbccddeeff00112233445566778899aabbccdd",
  );
  assert.doesNotMatch(result, /aabbccddeeff00112233445566778899aabbccdd/);
});

test("sanitizeError truncates long messages to 512 chars", () => {
  const long = "x".repeat(1000);
  const result = sanitizeError(long);
  assert.ok(result.length <= 512);
});

test("sanitizeError handles non-string input", () => {
  assert.equal(sanitizeError(null), "unknown error");
  assert.equal(sanitizeError(undefined), "unknown error");
  assert.equal(sanitizeError(42), "unknown error");
});

test("sanitizeError passes short strings through unchanged", () => {
  const result = sanitizeError("Simple error message");
  assert.equal(result, "Simple error message");
});

test("reportByteLength returns a positive number", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "get_current_user", "passed");
  const len = reportByteLength(report);
  assert.ok(len > 0);
});

test("serializeReport produces valid JSON", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "get_current_user", "passed");
  addCleanup(report, "issue", true);
  finalizeReport(report, "success");
  const json = serializeReport(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.runId, "test");
  assert.equal(parsed.overallStatus, "success");
  assert.equal(parsed.capabilities.length, 1);
  assert.equal(parsed.cleanup.length, 1);
});

test("serializeReport truncates oversized reports", () => {
  const report = createReport({ runId: "test" });
  // Add many capabilities to exceed 64KB
  for (let i = 0; i < 2000; i++) {
    addCapability(report, `capability_${i}_` + "x".repeat(100), "passed", {
      reason: "y".repeat(200),
      category: "test",
      required: true,
    });
  }
  const json = serializeReport(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(parsed.capabilityCount > 0);
});

test("serializeReport does not include sensitive data in normal output", () => {
  const report = createReport({ runId: "test" });
  addCleanup(report, "branch", false, "Bearer super-secret-token-abc123def456");
  const json = serializeReport(report);
  assert.doesNotMatch(json, /super-secret/);
});

test("multiple capabilities accumulate in order", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "first", "passed");
  addCapability(report, "second", "skipped", { reason: "not configured" });
  addCapability(report, "third", "failed", { reason: "error" });
  addCapability(report, "fourth", "unsupported", { reason: "tier-gated" });
  assert.equal(report.capabilities.length, 4);
  assert.equal(report.capabilities[0].status, "passed");
  assert.equal(report.capabilities[1].status, "skipped");
  assert.equal(report.capabilities[2].status, "failed");
  assert.equal(report.capabilities[3].status, "unsupported");
});

test("multiple cleanup entries accumulate", () => {
  const report = createReport({ runId: "test" });
  addCleanup(report, "merge_request", true);
  addCleanup(report, "issue", false, "timed out");
  addCleanup(report, "branch", true);
  assert.equal(report.cleanup.length, 3);
  assert.equal(report.cleanup[0].cleaned, true);
  assert.equal(report.cleanup[1].cleaned, false);
  assert.equal(report.cleanup[2].cleaned, true);
});

test("flags are set correctly in serialized output", () => {
  const report = createReport({ runId: "test" });
  report.flags.mergeRequestCoverage = true;
  report.flags.artifactCoverage = true;
  report.flags.optionalCoverageEnabled = true;
  finalizeReport(report, "success");
  const json = serializeReport(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.flags.mergeRequestCoverage, true);
  assert.equal(parsed.flags.artifactCoverage, true);
  assert.equal(parsed.flags.optionalCoverageEnabled, true);
});

// ── trackedCall regression tests ───────────────────────────────────────

test("trackedCall returns the result of fn on success", async () => {
  const report = createReport({ runId: "test" });
  const result = await trackedCall(report, "echo", () => Promise.resolve(42), {
    category: "unit",
    required: true,
  });
  assert.equal(result, 42);
  assert.equal(report.capabilities.length, 1);
  assert.equal(report.capabilities[0].name, "echo");
  assert.equal(report.capabilities[0].status, "passed");
  assert.equal(report.capabilities[0].category, "unit");
  assert.equal(report.capabilities[0].required, true);
});

test("trackedCall returns complex objects from fn", async () => {
  const report = createReport({ runId: "test" });
  const obj = { default_branch: "main", id: 123 };
  const result = await trackedCall(report, "get_project", () =>
    Promise.resolve(obj),
  );
  assert.deepEqual(result, obj);
  assert.equal(result.default_branch, "main");
});

test("trackedCall records failure and rethrows on fn error", async () => {
  const report = createReport({ runId: "test" });
  await assert.rejects(
    () =>
      trackedCall(report, "failing", () => Promise.reject(new Error("boom")), {
        category: "test",
        required: true,
      }),
    { message: "boom" },
  );
  assert.equal(report.capabilities.length, 1);
  assert.equal(report.capabilities[0].name, "failing");
  assert.equal(report.capabilities[0].status, "failed");
  assert.equal(report.capabilities[0].reason, "boom");
  assert.equal(report.capabilities[0].category, "test");
});

test("trackedCall sanitizes failure reason containing secrets", async () => {
  const report = createReport({ runId: "test" });
  const secretError =
    "Authorization failed: Bearer sk-test-abcdef1234567890abcdef and glpat-xyzABCdef1234567890abcd";
  await assert.rejects(() =>
    trackedCall(report, "auth", () => Promise.reject(new Error(secretError))),
  );
  const reason = report.capabilities[0].reason;
  assert.doesNotMatch(reason, /sk-test-abcdef1234567890abcdef/);
  assert.doesNotMatch(reason, /glpat-xyzABCdef1234567890abcd/);
  assert.match(reason, /Bearer \[REDACTED\]/);
  assert.match(reason, /\[REDACTED\]/);
});

// ── addCapability sanitization regression tests ────────────────────────

test("addCapability sanitizes reason with bearer token", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "api_call", "failed", {
    reason: "Access denied: Bearer secret-token-value-abcdef123456",
  });
  const reason = report.capabilities[0].reason;
  assert.doesNotMatch(reason, /secret-token-value/);
  assert.match(reason, /Bearer \[REDACTED\]/);
});

test("addCapability sanitizes reason with glpat token", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "api_call", "failed", {
    reason: "Request rejected glpat-abcdefghij1234567890abcdefghij is invalid",
  });
  const reason = report.capabilities[0].reason;
  assert.doesNotMatch(reason, /glpat-abcdefghij/);
  assert.match(reason, /\[REDACTED\]/);
});

test("addCapability sanitizes reason with long hex secret", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "api_call", "failed", {
    reason:
      "Token validation failed for aabbccddeeff00112233445566778899aabbccdd",
  });
  const reason = report.capabilities[0].reason;
  assert.doesNotMatch(reason, /aabbccddeeff00112233445566778899aabbccdd/);
});

test("serialized report with failed capability reasons excludes secrets", () => {
  const report = createReport({ runId: "test" });
  addCapability(report, "get_project", "passed", { category: "project_read" });
  addCapability(report, "create_issue", "failed", {
    reason:
      "401 Unauthorized: Bearer real-secret-token-1234567890abcdef and glpat-realtoken1234567890abcdef",
    category: "issue_mutation",
    required: true,
  });
  finalizeReport(report, "failure");
  const json = serializeReport(report);
  assert.doesNotMatch(json, /real-secret-token/);
  assert.doesNotMatch(json, /glpat-realtoken/);
  const parsed = JSON.parse(json);
  assert.equal(parsed.overallStatus, "failure");
  assert.equal(parsed.capabilities.length, 2);
  assert.match(parsed.capabilities[1].reason, /Bearer \[REDACTED\]/);
  assert.match(parsed.capabilities[1].reason, /\[REDACTED\]/);
});
