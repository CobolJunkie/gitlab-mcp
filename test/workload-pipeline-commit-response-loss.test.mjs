import assert from "node:assert/strict";
import test from "node:test";

import { createPipelineFixture } from "../scripts/lib/workload-live-fixtures.mjs";

function callsNamed(calls, name) {
  return calls.filter((entry) => entry.name === name);
}

test("pipeline fixture recovers an unacknowledged commit before deleting its branch", async () => {
  const calls = [];
  const failure = new Error("commit response lost");
  let commitAttempted = false;
  let pipelineReads = 0;
  const branch = "mcp-bench/response-loss";
  const session = {
    project: 42,
    defaultBranch: "main",
    runId: "bench-test",
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_branch") {
        return { name: branch, commit: { id: "base-tip" } };
      }
      if (name === "create_commit") {
        commitAttempted = true;
        throw failure;
      }
      if (name === "list_branches") {
        return {
          data: [
            {
              name: branch,
              commit: {
                id: commitAttempted ? "unacknowledged-tip" : "base-tip",
              },
            },
          ],
        };
      }
      if (name === "list_pipelines") {
        return {
          id: 91,
          sha: "unacknowledged-tip",
          status: "running",
        };
      }
      if (name === "get_pipeline") {
        pipelineReads += 1;
        return {
          id: 91,
          status: pipelineReads === 1 ? "running" : "canceled",
        };
      }
      if (name === "cancel_pipeline") {
        return { id: 91, status: "canceling" };
      }
      if (name === "delete_branch") return {};
      assert.fail(`Unexpected tool call: ${name} ${JSON.stringify(args)}`);
    },
  };

  await assert.rejects(
    createPipelineFixture(session, "response loss", "stages: [test]\n", {
      pollAttempts: 1,
      pollMs: 0,
    }),
    (error) => error === failure,
  );

  assert.deepEqual(callsNamed(calls, "list_pipelines")[0].args, {
    project: 42,
    ref: branch,
    sha: "unacknowledged-tip",
    source: "push",
    order_by: "id",
    sort: "desc",
    page: 1,
    per_page: 20,
  });
  assert.equal(callsNamed(calls, "cancel_pipeline").length, 1);
  assert.equal(callsNamed(calls, "delete_branch").length, 1);
  assert.ok(
    calls.findIndex((entry) => entry.name === "cancel_pipeline") <
      calls.findIndex((entry) => entry.name === "delete_branch"),
  );
});
