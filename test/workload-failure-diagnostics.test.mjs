import assert from "node:assert/strict";
import test from "node:test";

import { executeScenario } from "../scripts/lib/workload-execution.mjs";

function scenario() {
  return {
    id: "repository.inspect-tree-file",
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

test("workload failures expose only their lifecycle phase", async () => {
  const setupFailure = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    setup: async () => {
      throw new Error("sensitive setup detail must not be serialized");
    },
    execute: async () => assert.fail("execute must not run"),
    verifyFinalState: async () => ({ verified: true }),
  });
  assert.equal(setupFailure.failurePhase, "setup");
  assert.equal(
    JSON.stringify(setupFailure).includes("sensitive setup detail"),
    false,
  );

  const verificationFailure = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    execute: async () => {},
    verifyFinalState: async () => ({ verified: false }),
  });
  assert.equal(verificationFailure.failurePhase, "verify");

  const finalizeFailure = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    execute: async () => {},
    verifyFinalState: async () => ({ verified: true }),
    finalize: async () => {
      throw new Error("sensitive finalize detail must not be serialized");
    },
  });
  assert.equal(finalizeFailure.failurePhase, "finalize");
  assert.equal(finalizeFailure.finalizeSucceeded, false);
});
