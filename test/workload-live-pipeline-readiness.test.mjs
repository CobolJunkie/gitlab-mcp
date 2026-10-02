import assert from "node:assert/strict";
import test from "node:test";

import { createPipelineFixture } from "../scripts/lib/workload-live-fixtures.mjs";

test("pipeline fixture accepts exact pipeline evidence while branch-tip listing is stale", async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  let committed = false;
  let postCommitBranchReads = 0;
  let pipelineReads = 0;

  Date.now = () => now;
  globalThis.setTimeout = (callback, ms = 0, ...args) => {
    now += Number(ms) || 0;
    callback(...args);
    return 0;
  };

  const session = {
    project: 42,
    defaultBranch: "main",
    async call(name, args = {}) {
      if (name === "create_branch") {
        return { commit: { id: "base-tip" } };
      }
      if (name === "create_commit") {
        committed = true;
        return { id: "pipeline-tip" };
      }
      if (name === "list_branches") {
        if (committed) postCommitBranchReads += 1;
        return {
          data: [{ name: args.search, commit: { id: "base-tip" } }],
        };
      }
      if (name === "list_pipelines") {
        pipelineReads += 1;
        return {
          data: [
            {
              id: 71,
              ref: args.ref,
              sha: "pipeline-tip",
              status: "pending",
            },
          ],
        };
      }
      return undefined;
    },
  };

  try {
    const fixture = await createPipelineFixture(
      session,
      "stale branch tip",
      "stages: [test]\n",
    );

    assert.equal(fixture.commit.id, "pipeline-tip");
    assert.equal(fixture.pipeline.id, 71);
    assert.equal(postCommitBranchReads, 0);
    assert.equal(pipelineReads, 1);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});
