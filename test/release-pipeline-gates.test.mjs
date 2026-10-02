import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load as loadYaml } from "js-yaml";

async function loadCi() {
  return loadYaml(
    await readFile(new URL("../.gitlab-ci.yml", import.meta.url), "utf8"),
  );
}

function inheritedJobValue(ci, jobName, propertyName) {
  const job = ci[jobName];
  if (!job) return undefined;
  if (Object.hasOwn(job, propertyName)) return job[propertyName];

  const extendsValue = job.extends;
  const parents = Array.isArray(extendsValue)
    ? extendsValue
    : extendsValue
      ? [extendsValue]
      : [];
  for (const parentName of [...parents].reverse()) {
    const inheritedValue = inheritedJobValue(ci, parentName, propertyName);
    if (inheritedValue !== undefined) return inheritedValue;
  }

  return undefined;
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

test("main validation jobs remain blocking independently of optional deployment", async () => {
  const ci = await loadCi();
  const requiredMainJobs = [
    "formatting",
    "quality",
    "dependency_boundaries",
    "test",
    "coverage",
    "dependency_audit",
    "sast_gate",
    "secret_detection_gate",
    "sonarqube",
    "build",
    "codex_adapter",
    "claude_adapter",
    "cline_adapter",
    "pi_adapter",
    "smoke",
    "docker_smoke",
    "release_validation",
  ];

  for (const jobName of requiredMainJobs) {
    assert.ok(
      ci[jobName],
      `${jobName} must remain in the main validation contract`,
    );
    assert.notEqual(
      inheritedJobValue(ci, jobName, "allow_failure"),
      true,
      `${jobName} must remain blocking when materialized`,
    );

    const rules = inheritedJobValue(ci, jobName, "rules");
    if (rules) {
      const mainRuleIndex = rules.findIndex((rule) =>
        String(rule.if ?? "").includes(
          "CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH",
        ),
      );
      assert.notEqual(
        mainRuleIndex,
        -1,
        `${jobName} must retain a default-branch rule`,
      );
      const mainRule = rules[mainRuleIndex];
      const expectedMainRule =
        jobName === "sonarqube"
          ? "$SONAR_HOST_URL && $SONAR_TOKEN && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH"
          : "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH";
      assert.equal(
        mainRule.if,
        expectedMainRule,
        `${jobName} must match the default branch without extra conditions`,
      );
      const earlierRules = rules.slice(0, mainRuleIndex);
      assert.ok(
        earlierRules.every(
          (rule) => rule.if === '$CI_PIPELINE_SOURCE == "merge_request_event"',
        ),
        `${jobName} must not have a rule that can suppress default-branch materialization`,
      );
      assert.notEqual(
        mainRule.when,
        "never",
        `${jobName} must materialize on the default branch`,
      );
      assert.ok(
        mainRule.when === undefined || mainRule.when === "on_success",
        `${jobName} must run automatically on the default branch`,
      );
      assert.notEqual(
        mainRule.allow_failure,
        true,
        `${jobName} must remain blocking on the default branch`,
      );
    } else {
      assert.ok(
        inheritedJobValue(ci, jobName, "when") === undefined ||
          inheritedJobValue(ci, jobName, "when") === "on_success",
        `${jobName} must run automatically on the default branch`,
      );
    }
  }

  const deploy = ci.deploy_production;
  assert.equal(deploy?.stage, "deploy");
  assert.equal(deploy?.interruptible, false);
  assert.deepEqual(deploy?.environment, { name: "production" });
  assert.deepEqual(deploy?.rules, [
    {
      if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_REF_PROTECTED == "true"',
      when: "manual",
      allow_failure: true,
    },
    { when: "never" },
  ]);

  const deployBeforeScript = (deploy?.before_script ?? []).join("\n");
  assert.match(
    deployBeforeScript,
    /MCP_DEPLOY_PUBLIC_URL_B64URL="\$\(node scripts\/deploy-production\.mjs --encode-public-url "\$MCP_DEPLOY_PUBLIC_URL"\)" && export MCP_DEPLOY_PUBLIC_URL_B64URL/u,
    "CI must preserve a validation failure instead of masking it behind export.",
  );
  assert.doesNotMatch(
    deployBeforeScript,
    /export MCP_DEPLOY_PUBLIC_URL_B64URL="\$\(node/u,
    "The export builtin must not mask the validator command substitution status.",
  );
  assert.doesNotMatch(
    deployBeforeScript,
    /grep -Eq ['"]?\^https:\/\//u,
    "CI must not maintain a second public-URL grammar.",
  );
  assert.match(
    deployBeforeScript,
    /test -n "\$MCP_DEPLOY_VALIDATION_TOKEN"/u,
    "Production deploys must fail closed without a dedicated validation credential.",
  );
  assert.match(
    deployBeforeScript,
    /isSafeReleaseRoot\(process\.argv\[1\]\)/u,
    "The canonical release-root validator must run before the validation credential is transferred.",
  );
  assert.doesNotMatch(
    deployBeforeScript,
    /MCP_DEPLOY_RELEASE_ROOT[^\n]*grep -Eq/u,
    "Release-root validation must not use line-oriented grep before remote shell interpolation.",
  );

  const deployScript = (deploy?.script ?? []).join("\n");
  assert.doesNotMatch(
    deployScript,
    /\\\\\n/u,
    "Deployment shell continuations must use one backslash so BusyBox sh joins physical lines.",
  );
  assert.match(deployScript, /--public-url-base64url/u);
  assert.match(deployScript, /MCP_DEPLOY_PUBLIC_URL_B64URL/u);
  assert.match(deployScript, /--validation-token-file/u);
  assert.match(
    deployScript,
    /printf '%s' "\$MCP_DEPLOY_VALIDATION_TOKEN" \| ssh/u,
    "The validation credential must travel over SSH stdin rather than a command-line argument.",
  );
  assert.match(
    deployScript,
    /validation_token_transfer_started=true/u,
    "Remote token cleanup must be armed before the transfer can strand a credential.",
  );
  assert.match(
    deployScript,
    /trap 'exit 143' TERM/u,
    "Deployment cleanup must run when the CI shell is terminated.",
  );
  assert.match(
    deployScript,
    /cleanup_token\(\).*trap - EXIT HUP INT TERM.*trap cleanup_token EXIT.*trap 'exit 143' TERM/u,
    "Remote transfer cleanup must terminate through the EXIT cleanup path on signals.",
  );
  assert.match(
    deployScript,
    /rm -f '\$validation_token_prefix'\*\.token/u,
    "Cleanup must use the validated job-specific prefix even when the returned remote path is malformed.",
  );
  assert.doesNotMatch(
    deployScript,
    /validation_token_file_valid/u,
    "Cleanup must not depend on accepting the returned remote token path.",
  );
  assert.doesNotMatch(
    deployScript,
    /node[^\n]*MCP_DEPLOY_VALIDATION_TOKEN/u,
    "The validation credential must never appear in the remote deployer command line.",
  );
  assert.doesNotMatch(
    deployScript,
    /'\$MCP_DEPLOY_PUBLIC_URL'/u,
    "The validated URL must not be embedded raw in the remote shell command.",
  );
});

test("mandatory disposable validation routes materialize before credential evaluation", async () => {
  const ci = await loadCi();
  const integrationDisposable = ci.integration_disposable;
  const rules = integrationDisposable?.rules ?? [];

  assert.deepEqual(rules[0], {
    if: '$BENCHMARK_WORKLOAD == "true"',
    when: "never",
  });
  assert.deepEqual(rules[1], { if: "$CI_COMMIT_TAG" });
  assert.deepEqual(rules[2], {
    if: '$CI_PIPELINE_SOURCE == "schedule"',
  });

  const trustedWebRule = rules[3]?.if ?? "";
  assert.match(trustedWebRule, /CI_PIPELINE_SOURCE == "web"/u);
  assert.match(trustedWebRule, /CI_COMMIT_REF_PROTECTED == "true"/u);
  assert.match(trustedWebRule, /TRUSTED_RELEASE_CANDIDATE == "true"/u);
  assert.doesNotMatch(trustedWebRule, /GITLAB_INTEGRATION_PROJECT/u);
  assert.doesNotMatch(trustedWebRule, /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/u);
  assert.doesNotMatch(trustedWebRule, /GITLAB_INTEGRATION_DISPOSABLE/u);

  const optionalMainWebRule = rules[4]?.if ?? "";
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
