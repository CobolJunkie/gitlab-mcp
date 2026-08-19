import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load as loadYaml } from "js-yaml";

async function loadCi() {
  return loadYaml(
    await readFile(new URL("../.gitlab-ci.yml", import.meta.url), "utf8"),
  );
}

test("release publication waits for a stage-ordered provenance gate", async () => {
  const ci = await loadCi();
  const releaseGate = ci.release_gate;
  assert.equal(releaseGate?.stage, "release");
  assert.equal(
    releaseGate?.needs,
    undefined,
    "The release gate must keep normal stage ordering and must not use needs.",
  );
  assert.deepEqual(releaseGate?.rules, [{ if: "$CI_COMMIT_TAG" }]);

  const gateScript = (releaseGate?.script ?? []).join("\n");
  assert.match(gateScript, /git fetch --no-tags origin/u);
  assert.match(gateScript, /merge-base --is-ancestor/u);
  assert.match(gateScript, /CI_DEFAULT_BRANCH/u);
  assert.match(gateScript, /CI_COMMIT_SHA/u);

  const releaseNeeds = ci.release_artifacts?.needs ?? [];
  const needsByJob = new Map(releaseNeeds.map((need) => [need.job, need]));
  assert.equal(needsByJob.get("release_gate")?.artifacts, false);
  assert.equal(needsByJob.get("integration_disposable")?.artifacts, false);
  assert.equal(needsByJob.has("pi_adapter"), false);
  assert.equal(needsByJob.has("smoke"), false);
  assert.equal(needsByJob.has("docker_smoke"), false);
});

test("mandatory disposable validation routes materialize before credential evaluation", async () => {
  const ci = await loadCi();
  const integrationDisposable = ci.integration_disposable;
  const rules = integrationDisposable?.rules ?? [];

  assert.deepEqual(rules[0], { if: "$CI_COMMIT_TAG" });
  assert.deepEqual(rules[1], {
    if: '$CI_PIPELINE_SOURCE == "schedule"',
  });

  const trustedWebRule = rules[2]?.if ?? "";
  assert.match(trustedWebRule, /CI_PIPELINE_SOURCE == "web"/u);
  assert.match(trustedWebRule, /CI_COMMIT_REF_PROTECTED == "true"/u);
  assert.match(trustedWebRule, /TRUSTED_RELEASE_CANDIDATE == "true"/u);
  assert.doesNotMatch(trustedWebRule, /GITLAB_INTEGRATION_PROJECT/u);
  assert.doesNotMatch(trustedWebRule, /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/u);
  assert.doesNotMatch(trustedWebRule, /GITLAB_INTEGRATION_DISPOSABLE/u);

  const optionalMainWebRule = rules[3]?.if ?? "";
  assert.match(optionalMainWebRule, /GITLAB_INTEGRATION_PROJECT/u);
  assert.match(optionalMainWebRule, /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/u);
  assert.match(optionalMainWebRule, /GITLAB_INTEGRATION_DISPOSABLE/u);
  assert.match(optionalMainWebRule, /CI_PIPELINE_SOURCE == "web"/u);
  assert.match(optionalMainWebRule, /CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH/u);

  const disposableScript = (integrationDisposable?.script ?? []).join("\n");
  assert.match(disposableScript, /CI_COMMIT_TAG/u);
  assert.match(disposableScript, /GITLAB_INTEGRATION_PROJECT/u);
  assert.match(disposableScript, /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/u);
  assert.match(disposableScript, /GITLAB_INTEGRATION_DISPOSABLE=true/u);
  assert.match(disposableScript, /npm run test:integration:disposable/u);

  const integrationNeed = (ci.release_artifacts?.needs ?? []).find(
    (need) => need.job === "integration_disposable",
  );
  assert.equal(integrationNeed?.artifacts, false);
  assert.equal(
    integrationNeed?.optional,
    undefined,
    "Release publication must not make disposable integration optional.",
  );
});
