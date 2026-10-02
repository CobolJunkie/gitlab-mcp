import assert from "node:assert/strict";
import test from "node:test";

import { quiescePipelinesForRef } from "../scripts/lib/workload-live-pipeline-quiescence.mjs";

test("pipeline quiescence fails closed when an active pipeline has no usable id", async () => {
  const calls = [];
  const session = {
    project: 42,
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "list_pipelines") {
        return { data: [{ id: "91", status: "running" }] };
      }
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };

  await assert.rejects(
    quiescePipelinesForRef(session, "bench-ref"),
    /nonterminal pipeline could not be identified by a valid numeric ID/,
  );
  assert.equal(
    calls.filter((entry) => entry.name === "cancel_pipeline").length,
    0,
  );
});
