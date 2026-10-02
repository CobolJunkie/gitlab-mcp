import assert from "node:assert/strict";
import test from "node:test";

import { waitForMergeRequestPrepared } from "../scripts/lib/workload-live-merge-request-readiness.mjs";

function fixture() {
  return {
    base: "mcp-bench/base",
    source: "mcp-bench/source",
    commit: { id: "fixture-head" },
    mergeRequest: { iid: 17 },
  };
}

function preparedMergeRequest(overrides = {}) {
  return {
    iid: 17,
    state: "opened",
    source_branch: "mcp-bench/source",
    target_branch: "mcp-bench/base",
    sha: "fixture-head",
    prepared_at: "2026-09-15T07:49:30.918Z",
    diff_refs: { head_sha: "fixture-head" },
    ...overrides,
  };
}

test("merge-request readiness waits until GitLab finishes asynchronous preparation", async () => {
  let reads = 0;
  const state = fixture();
  const session = {
    project: 42,
    async call(name, args) {
      assert.equal(name, "get_merge_request");
      assert.deepEqual(args, { project: 42, merge_request_iid: 17 });
      reads += 1;
      return reads === 1
        ? { ...preparedMergeRequest(), prepared_at: null }
        : preparedMergeRequest();
    },
  };

  const mergeRequest = await waitForMergeRequestPrepared(session, state, {
    timeoutMs: 100,
    pollMs: 0,
  });

  assert.equal(reads, 2);
  assert.equal(mergeRequest.prepared_at !== null, true);
  assert.equal(state.mergeRequest, mergeRequest);
});

test("merge-request readiness waits for prepared head metadata to converge", async () => {
  let reads = 0;
  const state = fixture();
  const session = {
    project: 42,
    async call() {
      reads += 1;
      return reads === 1
        ? preparedMergeRequest({
            sha: "stale-head",
            diff_refs: { head_sha: "stale-head" },
          })
        : preparedMergeRequest();
    },
  };

  const mergeRequest = await waitForMergeRequestPrepared(session, state, {
    timeoutMs: 100,
    pollMs: 0,
  });

  assert.equal(reads, 2);
  assert.equal(mergeRequest.sha, "fixture-head");
  assert.equal(mergeRequest.diff_refs.head_sha, "fixture-head");
});

test("merge-request readiness fails closed when branch identity changes", async () => {
  const state = fixture();
  const session = {
    project: 42,
    async call() {
      return preparedMergeRequest({ source_branch: "unexpected-source" });
    },
  };

  await assert.rejects(
    waitForMergeRequestPrepared(session, state, {
      timeoutMs: 100,
      pollMs: 0,
    }),
    /changed source branch/,
  );
});
