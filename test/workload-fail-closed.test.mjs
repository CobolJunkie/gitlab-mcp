import assert from "node:assert/strict";
import test from "node:test";

import { executeWorkload } from "../scripts/lib/workload-execution.mjs";

function scenario(id) {
  return {
    id,
    mutation: "none",
    requiresDisposable: false,
    cleanup: [],
    execution: {
      correctness: true,
      benchmarkRepetitions: 1,
      warmupRepetitions: 0,
    },
  };
}

function successfulHandler(execute) {
  return {
    execute,
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: [],
    }),
  };
}

test("workload stops before later scenarios after a scenario failure", async () => {
  let secondExecuted = false;
  const first = successfulHandler(async () => {});
  first.cleanup = async () => {
    throw new Error("fixture cleanup failed");
  };

  const results = await executeWorkload({
    scenarios: [scenario("first"), scenario("second")],
    mode: "correctness",
    handlers: {
      first,
      second: successfulHandler(async () => {
        secondExecuted = true;
      }),
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.equal(secondExecuted, false);
});

test("workload preflights every handler before executing any scenario", async () => {
  let firstExecuted = false;

  await assert.rejects(
    () =>
      executeWorkload({
        scenarios: [scenario("first"), scenario("missing")],
        mode: "correctness",
        handlers: {
          first: successfulHandler(async () => {
            firstExecuted = true;
          }),
        },
      }),
    /No workload handler registered for missing/,
  );

  assert.equal(firstExecuted, false);
});
