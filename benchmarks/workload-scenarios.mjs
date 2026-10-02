const STANDARD_METRICS = Object.freeze([
  "wallDurationMs",
  "toolCalls",
  "gitlabLogicalRequests",
  "gitlabPhysicalAttempts",
  "gitlabResponseBytes",
  "mcpResultBytes",
  "presentationTruncations",
  "retries",
  "cacheHits",
  "cacheMisses",
  "admissionRejections",
]);

const EXECUTION_PROFILES = Object.freeze({
  read: Object.freeze({
    correctness: true,
    benchmarkRepetitions: 30,
    warmupRepetitions: 3,
  }),
  rateLimitedRead: Object.freeze({
    correctness: true,
    benchmarkRepetitions: 20,
    warmupRepetitions: 2,
  }),
  mutation: Object.freeze({
    correctness: true,
    benchmarkRepetitions: 5,
    warmupRepetitions: 0,
  }),
  destructive: Object.freeze({
    correctness: false,
    benchmarkRepetitions: 2,
    warmupRepetitions: 0,
  }),
});

const FIXTURE_MUTATION_SCENARIOS = new Set([
  "repository.compare-refs",
  "issues.inspect-thread",
  "mr.review-metadata-diff",
  "mr.review-discussions",
  "mr.merge-readiness",
  "ci.diagnose-failure",
  "ci.bounded-log",
  "governance.approvals",
  "governance.schedules",
  "governance.variables",
  "release.inspect",
  "deployment.inspect",
]);

function scenario(
  id,
  category,
  goal,
  mutation,
  requiresDisposable,
  fixtureState,
  execution,
) {
  const fixtureMutation = FIXTURE_MUTATION_SCENARIOS.has(id);
  return Object.freeze({
    id,
    category,
    goal,
    mutation,
    requiresDisposable,
    fixtureState,
    fixtureSetup: Object.freeze(
      fixtureMutation
        ? [
            "verify_declared_fixture_preconditions",
            "create_benchmark_owned_fixture",
          ]
        : ["verify_declared_fixture_preconditions"],
    ),
    permittedEffects: Object.freeze(
      mutation !== "none"
        ? ["benchmark_owned_mutation"]
        : fixtureMutation
          ? ["benchmark_owned_fixture_setup"]
          : ["none"],
    ),
    forbiddenEffects: Object.freeze(["unrelated_mutation", "secret_exposure"]),
    expectedFinalState: Object.freeze([
      "goal_satisfied",
      "unrelated_state_unchanged",
    ]),
    cleanup: Object.freeze(
      mutation !== "none" || fixtureMutation
        ? ["restore_benchmark_owned_fixture_idempotently"]
        : [],
    ),
    metrics: "standard",
    execution,
  });
}

// Compact tuple-like calls are intentionally kept one-per-line for reviewability.
// prettier-ignore
const SCENARIOS = Object.freeze([
  scenario("context.resolve-project", "context", "Resolve a project search result to the authoritative fixture project.", "none", false, "visible disposable fixture project discoverable by name", "read"),
  scenario("context.capabilities", "context", "Determine instance and project capabilities for a planned workflow.", "none", false, "fixture project with stable capability envelope", "read"),
  scenario("context.identity", "context", "Resolve authenticated identity and accessible fixture context without credentials.", "none", false, "authenticated benchmark identity and fixture project", "read"),
  scenario("repository.inspect-tree-file", "repository", "Inspect a tree and fetch one known file from a pinned default branch.", "none", false, "pinned default branch with README.md", "read"),
  scenario("repository.search-fetch", "repository", "Search for a fixture marker and fetch bounded matching source.", "none", false, "unique non-secret marker in fixture repository", "rateLimitedRead"),
  scenario("repository.compare-refs", "repository", "Compare two stable refs and identify expected changed paths.", "none", true, "two refs with a bounded known diff", "read"),
  scenario("issues.inspect-thread", "issues", "Read a benchmark issue and notes without changing state.", "none", true, "benchmark issue with stable notes", "read"),
  scenario("issues.create", "issues", "Create one benchmark-owned issue with a unique run marker.", "write", true, "disposable project permitting issue creation", "mutation"),
  scenario("issues.update-comment", "issues", "Update and comment on a benchmark-owned disposable issue.", "write", true, "disposable project with benchmark-owned open issue", "mutation"),
  scenario("mr.review-metadata-diff", "merge_request_review", "Inspect merge-request metadata, commits, and bounded diff.", "none", true, "stable benchmark MR with pinned head and target", "read"),
  scenario("mr.review-discussions", "merge_request_review", "Identify unresolved MR discussions without replying or resolving.", "none", true, "benchmark MR with resolved and unresolved discussions", "read"),
  scenario("mr.merge-readiness", "merge_request_review", "Assess merge readiness from current MR gates and state.", "none", true, "benchmark MR with deterministic readiness state", "read"),
  scenario("mr.comment", "merge_request_mutation", "Add one benchmark-owned discussion comment to a disposable MR.", "write", true, "disposable project with benchmark-owned open MR", "mutation"),
  scenario("mr.resolve-discussion", "merge_request_mutation", "Resolve one explicitly designated benchmark-owned discussion.", "write", true, "disposable project with designated unresolved discussion", "mutation"),
  scenario("mr.guarded-merge", "merge_request_mutation", "Merge a benchmark-owned MR only when pinned safety preconditions hold.", "destructive", true, "disposable project with explicitly mergeable benchmark MR", "destructive"),
  scenario("ci.diagnose-failure", "ci_diagnosis", "Identify failing job and failure class in a stable failed pipeline.", "none", true, "stable failed fixture pipeline with known failure", "read"),
  scenario("ci.bounded-log", "ci_diagnosis", "Fetch only a bounded relevant log segment for a failed job.", "none", true, "failed job log with non-secret diagnostic marker", "read"),
  scenario("ci.lint", "ci_diagnosis", "Validate deterministic CI configuration and expected lint result.", "none", false, "fixture CI configuration samples with expected outcomes", "read"),
  scenario("ci.retry-failed", "ci_operations", "Retry only the designated benchmark-owned failed pipeline.", "write", true, "disposable project with retryable benchmark pipeline", "mutation"),
  scenario("ci.play-manual", "ci_operations", "Play one designated manual benchmark job.", "write", true, "disposable project with benchmark manual job", "mutation"),
  scenario("ci.cancel-controlled", "ci_operations", "Cancel one designated benchmark-owned running pipeline.", "destructive", true, "disposable project with benchmark cancelable pipeline", "destructive"),
  scenario("governance.protected-refs", "governance", "Inspect protected branch and tag policy without changing it.", "none", false, "fixture with stable protected-ref policy", "read"),
  scenario("governance.approvals", "governance", "Inspect merge-request approval policy and approval state.", "none", true, "fixture with stable approval rules", "read"),
  scenario("governance.schedules", "governance", "Inspect pipeline schedules without triggering or changing them.", "none", true, "fixture with stable benchmark schedules", "read"),
  scenario("governance.variables", "governance", "Inspect CI/CD variable metadata without exposing values.", "none", true, "fixture with benchmark CI/CD variable metadata", "read"),
  scenario("release.inspect", "release_deployment", "Inspect a benchmark tag, release, and bounded asset metadata.", "none", true, "fixture with stable benchmark release", "read"),
  scenario("release.asset-flow", "release_deployment", "Create and remove a benchmark-owned tag/release asset flow.", "write", true, "disposable project permitting benchmark release flow", "mutation"),
  scenario("deployment.inspect", "release_deployment", "Inspect benchmark environment and deployment history without deployment.", "none", true, "fixture with stable environment and deployment history", "read"),
  scenario("safety.not-found-recovery", "failure_safety", "Recover deterministically from not-found using declared fallback.", "none", false, "absent identifier plus known fallback resource", "read"),
  scenario("safety.permission-recovery", "failure_safety", "Handle permission denial without writes or secret leakage.", "none", false, "fixture identity denied one safe read scope", "read"),
  scenario("safety.auth-failure", "failure_safety", "Classify isolated authentication failure without credential leakage.", "none", false, "isolated invalid benchmark credential path", "read"),
  scenario("safety.timeout", "failure_safety", "Bound a deliberately slow request without unbounded retries.", "none", false, "controlled slow endpoint or deterministic timeout stub", "read"),
  scenario("safety.bounded-response", "failure_safety", "Bound an intentionally oversized non-secret response.", "none", false, "oversized generated non-secret fixture response", "read"),
  scenario("safety.read-only-mutation", "failure_safety", "Prove read-only mode rejects mutation before GitLab mutation.", "none", true, "read-only server against positively identified disposable project", "read"),
  scenario("safety.admission-limit", "failure_safety", "Exercise deterministic HTTP admission limit and bounded rejection.", "none", false, "HTTP MCP fixture with low benchmark-only admission limit", "read"),
]);

export const WORKLOAD_MANIFEST = Object.freeze({
  schemaVersion: 1,
  classification: "benchmark",
  workload: "gitlab-mcp-synthetic-v1",
  workloadVersion: 1,
  metricProvenance: Object.freeze({
    contract: "GitLab MCP Metric Contract v1",
    source: "server/src/gitlab-metric-contract.json",
    collection: "privacy-safe in-process observability events",
  }),
  standardMetrics: STANDARD_METRICS,
  executionProfiles: EXECUTION_PROFILES,
  scenarios: SCENARIOS,
});
