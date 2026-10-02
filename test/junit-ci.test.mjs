import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load as loadYaml } from "js-yaml";

const ci = loadYaml(await readFile(".gitlab-ci.yml", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));

function assertBlockingJobConfig(job) {
  assert.ok(job?.allow_failure === undefined || job.allow_failure === false);
  assert.notEqual(job?.when, "manual");
  assert.ok((job?.rules ?? []).every((rule) => rule?.allow_failure !== true));
}

test("Node matrix publishes one-pass JUnit reports without changing npm test", () => {
  assert.equal(pkg.scripts.test, "node --test --test-reporter=spec");

  const ciTest = pkg.scripts["test:ci"];
  assert.equal(
    ciTest,
    [
      "node -e \"require('node:fs').mkdirSync('artifacts/test-results', { recursive: true })\"",
      "&& node --test --test-reporter=spec --test-reporter=junit",
      "--test-reporter-destination=stdout",
      "--test-reporter-destination=artifacts/test-results/junit.xml",
    ].join(" "),
  );

  assert.deepEqual(ci.test?.parallel?.matrix, [
    { NODE_IMAGE: ["node:22-alpine", "node:24-alpine"] },
  ]);
  assert.deepEqual(ci.test?.script, ["npm run test:ci"]);
  assert.equal(ci.test?.extends, ".node-job");
  assert.equal(ci[".node-job"]?.extends, ".node-base");
  assert.equal(ci[".node-base"]?.extends, undefined);
  assertBlockingJobConfig(ci.test);
  assertBlockingJobConfig(ci[".node-job"]);
  assertBlockingJobConfig(ci[".node-base"]);
  assert.equal(ci.test?.artifacts?.when, "always");
  assert.equal(ci.test?.artifacts?.expire_in, "1 week");
  assert.equal(
    ci.test?.artifacts?.reports?.junit,
    "artifacts/test-results/junit.xml",
  );
  assert.equal(ci.test?.artifacts?.paths, undefined);
});

test("coverage remains single-pass and keeps the existing enforced thresholds", () => {
  assert.deepEqual(ci.coverage?.script, ["npm run test:coverage"]);

  const coverage = pkg.scripts["test:coverage"];
  assert.equal((coverage.match(/node --test/gu) ?? []).length, 1);
  assert.match(coverage, /--test-coverage-lines=90/u);
  assert.match(coverage, /--test-coverage-functions=80/u);
  assert.match(coverage, /--test-coverage-branches=75/u);
  assert.match(coverage, /--test-reporter=spec/u);
  assert.match(coverage, /--test-reporter=lcov/u);
  assert.match(coverage, /coverage\/lcov\.info/u);
});
