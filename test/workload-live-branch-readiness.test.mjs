import assert from "node:assert/strict";
import test from "node:test";

import { createMergeRequestFixture } from "../scripts/lib/workload-live-fixtures.mjs";
import { waitForComparedBranchTip } from "../scripts/lib/workload-live-ref-readiness.mjs";

test("MR ref readiness tolerates transient compare lag before exact convergence", async () => {
  const calls = [];
  let attempt = 0;
  const session = {
    project: 42,
    async call(name, args) {
      calls.push({ name, args });
      assert.equal(name, "compare_refs");
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("ref not visible yet");
        error.result = { status: 404 };
        throw error;
      }
      if (attempt === 2) {
        return {
          commit: { id: "stale-sha" },
          compare_timeout: false,
          compare_same_ref: false,
        };
      }
      return {
        commit: null,
        compare_timeout: false,
        compare_same_ref: true,
      };
    },
  };

  const comparison = await waitForComparedBranchTip(
    session,
    "mcp-bench/base",
    "mcp-bench/source",
    "source-sha",
    { pollAttempts: 3, pollMs: 0 },
  );

  assert.equal(comparison.compare_same_ref, true);
  assert.equal(comparison.commit, null);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, {
    project: 42,
    from: "source-sha",
    to: "mcp-bench/source",
    straight: true,
  });
});

test("MR ref readiness propagates permanent compare failures", async () => {
  const failure = new Error("forbidden");
  failure.result = { status: 403 };
  const session = {
    project: 42,
    async call() {
      throw failure;
    },
  };

  await assert.rejects(
    waitForComparedBranchTip(
      session,
      "mcp-bench/base",
      "mcp-bench/source",
      "source-sha",
      { pollAttempts: 3, pollMs: 0 },
    ),
    (error) => error === failure,
  );
});

test("merge-request fixture waits for exact compared source tip before dependent writes", async () => {
  const calls = [];
  let compareCalls = 0;
  let sourceCommitCreated = false;
  const base = "mcp-bench/branch-readiness-base";
  const source = "mcp-bench/branch-readiness-source";
  const session = {
    project: 42,
    defaultBranch: "main",
    runId: "branch-readiness",
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_branch") {
        if (args.branch === base) {
          return { name: base, commit: { id: "base-sha" } };
        }
        assert.equal(args.branch, source);
        assert.equal(args.ref, "base-sha");
        return { name: source, commit: { id: "base-sha" } };
      }
      if (name === "compare_refs") {
        compareCalls += 1;
        assert.equal(
          args.from,
          sourceCommitCreated ? "source-sha" : "base-sha",
        );
        assert.equal(args.to, source);
        if (!sourceCommitCreated) {
          return {
            commit: null,
            compare_timeout: false,
            compare_same_ref: true,
          };
        }
        return compareCalls === 2
          ? {
              commit: { id: "base-sha" },
              compare_timeout: false,
              compare_same_ref: false,
            }
          : {
              commit: null,
              compare_timeout: false,
              compare_same_ref: true,
            };
      }
      if (name === "create_commit") {
        sourceCommitCreated = true;
        return { id: "source-sha" };
      }
      if (name === "create_merge_request") {
        assert.equal(sourceCommitCreated, true);
        assert.equal(compareCalls, 3);
        return { iid: 17, state: "opened" };
      }
      return undefined;
    },
  };

  const fixture = await createMergeRequestFixture(session, "branch readiness", {
    draft: false,
  });

  const sourceCreation = calls.find(
    (entry) => entry.name === "create_branch" && entry.args.branch === source,
  );
  assert.equal(fixture.mergeRequest.iid, 17);
  assert.equal(compareCalls, 3);
  assert.equal(sourceCreation.args.ref, "base-sha");
});
