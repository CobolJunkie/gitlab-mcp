import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SUPPORTED_HARNESSES } from "../scripts/lib/supported-harnesses.mjs";

const ROOT = new URL("../", import.meta.url);

const PRODUCT_LEVEL_IDENTITY_DOCS = [
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/README.md",
  "docs/CONFIGURATION.md",
  "docs/DEVELOPER_GUIDE.md",
  "docs/PARITY.md",
  "docs/TROUBLESHOOTING.md",
  "docs/USER_GUIDE.md",
  "docs/github-tool-parity.json",
  "skills/gitlab/references/tool-routing.md",
];

const STALE_GENERIC_PRODUCT_PATTERNS = [
  /\bthis plugin provides\b/i,
  /\bthe plugin supports\b/i,
  /\bthe plugin contains\b/i,
  /\bplugin versions?\b/i,
  /\bplugin workflow uses\b/i,
  /\bpackaged with the plugin\b/i,
  /\bcode can be installed locally in Codex\b/i,
  /\bevery skill and the plugin manifest\b/i,
];

const DEFERRED_TOKEN_WORK_PATTERN = /token (?:optimi[sz]ation|reduction)/i;

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), "utf8");
}

async function assertNoStaleGenericIdentity(relativePath) {
  const content = await read(relativePath);
  for (const pattern of STALE_GENERIC_PRODUCT_PATTERNS) {
    assert.doesNotMatch(
      content,
      pattern,
      `${relativePath} contains stale generic product identity: ${pattern}`,
    );
  }
}

test("GitLab MCP identity and supported harness baseline stay canonical", async () => {
  const [readme, docsIndex, compatibility, audit, changelog, canonicalText] =
    await Promise.all([
      read("README.md"),
      read("docs/README.md"),
      read("docs/COMPATIBILITY.md"),
      read("docs/GENERALISATION_AUDIT.md"),
      read("CHANGELOG.md"),
      read("distribution.json"),
    ]);
  const canonical = JSON.parse(canonicalText);

  assert.match(readme, /^# GitLab MCP$/m);
  assert.doesNotMatch(readme, /^# GitLab for ChatGPT and Codex$/m);
  assert.match(docsIndex, /^# GitLab MCP documentation$/m);
  assert.equal(canonical.name, "gitlab");

  assert.deepEqual(
    SUPPORTED_HARNESSES.map(({ id }) => id),
    ["codex", "claude", "cline", "pi"],
  );

  for (const harness of ["Codex", "Claude Code", "Cline", "Pi"]) {
    const harnessPattern = harness.replace(" ", "\\s+");
    assert.match(compatibility, new RegExp(`\\| ${harnessPattern}`));
    assert.match(audit, new RegExp(harnessPattern));
  }

  assert.match(compatibility, /gitlab-codex-plugin/);
  assert.match(
    audit,
    /Existing Codex users do not need to move configuration paths/,
  );
  assert.match(
    changelog,
    /Completed the product generalisation to \*\*GitLab MCP\*\*/,
  );
});

test("product-level documentation stays harness-neutral by default", async () => {
  await Promise.all(
    PRODUCT_LEVEL_IDENTITY_DOCS.map(assertNoStaleGenericIdentity),
  );

  const [security, parity, parityMapping] = await Promise.all([
    read("SECURITY.md"),
    read("docs/PARITY.md"),
    read("docs/github-tool-parity.json"),
  ]);

  assert.match(security, /GitLab MCP distribution or release artifact/);
  for (const harness of ["Codex", "Claude Code", "Cline", "Pi"]) {
    assert.match(parity, new RegExp(harness.replace(" ", "\\s+")));
  }
  assert.match(parityMapping, /GitLab MCP publish workflow/);
});

test("supported adapters are peers while Codex compatibility stays explicit", async () => {
  const [adapterReadme, adapterContract, adr] = await Promise.all([
    read("adapters/README.md"),
    read("docs/ADAPTERS.md"),
    read("docs/ADR-001-harness-neutral-core.md"),
  ]);

  assert.doesNotMatch(adapterReadme, /codex\/.*reference distribution/i);
  assert.doesNotMatch(
    adapterContract,
    /Codex is the reference implementation/i,
  );
  assert.match(adapterReadme, /All supported adapters are peers/i);
  assert.match(adapterContract, /peer supported distributions/i);
  assert.match(adr, /does not give it product or\s+architectural precedence/i);
});

test("generic integration and release labels stay harness-neutral", async () => {
  const [integrationScript, configuration, pipeline, chatgptDeployment] =
    await Promise.all([
      read("scripts/integration-disposable.mjs"),
      read("docs/CONFIGURATION.md"),
      read(".gitlab-ci.yml"),
      read("docs/CHATGPT_DEPLOYMENT.md"),
    ]);

  assert.match(integrationScript, /mcp\/integration-/);
  assert.doesNotMatch(integrationScript, /codex\/integration-/);
  assert.match(integrationScript, /gitlab-mcp-disposable-integration/);
  assert.match(configuration, /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/);
  assert.match(
    configuration,
    /not a substitute for the\s+protected disposable token/,
  );
  assert.match(pipeline, /name: "gitlab-mcp-\$CI_COMMIT_TAG"/);
  assert.match(pipeline, /gitlab-codex-plugin-\*\.tar\.gz/);
  assert.match(chatgptDeployment, /docker build -t gitlab-mcp \./);
});

test("scheduled integration validation remains materializable", async () => {
  const pipeline = await read(".gitlab-ci.yml");
  const workflowStart = pipeline.indexOf("workflow:\n");
  const workflowEnd = pipeline.indexOf("\nvariables:\n", workflowStart);
  const disposableStart = pipeline.indexOf("integration_disposable:\n");
  const disposableEnd = pipeline.indexOf(
    "\ndependency_audit:\n",
    disposableStart,
  );

  assert.notEqual(workflowStart, -1);
  assert.ok(workflowEnd > workflowStart);
  assert.notEqual(disposableStart, -1);
  assert.ok(disposableEnd > disposableStart);

  const workflowBlock = pipeline.slice(workflowStart, workflowEnd);
  const disposableBlock = pipeline.slice(disposableStart, disposableEnd);
  assert.match(
    workflowBlock,
    /^\s+- if: '\$CI_PIPELINE_SOURCE == "schedule"'$/m,
  );
  assert.match(disposableBlock, /\$CI_PIPELINE_SOURCE == "schedule"/);
});

test("secret detection keeps full path coverage and fails closed", async () => {
  const [pipeline, gateCli, gatePolicy] = await Promise.all([
    read(".gitlab-ci.yml"),
    read("scripts/validate-secret-detection-report.mjs"),
    read("scripts/lib/secret-detection-report-gate.mjs"),
  ]);
  const secretDetectionStart = pipeline.indexOf("secret_detection:\n");
  const gateStart = pipeline.indexOf("secret_detection_gate:\n");
  const nodeBaseStart = pipeline.indexOf("\n.node-base:\n", gateStart);

  assert.notEqual(secretDetectionStart, -1);
  assert.ok(gateStart > secretDetectionStart);
  assert.ok(nodeBaseStart > gateStart);

  const secretDetectionBlock = pipeline.slice(secretDetectionStart, gateStart);
  const gateBlock = pipeline.slice(gateStart, nodeBaseStart);

  assert.match(
    secretDetectionBlock,
    /^\s+- if: '\$CI_PIPELINE_SOURCE == "merge_request_event"'$/m,
  );
  assert.doesNotMatch(pipeline, /SECRET_DETECTION_EXCLUDED_PATHS/);
  assert.match(gateBlock, /job: secret_detection\s+artifacts: true/);
  assert.match(
    gateBlock,
    /node scripts\/validate-secret-detection-report\.mjs/,
  );
  assert.match(gateCli, /\.\/lib\/secret-detection-report-gate\.mjs/);
  assert.match(gatePolicy, /MR_100_HISTORY_FINDINGS/);
  assert.match(gatePolicy, /f1788876283808d875550a44f23b9e163d1fadec/);
  assert.match(gatePolicy, /94a686517c1d1f4f2fc6f4fdfee86c243acd30d6/);
  assert.doesNotMatch(gatePolicy, /ghp_|sk-proj-/);
});

test("observability stays centralized while exporters and token work remain deferred", async () => {
  const [audit, adapters, developerGuide, observability, adr] =
    await Promise.all([
      read("docs/GENERALISATION_AUDIT.md"),
      read("docs/ADAPTERS.md"),
      read("docs/DEVELOPER_GUIDE.md"),
      read("docs/OBSERVABILITY.md"),
      read("docs/ADR-001-harness-neutral-core.md"),
    ]);

  for (const content of [audit, adapters, developerGuide, adr]) {
    assert.match(content, /observability/i);
    assert.match(content, DEFERRED_TOKEN_WORK_PATTERN);
  }

  assert.match(audit, /must not be implemented as private adapter behavior/i);
  assert.match(
    developerGuide,
    /OpenTelemetry SDK\/exporter integration remains follow-up core work/i,
  );
  assert.match(developerGuide, /None of these concerns belong in an adapter/i);
  assert.match(adr, /## OBS-01 follow-up/i);
  assert.match(
    adr,
    /OpenTelemetry SDK\/exporter integration remains follow-up core work/i,
  );
  assert.match(
    observability,
    /does \*\*not\*\*\s+initialize an OpenTelemetry SDK/i,
  );
  assert.match(observability, /OBS-02 should map this stable core contract/i);
});
