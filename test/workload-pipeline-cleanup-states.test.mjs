import assert from "node:assert/strict";
import test from "node:test";

import { cleanupPipelineFixture } from "../scripts/lib/workload-live-fixtures.mjs";

const NONTERMINAL_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "waiting_for_callback",
  "pending",
  "running",
  "canceling",
  "manual",
  "scheduled",
  "future_transitional_state",
];

function notFoundError() {
  const error = new Error("not found");
  error.result = { status: 404 };
  return error;
}

test("pipeline fixture cleanup cancels every nonterminal pipeline state", async () => {
  for (const status of NONTERMINAL_STATUSES) {
    const calls = [];
    let pipelineReads = 0;
    const session = {
      project: 42,
      async call(name, args = {}) {
        calls.push({ name, args });
        if (name === "get_pipeline") {
          pipelineReads += 1;
          return {
            id: 71,
            status: pipelineReads === 1 ? status : "canceled",
          };
        }
        if (name === "cancel_pipeline") return { id: 71, status: "canceling" };
        assert.fail(`Unexpected tool call: ${name}`);
      },
    };

    await cleanupPipelineFixture(session, {
      branch: "mcp-bench/nonterminal",
      branchCreated: false,
      pipeline: { id: 71 },
    });

    assert.equal(
      calls.filter(({ name }) => name === "cancel_pipeline").length,
      1,
      `Expected ${status} pipeline to be canceled.`,
    );
    assert.equal(
      calls.filter(({ name }) => name === "get_pipeline").length,
      2,
      `Expected ${status} pipeline cancellation to be observed terminal.`,
    );
  }
});

test("pipeline fixture cleanup observes terminal cancellation before deleting its branch", async () => {
  const calls = [];
  let pipelineReads = 0;
  const session = {
    project: 42,
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "get_pipeline") {
        pipelineReads += 1;
        return {
          id: 74,
          status: pipelineReads === 1 ? "running" : "canceled",
        };
      }
      if (name === "cancel_pipeline") return { id: 74, status: "canceling" };
      if (name === "list_branches") {
        return { data: [{ name: "mcp-bench/wait-before-delete" }] };
      }
      if (name === "list_pipelines") {
        return { data: [{ id: 74, status: "canceled" }] };
      }
      if (name === "delete_branch") return {};
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };

  await cleanupPipelineFixture(session, {
    branch: "mcp-bench/wait-before-delete",
    branchCreated: true,
    pipeline: { id: 74 },
  });

  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      "get_pipeline",
      "cancel_pipeline",
      "get_pipeline",
      "list_branches",
      "list_pipelines",
      "delete_branch",
    ],
  );
});

test("pipeline cleanup treats an already-missing pipeline as clean", async () => {
  const session = {
    project: 42,
    async call(name) {
      assert.equal(name, "get_pipeline");
      throw notFoundError();
    },
  };

  await cleanupPipelineFixture(session, {
    branch: "mcp-bench/missing-pipeline",
    branchCreated: false,
    pipeline: { id: 72 },
  });
});

test("pipeline cleanup tolerates disappearance during cancellation", async () => {
  const session = {
    project: 42,
    async call(name) {
      if (name === "get_pipeline") return { id: 73, status: "running" };
      if (name === "cancel_pipeline") throw notFoundError();
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };

  await cleanupPipelineFixture(session, {
    branch: "mcp-bench/cancel-race",
    branchCreated: false,
    pipeline: { id: 73 },
  });
});
