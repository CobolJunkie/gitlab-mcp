import assert from "node:assert/strict";
import test from "node:test";

import { applyVerifiedReadWorkloadOverrides } from "../scripts/lib/workload-live-read-overrides.mjs";

function handlerFor(session) {
  return applyVerifiedReadWorkloadOverrides(session, {
    "ci.diagnose-failure": { marker: "old" },
  })["ci.diagnose-failure"];
}

function sessionFixture({ preparationFailure, cleanupFailure } = {}) {
  const calls = [];
  let pipelineReads = 0;
  return {
    project: 42,
    defaultBranch: "main",
    runId: "bench-read-cleanup",
    calls,
    measured(_observe, operation) {
      return operation();
    },
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_commit") return { id: "fixture-sha" };
      if (name === "list_pipelines") {
        return { id: 61, sha: "fixture-sha", status: "pending" };
      }
      if (name === "get_pipeline") {
        pipelineReads += 1;
        if (pipelineReads === 1 && preparationFailure) {
          throw preparationFailure;
        }
        if (pipelineReads > 1 && cleanupFailure) {
          throw cleanupFailure;
        }
        return { id: 61, status: "failed" };
      }
      if (name === "list_branches") {
        return { data: [{ name: args.search, commit: { id: "fixture-sha" } }] };
      }
      if (name === "delete_branch") return {};
      return undefined;
    },
  };
}

function callsNamed(session, name) {
  return session.calls.filter((entry) => entry.name === name);
}

test("failed pipeline read preparation cleans the already-created fixture", async () => {
  const preparationFailure = new Error("pipeline inspection failed");
  const session = sessionFixture({ preparationFailure });
  const handler = handlerFor(session);

  await assert.rejects(
    handler.prepare(),
    (error) => error === preparationFailure,
  );

  assert.equal(callsNamed(session, "delete_branch").length, 1);
});

test("failed pipeline read preparation preserves the recovery ref when cleanup cannot inspect the pipeline", async () => {
  const preparationFailure = new Error("pipeline inspection failed");
  const cleanupFailure = new Error("cleanup inspection failed");
  const session = sessionFixture({ preparationFailure, cleanupFailure });
  const handler = handlerFor(session);

  await assert.rejects(handler.prepare(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [preparationFailure, cleanupFailure]);
    return true;
  });

  assert.equal(callsNamed(session, "delete_branch").length, 0);
});
