import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateSastReport } from "../scripts/lib/sast-report-gate.mjs";

function report(overrides = {}) {
  return {
    version: "15.2.2",
    vulnerabilities: [],
    scan: {
      type: "sast",
      status: "success",
    },
    ...overrides,
  };
}

test("accepts a successful clean SAST report", () => {
  assert.deepEqual(validateSastReport(report()), { total: 0 });
});

test("rejects SAST reports containing vulnerability findings", () => {
  assert.throws(
    () =>
      validateSastReport(
        report({
          vulnerabilities: [
            {
              id: "synthetic-sast-finding",
              severity: "High",
              location: { file: "server/src/example.mjs", start_line: 1 },
            },
          ],
        }),
      ),
    /contains 1 vulnerability finding/u,
  );
});

test("rejects unsuccessful and malformed SAST reports", () => {
  assert.throws(
    () => validateSastReport(report({ scan: { status: "failure" } })),
    /successful scan/u,
  );
  assert.throws(() => validateSastReport(null), /must be a JSON object/u);
  assert.throws(() => validateSastReport([]), /must be a JSON object/u);
  assert.throws(
    () => validateSastReport({ scan: { status: "success" } }),
    /vulnerabilities array/u,
  );
});

test("SAST gate is blocking wherever Semgrep runs", async () => {
  const pipelineUrl = new URL("../.gitlab-ci.yml", import.meta.url);
  const pipeline = await readFile(pipelineUrl, "utf8");
  const analyzerStart = pipeline.indexOf("semgrep-sast:\n");
  const gateStart = pipeline.indexOf("sast_gate:\n");
  const secretDetectionStart = pipeline.indexOf("secret_detection:\n");

  assert.notEqual(analyzerStart, -1);
  assert.ok(gateStart > analyzerStart);
  assert.ok(secretDetectionStart > gateStart);

  const analyzerBlock = pipeline.slice(analyzerStart, gateStart);
  const gateBlock = pipeline.slice(gateStart, secretDetectionStart);

  for (const rule of [
    '$CI_PIPELINE_SOURCE == "merge_request_event"',
    "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH",
    "$CI_COMMIT_TAG",
    '$CI_PIPELINE_SOURCE == "web" && $CI_COMMIT_REF_PROTECTED == "true" && $TRUSTED_RELEASE_CANDIDATE == "true"',
  ]) {
    assert.ok(analyzerBlock.includes(rule));
    assert.ok(gateBlock.includes(rule));
  }

  assert.match(gateBlock, /job: semgrep-sast\s+artifacts: true/u);
  assert.match(gateBlock, /node scripts\/validate-sast-report\.mjs/u);
  assert.doesNotMatch(gateBlock, /allow_failure:\s*true/u);
});
