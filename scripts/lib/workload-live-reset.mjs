import { quiescePipelinesForRef } from "./workload-live-pipeline-quiescence.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const BENCHMARK_BRANCH_PREFIX = "mcp-bench/";
const BENCHMARK_TAG_PREFIX = "bench-bench-";
const BENCHMARK_SCHEDULE_PREFIX = "BENCH bench-";
const BENCHMARK_VARIABLE_PREFIX = "BENCHMARK_METADATA_BENCH_";
const BENCHMARK_ENVIRONMENT_PREFIX = "benchmark / bench-";
const BENCHMARK_FIXTURE_PREFIX = "BENCH fixture bench-";
const BENCHMARK_ISSUE_DESCRIPTION =
  "Disposable GitLab MCP benchmark issue fixture.";
const BENCHMARK_MERGE_REQUEST_DESCRIPTION =
  "Disposable GitLab MCP benchmark fixture.";

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

function isNotFound(error) {
  return error?.result?.status === 404 || error?.status === 404;
}

async function ignoreNotFound(operation) {
  try {
    return await operation();
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function listAll(session, tool, args = {}) {
  const entries = [];
  let page = 1;
  for (let attempt = 0; attempt < MAX_PAGES; attempt += 1) {
    const result = await session.call(tool, {
      project: session.project,
      ...args,
      page,
      per_page: PAGE_SIZE,
    });
    const batch = rows(result);
    entries.push(...batch);

    const pagination = result?.pagination;
    const nextPage = Number(pagination?.nextPage);
    if (Number.isSafeInteger(nextPage) && nextPage > page) {
      page = nextPage;
      continue;
    }
    if (
      Number.isSafeInteger(pagination?.page) &&
      Number.isSafeInteger(pagination?.totalPages) &&
      pagination.page < pagination.totalPages
    ) {
      page = pagination.page + 1;
      continue;
    }
    if (!pagination && batch.length === PAGE_SIZE) {
      page += 1;
      continue;
    }
    return entries;
  }
  throw new Error(
    `Benchmark fixture reset exceeded ${MAX_PAGES} pages for ${tool}.`,
  );
}

function benchmarkFixtureTitle(title) {
  const normalized = String(title || "").replace(/^Draft:\s*/, "");
  return normalized.startsWith(BENCHMARK_FIXTURE_PREFIX);
}

export function isBenchmarkOwnedBranch(branch) {
  return String(branch?.name || branch || "").startsWith(
    BENCHMARK_BRANCH_PREFIX,
  );
}

export function isBenchmarkOwnedIssue(issue) {
  return (
    benchmarkFixtureTitle(issue?.title) &&
    issue?.description === BENCHMARK_ISSUE_DESCRIPTION
  );
}

export function isBenchmarkOwnedMergeRequest(mergeRequest) {
  return (
    benchmarkFixtureTitle(mergeRequest?.title) &&
    mergeRequest?.description === BENCHMARK_MERGE_REQUEST_DESCRIPTION &&
    isBenchmarkOwnedBranch(mergeRequest?.source_branch) &&
    isBenchmarkOwnedBranch(mergeRequest?.target_branch)
  );
}

export function isBenchmarkOwnedRelease(release) {
  const tagName = String(release?.tag_name || "");
  return (
    tagName.startsWith(BENCHMARK_TAG_PREFIX) &&
    release?.name === `BENCH ${tagName}`
  );
}

export function isBenchmarkOwnedTag(tag) {
  return String(tag?.name || tag || "").startsWith(BENCHMARK_TAG_PREFIX);
}

export function isBenchmarkOwnedSchedule(schedule, defaultBranch) {
  const ref = String(schedule?.ref || "");
  return (
    String(schedule?.description || "").startsWith(BENCHMARK_SCHEDULE_PREFIX) &&
    schedule?.active === false &&
    (ref === defaultBranch || ref === `refs/heads/${defaultBranch}`)
  );
}

export function isBenchmarkOwnedVariable(variable) {
  return (
    String(variable?.key || "").startsWith(BENCHMARK_VARIABLE_PREFIX) &&
    variable?.environment_scope === "*"
  );
}

export function isBenchmarkOwnedEnvironment(environment) {
  return String(environment?.name || "").startsWith(
    BENCHMARK_ENVIRONMENT_PREFIX,
  );
}

export async function resetStaleBenchmarkFixtures(session) {
  const summary = {
    mergeRequests: 0,
    issues: 0,
    schedules: 0,
    variables: 0,
    releases: 0,
    tags: 0,
    environments: 0,
    branches: 0,
  };

  const branches = await listAll(session, "list_branches");
  const ownedBranches = branches.filter(isBenchmarkOwnedBranch);
  for (const branch of ownedBranches) {
    await quiescePipelinesForRef(session, branch.name);
  }

  const mergeRequests = await listAll(session, "list_merge_requests", {
    state: "opened",
    scope: "all",
  });
  for (const mergeRequest of mergeRequests.filter(
    isBenchmarkOwnedMergeRequest,
  )) {
    await ignoreNotFound(() =>
      session.call("update_merge_request", {
        project: session.project,
        merge_request_iid: mergeRequest.iid,
        state_event: "close",
      }),
    );
    summary.mergeRequests += 1;
  }

  const issues = await listAll(session, "list_issues", {
    state: "opened",
    scope: "all",
  });
  for (const issue of issues.filter(isBenchmarkOwnedIssue)) {
    await ignoreNotFound(() =>
      session.call("update_issue", {
        project: session.project,
        issue_iid: issue.iid,
        state_event: "close",
      }),
    );
    summary.issues += 1;
  }

  const schedules = await listAll(session, "list_pipeline_schedules");
  for (const schedule of schedules.filter((entry) =>
    isBenchmarkOwnedSchedule(entry, session.defaultBranch),
  )) {
    await ignoreNotFound(() =>
      session.call("delete_pipeline_schedule", {
        project: session.project,
        pipeline_schedule_id: schedule.id,
      }),
    );
    summary.schedules += 1;
  }

  const variables = await listAll(session, "list_project_ci_variables");
  for (const variable of variables.filter(isBenchmarkOwnedVariable)) {
    await ignoreNotFound(() =>
      session.call("delete_project_ci_variable", {
        project: session.project,
        key: variable.key,
        filter_environment_scope: variable.environment_scope,
      }),
    );
    summary.variables += 1;
  }

  const releases = await listAll(session, "list_releases");
  for (const release of releases.filter(isBenchmarkOwnedRelease)) {
    await ignoreNotFound(() =>
      session.call("delete_release", {
        project: session.project,
        tag_name: release.tag_name,
        acknowledge_release_deletion: true,
      }),
    );
    summary.releases += 1;
  }

  const tags = await listAll(session, "list_tags");
  for (const tag of tags.filter(isBenchmarkOwnedTag)) {
    await quiescePipelinesForRef(session, tag.name);
    await ignoreNotFound(() =>
      session.call("delete_tag", {
        project: session.project,
        tag_name: tag.name,
        acknowledge_tag_deletion: true,
      }),
    );
    summary.tags += 1;
  }

  const environments = await listAll(session, "list_environments");
  for (const environment of environments.filter(isBenchmarkOwnedEnvironment)) {
    await session.cleanupBenchmarkEnvironment({
      environmentId: environment.id,
      environmentName: environment.name,
    });
    summary.environments += 1;
  }

  for (const branch of ownedBranches) {
    await quiescePipelinesForRef(session, branch.name);
    await ignoreNotFound(() =>
      session.call("delete_branch", {
        project: session.project,
        branch: branch.name,
        expected_head_sha: branch.commit?.id,
        acknowledge_branch_deletion: true,
      }),
    );
    summary.branches += 1;
  }

  return Object.freeze(summary);
}
