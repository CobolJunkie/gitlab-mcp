import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import yaml from "js-yaml";

const root = yaml.load(await readFile(".gitlab-ci.yml", "utf8"));
const benchmark = yaml.load(
  await readFile(".gitlab/benchmark-workload.yml", "utf8"),
);

test("root pipeline includes the BENCH-02 protected workload job", () => {
  assert.ok(
    root.include.some(
      (entry) => entry?.local === ".gitlab/benchmark-workload.yml",
    ),
  );
});

test("root workflow permits the protected manual benchmark path", () => {
  const workflowRules = root.workflow.rules.map((rule) => rule.if || "");
  const benchmarkRule = workflowRules.find(
    (rule) => rule.includes("BENCHMARK_WORKLOAD") && rule.includes("web"),
  );
  assert.ok(benchmarkRule);
  assert.match(benchmarkRule, /CI_COMMIT_REF_PROTECTED/);
  assert.doesNotMatch(benchmarkRule, /TRUSTED_RELEASE_CANDIDATE/);
});

test("dedicated benchmark pipelines isolate the measured workload from integration traffic", () => {
  for (const jobName of ["integration", "integration_disposable"]) {
    const [benchmarkExclusion] = root[jobName].rules;
    assert.match(benchmarkExclusion.if, /BENCHMARK_WORKLOAD/);
    assert.equal(benchmarkExclusion.when, "never");
  }
});

test("benchmark and integration jobs serialize access to the disposable fixture", () => {
  const resourceGroup = benchmark.benchmark_workload.resource_group;
  assert.equal(resourceGroup, "gitlab-integration-fixture");
  assert.equal(root.integration.resource_group, resourceGroup);
  assert.equal(root.integration_disposable.resource_group, resourceGroup);
});

test("benchmark job is opt-in and never materializes in merge-request pipelines", () => {
  const job = benchmark.benchmark_workload;
  assert.equal(job.stage, "test");
  assert.equal(job.timeout, "1h");
  assert.equal(job.variables.BENCHMARK_WORKLOAD_MODE, "benchmark");
  assert.equal(job.rules.length, 2);

  const serializedRules = JSON.stringify(job.rules);
  assert.doesNotMatch(serializedRules, /merge_request_event/);
  assert.match(serializedRules, /BENCHMARK_WORKLOAD/);

  const [scheduled, manual] = job.rules.map((rule) => rule.if);
  assert.match(scheduled, /schedule/);
  assert.match(scheduled, /CI_COMMIT_REF_PROTECTED/);
  assert.match(manual, /web/);
  assert.match(manual, /CI_COMMIT_REF_PROTECTED/);
});

test("benchmark job fails closed on disposable prerequisites and persists both report forms", () => {
  const job = benchmark.benchmark_workload;
  const script = job.script.join("\n");
  for (const variable of [
    "GITLAB_INTEGRATION_PROJECT",
    "GITLAB_INTEGRATION_DISPOSABLE_TOKEN",
    "GITLAB_INTEGRATION_DISPOSABLE",
  ]) {
    assert.match(script, new RegExp(variable));
  }
  assert.match(script, /benchmark:workload:live/);
  assert.equal(job.artifacts.when, "always");
  assert.deepEqual(job.artifacts.paths, [
    "benchmark-results/workload-report.json",
    "benchmark-results/workload-report.md",
  ]);
  assert.equal(job.allow_failure, undefined);
});

test("baseline promotion is a protected manual follow-up to the benchmark artifact", () => {
  const job = benchmark.promote_workload_baseline;
  assert.equal(job.stage, "build");
  assert.deepEqual(job.needs, [{ job: "benchmark_workload", artifacts: true }]);
  assert.equal(job.allow_failure, true);
  assert.equal(job.rules.length, 2);
  assert.equal(
    job.rules.every((rule) => rule.when === "manual"),
    true,
  );

  const serializedRules = JSON.stringify(job.rules);
  assert.doesNotMatch(serializedRules, /merge_request_event/);
  assert.match(serializedRules, /BENCHMARK_WORKLOAD/);
  assert.match(serializedRules, /CI_COMMIT_REF_PROTECTED/);
  assert.match(serializedRules, /schedule/);
  assert.match(serializedRules, /web/);

  const script = job.script.join("\n");
  assert.match(script, /apk add --no-cache git/);
  assert.ok(
    script.indexOf("apk add --no-cache git") <
      script.indexOf("benchmark:workload:promote"),
  );
  assert.match(script, /benchmark:workload:promote/);
  assert.match(script, /benchmark-results\/workload-report\.json/);
  assert.match(script, /prettier --write benchmarks\/workload-baseline\.json/);
  assert.ok(
    script.indexOf("benchmark:workload:promote") <
      script.indexOf("prettier --write benchmarks/workload-baseline.json"),
  );
  assert.deepEqual(job.artifacts.paths, ["benchmarks/workload-baseline.json"]);
});
