import assert from "node:assert/strict";
import test from "node:test";

import { resetStaleBenchmarkFixtures } from "../scripts/lib/workload-live-reset.mjs";

test("stale reset quiesces tag pipelines before deleting benchmark tags", async () => {
  const calls = [];
  let pipelineReads = 0;
  const session = {
    project: 42,
    defaultBranch: "main",
    async cleanupBenchmarkEnvironment() {},
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "list_tags") {
        return { data: [{ name: "bench-bench-run-release" }] };
      }
      if (name === "list_pipelines") {
        return { data: [{ id: 81, status: "running" }] };
      }
      if (name === "cancel_pipeline") return { id: 81, status: "canceling" };
      if (name === "get_pipeline") {
        pipelineReads += 1;
        return { id: 81, status: pipelineReads === 1 ? "running" : "canceled" };
      }
      if (name === "delete_tag") return {};
      return { data: [] };
    },
  };

  const summary = await resetStaleBenchmarkFixtures(session);
  assert.equal(summary.tags, 1);

  const pipelineList = calls.find((entry) => entry.name === "list_pipelines");
  assert.equal(pipelineList.args.ref, "bench-bench-run-release");
  const cancelIndex = calls.findIndex(
    (entry) => entry.name === "cancel_pipeline",
  );
  const deleteIndex = calls.findIndex((entry) => entry.name === "delete_tag");
  assert.ok(cancelIndex >= 0);
  assert.ok(deleteIndex > cancelIndex);
});
