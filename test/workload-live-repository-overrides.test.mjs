import assert from "node:assert/strict";
import test from "node:test";

import { applyRepositoryWorkloadOverrides } from "../scripts/lib/workload-live-repository-overrides.mjs";

const PRIMARY_SEARCH_QUERY = "Dedicated non-production fixture";
const FALLBACK_SEARCH_QUERY = "Safe to mutate";
const SEARCH_MARKER =
  "Dedicated non-production fixture for the GitLab Codex Plugin disposable integration suite.";

function baseSession(call) {
  return {
    project: 42,
    defaultBranch: "main",
    call,
    measured(_observe, operation) {
      return operation();
    },
  };
}

function liveToolError({ status, message }) {
  const error = new Error(`tool failed: ${message}`);
  error.name = "LiveBenchmarkToolError";
  error.result = {
    error: "GitLabApiError",
    message,
    ...(status === undefined ? {} : { status }),
  };
  return error;
}

function matchingReadme() {
  return {
    data: [{ path: "README.md", ref: "main", project_id: 42 }],
  };
}

test("repository search fetches the exact matching bounded source", async () => {
  const calls = [];
  const session = baseSession(async (name, args = {}) => {
    calls.push({ name, args });
    if (name === "search_code") return matchingReadme();
    if (name === "get_file") {
      return { content: `# Fixture\n\n${SEARCH_MARKER}\n` };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await handler.execute({ observe: () => {} });
  assert.equal((await handler.verifyFinalState()).verified, true);

  const searches = calls.filter(({ name }) => name === "search_code");
  assert.equal(searches.length, 1);
  assert.equal(searches[0].args.search, PRIMARY_SEARCH_QUERY);
  assert.equal(searches[0].args.ref, "main");
  assert.equal(searches[0].args.project, 42);

  const fetch = calls.find(({ name }) => name === "get_file");
  assert.equal(fetch.args.path, "README.md");
  assert.equal(fetch.args.ref, "main");
  assert.equal(fetch.args.start_line, 1);
  assert.equal(fetch.args.end_line, 10);
});

test("repository fetch retries one transient GitLab failure", async () => {
  let searchCalls = 0;
  let fetchCalls = 0;
  const session = baseSession(async (name) => {
    if (name === "search_code") {
      searchCalls += 1;
      return matchingReadme();
    }
    if (name === "get_file") {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw liveToolError({
          status: 503,
          message: "GitLab API returned 503.",
        });
      }
      return { content: `# Fixture\n\n${SEARCH_MARKER}\n` };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await handler.execute({ observe: () => {} });
  assert.equal(searchCalls, 1);
  assert.equal(fetchCalls, 2);
});

test("repository fetch propagates permanent GitLab failures without retry", async () => {
  const expected = liveToolError({
    status: 403,
    message: "GitLab API returned 403 Forbidden.",
  });
  let fetchCalls = 0;
  const session = baseSession(async (name) => {
    if (name === "search_code") return matchingReadme();
    if (name === "get_file") {
      fetchCalls += 1;
      throw expected;
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await assert.rejects(() => handler.execute({ observe: () => {} }), expected);
  assert.equal(fetchCalls, 1);
});

test("repository search uses one independent fallback query after a miss", async () => {
  const searches = [];
  let fetchCalls = 0;
  const session = baseSession(async (name, args = {}) => {
    if (name === "search_code") {
      searches.push({ search: args.search, ref: args.ref });
      if (searches.length === 1) return { data: [] };
      return matchingReadme();
    }
    if (name === "get_file") {
      fetchCalls += 1;
      return { content: `# Fixture\n\n${SEARCH_MARKER}\n` };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await handler.execute({ observe: () => {} });
  assert.deepEqual(searches, [
    { search: PRIMARY_SEARCH_QUERY, ref: "main" },
    { search: FALLBACK_SEARCH_QUERY, ref: "main" },
  ]);
  assert.equal(fetchCalls, 1);
});

test("repository search fails after one bounded query set of correlated misses", async () => {
  const searches = [];
  let fetched = false;
  const session = baseSession(async (name, args = {}) => {
    if (name === "search_code") {
      searches.push(args.search);
      return { data: [] };
    }
    if (name === "get_file") {
      fetched = true;
      return { content: `# Fixture\n\n${SEARCH_MARKER}\n` };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /matching README source/,
  );
  assert.deepEqual(searches, [PRIMARY_SEARCH_QUERY, FALLBACK_SEARCH_QUERY]);
  assert.equal(fetched, false);
});

test("repository search uses the independent fallback for transient HTTP failures", async () => {
  for (const status of [429, 503]) {
    const searches = [];
    const session = baseSession(async (name, args = {}) => {
      if (name === "search_code") {
        searches.push(args.search);
        if (searches.length === 1) {
          throw liveToolError({
            status,
            message: `GitLab API returned ${status}.`,
          });
        }
        return matchingReadme();
      }
      if (name === "get_file") {
        return { content: `# Fixture\n\n${SEARCH_MARKER}\n` };
      }
      assert.fail(`Unexpected tool call: ${name}`);
    });
    const handler = applyRepositoryWorkloadOverrides(session, {
      "repository.search-fetch": { marker: "old" },
    })["repository.search-fetch"];

    await handler.execute({ observe: () => {} });
    assert.deepEqual(searches, [PRIMARY_SEARCH_QUERY, FALLBACK_SEARCH_QUERY]);
  }
});

test("repository search uses the independent fallback for transport failures", async () => {
  const searches = [];
  const session = baseSession(async (name, args = {}) => {
    if (name === "search_code") {
      searches.push(args.search);
      if (searches.length === 1) {
        throw liveToolError({
          message: "GitLab request failed: fetch failed",
        });
      }
      return matchingReadme();
    }
    if (name === "get_file") {
      return { content: `# Fixture\n\n${SEARCH_MARKER}\n` };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await handler.execute({ observe: () => {} });
  assert.deepEqual(searches, [PRIMARY_SEARCH_QUERY, FALLBACK_SEARCH_QUERY]);
});

test("repository search propagates permanent GitLab failures without fallback", async () => {
  const expected = liveToolError({
    status: 403,
    message: "GitLab API returned 403 Forbidden.",
  });
  let searchCalls = 0;
  const session = baseSession(async (name) => {
    assert.equal(name, "search_code");
    searchCalls += 1;
    throw expected;
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await assert.rejects(() => handler.execute({ observe: () => {} }), expected);
  assert.equal(searchCalls, 1);
});

test("repository search propagates unrelated failures without fallback", async () => {
  const expected = new Error("search failed");
  let searchCalls = 0;
  const session = baseSession(async (name) => {
    assert.equal(name, "search_code");
    searchCalls += 1;
    throw expected;
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await assert.rejects(() => handler.execute({ observe: () => {} }), expected);
  assert.equal(searchCalls, 1);
});

test("repository search verifies the full fixture marker after fetching", async () => {
  let fetchCalls = 0;
  const session = baseSession(async (name) => {
    if (name === "search_code") return matchingReadme();
    if (name === "get_file") {
      fetchCalls += 1;
      return { content: "# Unrelated README\n" };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /did not contain the fixture marker/,
  );
  assert.equal(fetchCalls, 1);
});

test("repository search refuses unrelated hits instead of fetching a fixed path", async () => {
  const searches = [];
  let fetched = false;
  const session = baseSession(async (name, args = {}) => {
    if (name === "search_code") {
      searches.push(args.search);
      return { data: [{ path: "docs/other.md", ref: "main", project_id: 42 }] };
    }
    if (name === "get_file") {
      fetched = true;
      return { content: SEARCH_MARKER };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /matching README source/,
  );
  assert.deepEqual(searches, [PRIMARY_SEARCH_QUERY, FALLBACK_SEARCH_QUERY]);
  assert.equal(fetched, false);
});

test("repository search refuses a hit from a different ref", async () => {
  let fetched = false;
  const session = baseSession(async (name) => {
    if (name === "search_code") {
      return {
        data: [{ path: "README.md", ref: "stale", project_id: 42 }],
      };
    }
    if (name === "get_file") {
      fetched = true;
      return { content: SEARCH_MARKER };
    }
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyRepositoryWorkloadOverrides(session, {
    "repository.search-fetch": { marker: "old" },
  })["repository.search-fetch"];

  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /matching README source/,
  );
  assert.equal(fetched, false);
});
