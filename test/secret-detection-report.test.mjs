import assert from "node:assert/strict";
import test from "node:test";

import {
  MR_100_HISTORY_FINDINGS,
  validateSecretDetectionReport,
} from "../scripts/lib/secret-detection-report-gate.mjs";

function vulnerabilityFrom(finding) {
  return {
    id: finding.id,
    location: {
      file: finding.file,
      commit: { sha: finding.commit },
    },
  };
}

const MR_100_CONTEXT = {
  pipelineSource: "merge_request_event",
  mergeRequestIid: "100",
  projectPath: "CobolJunkie/gitlab-codex-plugin",
};

test("allows the complete reviewed MR !100 historical secret finding set", () => {
  const report = {
    scan: { status: "success" },
    vulnerabilities: MR_100_HISTORY_FINDINGS.map(vulnerabilityFrom),
  };

  const result = validateSecretDetectionReport(report, MR_100_CONTEXT);

  assert.equal(result.total, 6);
  assert.equal(result.allowed, 6);
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.missing, []);
});

test("rejects an incomplete reviewed finding set in MR !100", () => {
  const vulnerabilities = MR_100_HISTORY_FINDINGS.slice(0, -1).map(
    vulnerabilityFrom,
  );
  const report = {
    scan: { status: "success" },
    vulnerabilities,
  };

  const result = validateSecretDetectionReport(report, MR_100_CONTEXT);

  assert.equal(result.allowed, 5);
  assert.deepEqual(result.unexpected, []);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].id, MR_100_HISTORY_FINDINGS.at(-1).id);
});

test("rejects an unreviewed secret finding in MR !100", () => {
  const report = {
    scan: { status: "success" },
    vulnerabilities: [
      vulnerabilityFrom(MR_100_HISTORY_FINDINGS[0]),
      {
        id: "unexpected-finding",
        location: {
          file: "server/src/example.mjs",
          commit: { sha: "deadbeef" },
        },
      },
    ],
  };

  const result = validateSecretDetectionReport(report, MR_100_CONTEXT);

  assert.equal(result.allowed, 1);
  assert.equal(result.unexpected.length, 1);
  assert.equal(result.unexpected[0].id, "unexpected-finding");
  assert.equal(result.missing.length, 5);
});

test("rejects a duplicate reviewed finding in MR !100", () => {
  const known = MR_100_HISTORY_FINDINGS[0];
  const report = {
    scan: { status: "success" },
    vulnerabilities: [vulnerabilityFrom(known), vulnerabilityFrom(known)],
  };

  const result = validateSecretDetectionReport(report, MR_100_CONTEXT);

  assert.equal(result.allowed, 1);
  assert.equal(result.unexpected.length, 1);
  assert.equal(result.unexpected[0].id, known.id);
  assert.equal(result.missing.length, 5);
});

test("rejects a reviewed ID when its historical file changes", () => {
  const known = MR_100_HISTORY_FINDINGS[0];
  const report = {
    scan: { status: "success" },
    vulnerabilities: [
      {
        ...vulnerabilityFrom(known),
        location: {
          file: "server/src/example.mjs",
          commit: { sha: known.commit },
        },
      },
    ],
  };

  const result = validateSecretDetectionReport(report, MR_100_CONTEXT);

  assert.equal(result.allowed, 0);
  assert.equal(result.unexpected.length, 1);
  assert.equal(result.missing.length, 6);
});

test("rejects a reviewed ID when its historical commit changes", () => {
  const known = MR_100_HISTORY_FINDINGS[0];
  const report = {
    scan: { status: "success" },
    vulnerabilities: [
      {
        ...vulnerabilityFrom(known),
        location: {
          file: known.file,
          commit: { sha: "deadbeef" },
        },
      },
    ],
  };

  const result = validateSecretDetectionReport(report, MR_100_CONTEXT);

  assert.equal(result.allowed, 0);
  assert.equal(result.unexpected.length, 1);
  assert.equal(result.missing.length, 6);
});

test("requires a clean report outside MR !100", () => {
  const report = {
    scan: { status: "success" },
    vulnerabilities: [vulnerabilityFrom(MR_100_HISTORY_FINDINGS[0])],
  };

  const result = validateSecretDetectionReport(report, {
    pipelineSource: "merge_request_event",
    mergeRequestIid: "101",
    projectPath: MR_100_CONTEXT.projectPath,
  });

  assert.equal(result.allowed, 0);
  assert.equal(result.unexpected.length, 1);
  assert.deepEqual(result.missing, []);
});

test("MR !100 history exception is scoped to the originating project", () => {
  const report = {
    scan: { status: "success" },
    vulnerabilities: MR_100_HISTORY_FINDINGS.map(vulnerabilityFrom),
  };

  const result = validateSecretDetectionReport(report, {
    ...MR_100_CONTEXT,
    projectPath: "fork/gitlab-mcp",
  });

  assert.equal(result.allowed, 0);
  assert.equal(result.unexpected.length, MR_100_HISTORY_FINDINGS.length);
  assert.deepEqual(result.missing, []);
});

test("rejects unsuccessful secret-detection reports", () => {
  const report = {
    scan: { status: "failure" },
    vulnerabilities: [],
  };

  assert.throws(
    () => validateSecretDetectionReport(report, MR_100_CONTEXT),
    /successful scan/,
  );
});

test("rejects malformed secret-detection reports", () => {
  assert.throws(
    () => validateSecretDetectionReport({}, MR_100_CONTEXT),
    /vulnerabilities array/,
  );
});
