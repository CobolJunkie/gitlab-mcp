import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BASE_REQUIRED_CAPABILITIES,
  validateDisposableIntegrationPrerequisites,
  validateDisposableIntegrationReport,
  validateResolvedDisposableIntegrationProject,
} from "../scripts/lib/disposable-integration-report-gate.mjs";

const COMMIT_SHA = "58df03b7ad138fafe28e22b8a48b9cd9f13081b9";
const VALIDATOR_PATH = fileURLToPath(
  new URL(
    "../scripts/validate-disposable-integration-report.mjs",
    import.meta.url,
  ),
);

function passedCapability(name) {
  return { name, status: "passed", required: true };
}

function validReport(overrides = {}) {
  return {
    schemaVersion: 1,
    commitSha: COMMIT_SHA,
    runId: "integration-test",
    completedAt: "2026-08-17T00:00:00.000Z",
    overallStatus: "success",
    capabilities: BASE_REQUIRED_CAPABILITIES.map(passedCapability),
    cleanup: [
      { resource: "issue", cleaned: true },
      { resource: "branch", cleaned: true },
    ],
    flags: {
      mergeRequestCoverage: false,
      artifactCoverage: false,
      optionalCoverageEnabled: false,
    },
    ...overrides,
  };
}

test("accepts a finalized successful report with required evidence and cleanup", () => {
  assert.deepEqual(
    validateDisposableIntegrationReport(validReport(), {
      expectedCommitSha: COMMIT_SHA,
    }),
    {
      capabilityCount: BASE_REQUIRED_CAPABILITIES.length,
      requiredCapabilityCount: BASE_REQUIRED_CAPABILITIES.length,
      cleanupCount: 2,
      requiredCleanupCount: 2,
    },
  );
});

test("accepts optional non-required capability evidence", () => {
  const report = validReport({
    capabilities: [
      ...BASE_REQUIRED_CAPABILITIES.map(passedCapability),
      { name: "optional_probe", status: "skipped" },
    ],
  });

  const result = validateDisposableIntegrationReport(report);
  assert.equal(result.capabilityCount, BASE_REQUIRED_CAPABILITIES.length + 1);
});

test("requires merge-request evidence and cleanup when that coverage ran", () => {
  const mergeRequestCapabilities = [
    "create_merge_request",
    "update_merge_request",
    "create_merge_request_discussion",
  ];
  const report = validReport({
    flags: {
      mergeRequestCoverage: true,
      artifactCoverage: false,
      optionalCoverageEnabled: true,
    },
    capabilities: [
      ...BASE_REQUIRED_CAPABILITIES.map(passedCapability),
      ...mergeRequestCapabilities.map(passedCapability),
    ],
    cleanup: [
      { resource: "issue", cleaned: true },
      { resource: "branch", cleaned: true },
      { resource: "merge_request", cleaned: true },
    ],
  });

  assert.deepEqual(validateDisposableIntegrationReport(report), {
    capabilityCount:
      BASE_REQUIRED_CAPABILITIES.length + mergeRequestCapabilities.length,
    requiredCapabilityCount:
      BASE_REQUIRED_CAPABILITIES.length + mergeRequestCapabilities.length,
    cleanupCount: 3,
    requiredCleanupCount: 3,
  });
});

test("requires artifact evidence when artifact coverage ran", () => {
  const artifactCapabilities = ["get_job", "get_job_artifact_archive"];
  const report = validReport({
    flags: {
      mergeRequestCoverage: false,
      artifactCoverage: true,
      optionalCoverageEnabled: true,
    },
    capabilities: [
      ...BASE_REQUIRED_CAPABILITIES.map(passedCapability),
      ...artifactCapabilities.map(passedCapability),
    ],
  });

  const result = validateDisposableIntegrationReport(report);
  assert.equal(
    result.requiredCapabilityCount,
    BASE_REQUIRED_CAPABILITIES.length + artifactCapabilities.length,
  );
});

test("rejects missing, failed, optional, and duplicate required capabilities", () => {
  const missing = BASE_REQUIRED_CAPABILITIES[0];
  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({
          capabilities:
            BASE_REQUIRED_CAPABILITIES.slice(1).map(passedCapability),
        }),
      ),
    new RegExp(`required capabilities.*${missing}`, "u"),
  );

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({
          capabilities: BASE_REQUIRED_CAPABILITIES.map((name) =>
            name === missing
              ? { name, status: "failed", required: true }
              : passedCapability(name),
          ),
        }),
      ),
    new RegExp(`required capabilities.*${missing}`, "u"),
  );

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({
          capabilities: BASE_REQUIRED_CAPABILITIES.map((name) =>
            name === missing
              ? { name, status: "passed", required: false }
              : passedCapability(name),
          ),
        }),
      ),
    new RegExp(`required capabilities.*${missing}`, "u"),
  );

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({
          capabilities: [
            ...BASE_REQUIRED_CAPABILITIES.map(passedCapability),
            passedCapability(missing),
          ],
        }),
      ),
    /duplicate entry/u,
  );
});

test("rejects malformed capability evidence", () => {
  for (const capabilities of [null, [null], [[]]]) {
    assert.throws(
      () => validateDisposableIntegrationReport(validReport({ capabilities })),
      /capabilit/u,
    );
  }

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({ capabilities: [{ name: " ", status: "passed" }] }),
      ),
    /capability name is required/u,
  );

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({ capabilities: [{ name: "probe", status: "unknown" }] }),
      ),
    /invalid status/u,
  );

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({
          capabilities: [{ name: "probe", status: "passed", required: "yes" }],
        }),
      ),
    /required marker must be boolean/u,
  );
});

test("rejects any additional capability marked required unless it passed", () => {
  const report = validReport({
    capabilities: [
      ...BASE_REQUIRED_CAPABILITIES.map(passedCapability),
      { name: "future_required_probe", status: "failed", required: true },
    ],
  });

  assert.throws(
    () => validateDisposableIntegrationReport(report),
    /required capabilities.*future_required_probe/u,
  );
});

test("rejects malformed coverage flags and inconsistent optional coverage", () => {
  for (const flags of [null, []]) {
    assert.throws(
      () => validateDisposableIntegrationReport(validReport({ flags })),
      /flags must be an object/u,
    );
  }

  assert.throws(
    () => validateDisposableIntegrationReport(validReport({ flags: {} })),
    /flag mergeRequestCoverage must be boolean/u,
  );

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({
          flags: {
            mergeRequestCoverage: true,
            artifactCoverage: false,
            optionalCoverageEnabled: false,
          },
        }),
      ),
    /optionalCoverageEnabled must be true/u,
  );
});

test("rejects a report produced for a different commit", () => {
  assert.throws(
    () =>
      validateDisposableIntegrationReport(validReport(), {
        expectedCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    /commit must match the pipeline head/u,
  );
});

test("rejects an otherwise successful report when cleanup failed", () => {
  const report = validReport({
    cleanup: [
      { resource: "issue", cleaned: true },
      { resource: "branch", cleaned: false },
    ],
  });

  assert.throws(
    () => validateDisposableIntegrationReport(report),
    /cleanup must succeed.*branch/u,
  );
});

test("rejects failed cleanup for additional created resources", () => {
  const report = validReport({
    cleanup: [
      { resource: "issue", cleaned: true },
      { resource: "branch", cleaned: true },
      { resource: "optional_resource", cleaned: false },
    ],
  });

  assert.throws(
    () => validateDisposableIntegrationReport(report),
    /cleanup must succeed.*optional_resource/u,
  );
});

test("rejects missing cleanup evidence for mandatory resources", () => {
  const report = validReport({
    cleanup: [{ resource: "issue", cleaned: true }],
  });

  assert.throws(
    () => validateDisposableIntegrationReport(report),
    /cleanup must succeed.*branch/u,
  );
});

test("rejects malformed cleanup evidence", () => {
  for (const cleanup of [null, [null], [[]]]) {
    assert.throws(
      () => validateDisposableIntegrationReport(validReport({ cleanup })),
      /cleanup/u,
    );
  }

  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({ cleanup: [{ resource: " ", cleaned: true }] }),
      ),
    /cleanup resource is required/u,
  );
});

test("rejects failed, incomplete, malformed, and duplicate reports", () => {
  assert.throws(
    () =>
      validateDisposableIntegrationReport(validReport({ schemaVersion: 2 })),
    /schemaVersion must be 1/u,
  );
  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({ overallStatus: "failure" }),
      ),
    /status must be success/u,
  );
  assert.throws(
    () =>
      validateDisposableIntegrationReport(validReport({ completedAt: null })),
    /must be finalized/u,
  );
  assert.throws(
    () => validateDisposableIntegrationReport(null),
    /must be a JSON object/u,
  );
  assert.throws(
    () => validateDisposableIntegrationReport([]),
    /must be a JSON object/u,
  );
  assert.throws(
    () =>
      validateDisposableIntegrationReport(
        validReport({
          cleanup: [
            { resource: "issue", cleaned: true },
            { resource: "issue", cleaned: true },
            { resource: "branch", cleaned: true },
          ],
        }),
      ),
    /duplicate resource issue/u,
  );
});

test("explicit disposable requests fail closed when prerequisites are missing", () => {
  assert.deepEqual(validateDisposableIntegrationPrerequisites({}), {
    requested: false,
  });

  assert.throws(
    () =>
      validateDisposableIntegrationPrerequisites({
        GITLAB_INTEGRATION_DISPOSABLE: "true",
        GITLAB_INTEGRATION_PROJECT: "group/disposable",
      }),
    /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/u,
  );

  assert.throws(
    () =>
      validateDisposableIntegrationPrerequisites({
        GITLAB_INTEGRATION_DISPOSABLE: "true",
        GITLAB_INTEGRATION_DISPOSABLE_TOKEN: "token",
      }),
    /GITLAB_INTEGRATION_PROJECT/u,
  );

  assert.deepEqual(
    validateDisposableIntegrationPrerequisites({
      GITLAB_INTEGRATION_DISPOSABLE: "true",
      GITLAB_INTEGRATION_PROJECT: "group/disposable",
      GITLAB_INTEGRATION_DISPOSABLE_TOKEN: "token",
    }),
    { requested: true },
  );
});

test("explicit disposable requests reject the current CI project", () => {
  const baseEnvironment = {
    GITLAB_INTEGRATION_DISPOSABLE: "true",
    GITLAB_INTEGRATION_DISPOSABLE_TOKEN: "token",
  };

  assert.throws(
    () =>
      validateDisposableIntegrationPrerequisites({
        ...baseEnvironment,
        GITLAB_INTEGRATION_PROJECT: "group/project",
        CI_PROJECT_PATH: "group/project",
        CI_PROJECT_ID: "12",
      }),
    /must be separate from the current CI project/u,
  );

  assert.throws(
    () =>
      validateDisposableIntegrationPrerequisites({
        ...baseEnvironment,
        GITLAB_INTEGRATION_PROJECT: "12",
        CI_PROJECT_PATH: "group/project",
        CI_PROJECT_ID: "12",
      }),
    /must be separate from the current CI project/u,
  );
});

test("resolved disposable projects reject aliases of the current CI project", () => {
  const currentEnvironment = {
    CI_PROJECT_PATH: "group/project",
    CI_PROJECT_ID: "12",
  };

  for (const projectInfo of [null, [], "group/project"]) {
    assert.throws(
      () =>
        validateResolvedDisposableIntegrationProject(
          projectInfo,
          currentEnvironment,
        ),
      /must be an object/u,
    );
  }

  assert.throws(
    () =>
      validateResolvedDisposableIntegrationProject(
        { id: 12, path_with_namespace: "group/project" },
        currentEnvironment,
      ),
    /must be separate from the current CI project/u,
  );

  assert.throws(
    () =>
      validateResolvedDisposableIntegrationProject(
        { id: 12, path_with_namespace: "renamed/project" },
        currentEnvironment,
      ),
    /must be separate from the current CI project/u,
  );

  assert.throws(
    () =>
      validateResolvedDisposableIntegrationProject(
        { path_with_namespace: "group/project" },
        currentEnvironment,
      ),
    /must be separate from the current CI project/u,
  );

  assert.deepEqual(
    validateResolvedDisposableIntegrationProject(
      { id: 99, path_with_namespace: "group/disposable" },
      currentEnvironment,
    ),
    { projectId: "99", projectPath: "group/disposable" },
  );

  assert.deepEqual(
    validateResolvedDisposableIntegrationProject(
      { id: 99, path_with_namespace: null },
      currentEnvironment,
    ),
    { projectId: "99", projectPath: "" },
  );
});

test("preflight removes stale evidence before rejecting a misconfigured requested run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gitlab-mcp-disposable-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const reportDirectory = join(root, "integration");
  const reportPath = join(reportDirectory, "integration-report.json");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(validReport())}\n`, "utf8");

  const result = spawnSync(process.execPath, [VALIDATOR_PATH, "--prepare"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "",
      CI_PROJECT_DIR: root,
      GITLAB_INTEGRATION_DISPOSABLE: "true",
      GITLAB_INTEGRATION_PROJECT: "group/disposable",
      GITLAB_INTEGRATION_DISPOSABLE_TOKEN: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /GITLAB_INTEGRATION_DISPOSABLE_TOKEN/u);
  await assert.rejects(access(reportPath), (error) => error?.code === "ENOENT");
});
