import assert from "node:assert/strict";
import test from "node:test";

import { createBranchFixture } from "../scripts/lib/workload-live-fixtures.mjs";

test("branch fixture tolerates delayed GitLab branch-tip visibility", async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  let committed = false;
  let postCommitReads = 0;

  Date.now = () => now;
  globalThis.setTimeout = (callback, ms = 0, ...args) => {
    now += Number(ms) || 0;
    callback(...args);
    return 0;
  };

  const session = {
    project: 42,
    defaultBranch: "main",
    runId: "eventual-visibility",
    async call(name, args = {}) {
      if (name === "create_branch") {
        return { commit: { id: "base-tip" } };
      }
      if (name === "create_commit") {
        committed = true;
        return { id: "commit-tip" };
      }
      if (name === "list_branches") {
        if (!committed) {
          return {
            data: [{ name: args.search, commit: { id: "base-tip" } }],
          };
        }
        postCommitReads += 1;
        return {
          data: [
            {
              name: args.search,
              commit: {
                id: postCommitReads < 56 ? "base-tip" : "commit-tip",
              },
            },
          ],
        };
      }
      return undefined;
    },
  };

  try {
    const fixture = await createBranchFixture(session, "eventual visibility");
    assert.equal(fixture.commit.id, "commit-tip");
    assert.equal(postCommitReads, 56);
    assert.ok(now > 5_000);
    assert.ok(now < 30_000);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});
