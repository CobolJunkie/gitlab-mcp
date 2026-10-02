import assert from "node:assert/strict";
import test from "node:test";

import { deleteBranchIfPresent } from "../scripts/lib/workload-live-fixtures.mjs";

test("branch cleanup quiesces active pipelines before deleting the ref", async () => {
  const calls = [];
  let pipelineReads = 0;
  const session = {
    project: 42,
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "list_branches") {
        return { data: [{ name: "mcp-bench/fixture" }] };
      }
      if (name === "list_pipelines") {
        return { data: [{ id: 71, status: "running" }] };
      }
      if (name === "cancel_pipeline") return { id: 71, status: "canceling" };
      if (name === "get_pipeline") {
        pipelineReads += 1;
        return { id: 71, status: pipelineReads === 1 ? "running" : "canceled" };
      }
      if (name === "delete_branch") return {};
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };

  await deleteBranchIfPresent(session, "mcp-bench/fixture");

  const cancelIndex = calls.findIndex(
    (entry) => entry.name === "cancel_pipeline",
  );
  const deleteIndex = calls.findIndex(
    (entry) => entry.name === "delete_branch",
  );
  assert.ok(cancelIndex >= 0);
  assert.ok(deleteIndex > cancelIndex);
});
