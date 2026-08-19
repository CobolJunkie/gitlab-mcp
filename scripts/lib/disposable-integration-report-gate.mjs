const BASE_REQUIRED_CLEANUP_RESOURCES = Object.freeze(["issue", "branch"]);

export const BASE_REQUIRED_CAPABILITIES = Object.freeze([
  "get_gitlab_capabilities",
  "get_project",
  "list_repository_tree",
  "get_file",
  "get_blob",
  "create_issue",
  "update_issue",
  "create_issue_note",
  "create_branch",
  "create_commit",
  "get_file (fixture for destructive cleanup)",
  "create_destructive_commit",
  "list_issues",
  "list_pipelines",
  "list_project_jobs",
]);

const MERGE_REQUEST_REQUIRED_CAPABILITIES = Object.freeze([
  "create_merge_request",
  "update_merge_request",
  "create_merge_request_discussion",
]);
const ARTIFACT_REQUIRED_CAPABILITIES = Object.freeze([
  "get_job",
  "get_job_artifact_archive",
]);
const VALID_CAPABILITY_STATUSES = new Set([
  "passed",
  "skipped",
  "failed",
  "unsupported",
]);
const COVERAGE_FLAGS = Object.freeze([
  "mergeRequestCoverage",
  "artifactCoverage",
  "optionalCoverageEnabled",
]);

function hasNonEmptyValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function authoritativeProjectId(value) {
  if (typeof value !== "number" && typeof value !== "string") return "";

  const candidate = typeof value === "string" ? value.trim() : String(value);
  if (!candidate) return "";

  const numericId = Number(candidate);
  return Number.isSafeInteger(numericId) &&
    numericId > 0 &&
    String(numericId) === candidate
    ? candidate
    : "";
}

function targetsCurrentCiProject(environment, project) {
  return [environment.CI_PROJECT_PATH, environment.CI_PROJECT_ID]
    .filter(hasNonEmptyValue)
    .some((value) => value.trim() === project);
}

export function validateDisposableIntegrationPrerequisites(environment = {}) {
  if (environment.GITLAB_INTEGRATION_DISPOSABLE !== "true") {
    return Object.freeze({ requested: false });
  }

  const missing = [];
  if (!hasNonEmptyValue(environment.GITLAB_INTEGRATION_PROJECT)) {
    missing.push("GITLAB_INTEGRATION_PROJECT");
  }
  if (!hasNonEmptyValue(environment.GITLAB_INTEGRATION_DISPOSABLE_TOKEN)) {
    missing.push("GITLAB_INTEGRATION_DISPOSABLE_TOKEN");
  }

  if (missing.length > 0) {
    throw new Error(
      `Disposable integration was explicitly requested but required configuration is missing: ${missing.join(", ")}.`,
    );
  }

  const project = environment.GITLAB_INTEGRATION_PROJECT.trim();
  if (targetsCurrentCiProject(environment, project)) {
    throw new Error(
      "Disposable integration project must be separate from the current CI project.",
    );
  }

  return Object.freeze({ requested: true });
}

export function validateResolvedDisposableIntegrationProject(
  projectInfo,
  environment = {},
) {
  if (
    !projectInfo ||
    typeof projectInfo !== "object" ||
    Array.isArray(projectInfo)
  ) {
    throw new TypeError(
      "Resolved disposable integration project must be an object.",
    );
  }

  const resolvedProjectId = authoritativeProjectId(projectInfo.id);
  const resolvedProjectPath = hasNonEmptyValue(projectInfo.path_with_namespace)
    ? projectInfo.path_with_namespace.trim()
    : "";
  const currentProjectId = hasNonEmptyValue(environment.CI_PROJECT_ID)
    ? environment.CI_PROJECT_ID.trim()
    : "";
  const currentProjectPath = hasNonEmptyValue(environment.CI_PROJECT_PATH)
    ? environment.CI_PROJECT_PATH.trim()
    : "";

  if (
    (currentProjectId && resolvedProjectId === currentProjectId) ||
    (currentProjectPath && resolvedProjectPath === currentProjectPath)
  ) {
    throw new Error(
      "Resolved disposable integration project must be separate from the current CI project.",
    );
  }

  if (!resolvedProjectId) {
    throw new Error(
      "Resolved disposable integration project must include an authoritative project ID.",
    );
  }

  return Object.freeze({
    projectId: resolvedProjectId,
    projectPath: resolvedProjectPath,
  });
}

function assertReportObject(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TypeError("Disposable integration report must be a JSON object.");
  }
}

function assertSuccessfulFinalizedReport(report) {
  if (report.schemaVersion !== 1) {
    throw new Error("Disposable integration report schemaVersion must be 1.");
  }
  if (report.overallStatus !== "success") {
    throw new Error(
      `Disposable integration report status must be success, got ${String(report.overallStatus)}.`,
    );
  }
  if (typeof report.completedAt !== "string" || !report.completedAt.trim()) {
    throw new Error("Disposable integration report must be finalized.");
  }
}

function assertExpectedCommit(report, expectedCommitSha) {
  const expected =
    typeof expectedCommitSha === "string" ? expectedCommitSha.trim() : "";
  if (expected && report.commitSha !== expected) {
    throw new Error(
      `Disposable integration report commit must match the pipeline head ${expected}.`,
    );
  }
}

function validateCoverageFlags(flags) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    throw new TypeError(
      "Disposable integration report flags must be an object.",
    );
  }

  for (const flag of COVERAGE_FLAGS) {
    if (typeof flags[flag] !== "boolean") {
      throw new TypeError(
        `Disposable integration report flag ${flag} must be boolean.`,
      );
    }
  }

  if (
    (flags.mergeRequestCoverage || flags.artifactCoverage) &&
    !flags.optionalCoverageEnabled
  ) {
    throw new Error(
      "Disposable integration optionalCoverageEnabled must be true when optional coverage ran.",
    );
  }

  return flags;
}

function capabilityName(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(
      "Disposable integration capability entries must be objects.",
    );
  }

  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) {
    throw new Error("Disposable integration capability name is required.");
  }
  if (!VALID_CAPABILITY_STATUSES.has(entry.status)) {
    throw new Error(
      `Disposable integration capability ${name} has invalid status ${String(entry.status)}.`,
    );
  }
  if (entry.required !== undefined && typeof entry.required !== "boolean") {
    throw new TypeError(
      `Disposable integration capability ${name} required marker must be boolean.`,
    );
  }
  return name;
}

function indexCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    throw new TypeError(
      "Disposable integration report capabilities must be an array.",
    );
  }

  const capabilitiesByName = new Map();
  for (const entry of capabilities) {
    const name = capabilityName(entry);
    if (capabilitiesByName.has(name)) {
      throw new Error(
        `Disposable integration capabilities contain duplicate entry ${name}.`,
      );
    }
    capabilitiesByName.set(name, entry);
  }
  return capabilitiesByName;
}

function requiredCapabilityNames(flags) {
  const names = [...BASE_REQUIRED_CAPABILITIES];
  if (flags.mergeRequestCoverage) {
    names.push(...MERGE_REQUEST_REQUIRED_CAPABILITIES);
  }
  if (flags.artifactCoverage) {
    names.push(...ARTIFACT_REQUIRED_CAPABILITIES);
  }
  return names;
}

function assertRequiredCapabilitiesPassed(capabilitiesByName, requiredNames) {
  const failures = [];

  for (const name of requiredNames) {
    const entry = capabilitiesByName.get(name);
    if (entry?.required !== true || entry?.status !== "passed") {
      failures.push(name);
    }
  }

  for (const [name, entry] of capabilitiesByName) {
    if (
      entry.required === true &&
      entry.status !== "passed" &&
      !failures.includes(name)
    ) {
      failures.push(name);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Disposable integration required capabilities must be present, required, and passed: ${failures.join(", ")}.`,
    );
  }
}

function assertNoFailedCapabilities(capabilitiesByName) {
  const failures = [...capabilitiesByName.entries()]
    .filter(([, entry]) => entry.status === "failed")
    .map(([name]) => name);

  if (failures.length > 0) {
    throw new Error(
      `Disposable integration attempted capabilities must not fail: ${failures.join(", ")}.`,
    );
  }
}

function cleanupResource(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(
      "Disposable integration cleanup entries must be objects.",
    );
  }

  const resource =
    typeof entry.resource === "string" ? entry.resource.trim() : "";
  if (!resource) {
    throw new Error("Disposable integration cleanup resource is required.");
  }
  return resource;
}

function indexCleanup(cleanup) {
  if (!Array.isArray(cleanup)) {
    throw new TypeError(
      "Disposable integration report cleanup must be an array.",
    );
  }

  const cleanupByResource = new Map();
  for (const entry of cleanup) {
    const resource = cleanupResource(entry);
    if (cleanupByResource.has(resource)) {
      throw new Error(
        `Disposable integration cleanup contains duplicate resource ${resource}.`,
      );
    }
    cleanupByResource.set(resource, entry.cleaned === true);
  }
  return cleanupByResource;
}

function requiredCleanupResources(flags) {
  const resources = [...BASE_REQUIRED_CLEANUP_RESOURCES];
  if (flags.mergeRequestCoverage) {
    resources.push("merge_request");
  }
  return resources;
}

function cleanupFailures(cleanupByResource, requiredResources) {
  const requiredFailures = requiredResources.filter(
    (resource) => cleanupByResource.get(resource) !== true,
  );
  const otherFailures = [...cleanupByResource.entries()]
    .filter(([, cleaned]) => !cleaned)
    .map(([resource]) => resource)
    .filter((resource) => !requiredFailures.includes(resource));
  return [...requiredFailures, ...otherFailures];
}

function assertCleanupSucceeded(cleanupByResource, requiredResources) {
  const failures = cleanupFailures(cleanupByResource, requiredResources);
  if (failures.length > 0) {
    throw new Error(
      `Disposable integration cleanup must succeed for all created resources: ${failures.join(", ")}.`,
    );
  }
}

export function validateDisposableIntegrationReport(report, options = {}) {
  assertReportObject(report);
  assertSuccessfulFinalizedReport(report);
  assertExpectedCommit(report, options.expectedCommitSha);

  const flags = validateCoverageFlags(report.flags);
  const capabilitiesByName = indexCapabilities(report.capabilities);
  const requiredCapabilities = requiredCapabilityNames(flags);
  assertRequiredCapabilitiesPassed(capabilitiesByName, requiredCapabilities);
  assertNoFailedCapabilities(capabilitiesByName);

  const cleanupByResource = indexCleanup(report.cleanup);
  const requiredResources = requiredCleanupResources(flags);
  assertCleanupSucceeded(cleanupByResource, requiredResources);

  return Object.freeze({
    capabilityCount: report.capabilities.length,
    requiredCapabilityCount: requiredCapabilities.length,
    cleanupCount: report.cleanup.length,
    requiredCleanupCount: requiredResources.length,
  });
}
