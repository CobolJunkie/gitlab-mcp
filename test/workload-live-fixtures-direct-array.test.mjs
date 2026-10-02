import assert from "node:assert/strict";
import test from "node:test";

import { waitForPipelineJob } from "../scripts/lib/workload-live-fixtures.mjs";

test("pipeline job waits accept direct array responses", async () => {
  const session = {
    project: 42,
    async call(name) {
      assert.equal(name, "list_pipeline_jobs");
      return [{ id: 52, status: "failed" }];
    },
  };

  const job = await waitForPipelineJob(
    session,
    51,
    (entry) => entry.status === "failed",
    { timeoutMs: 100, pollMs: 0 },
  );

  assert.equal(job.id, 52);
});
