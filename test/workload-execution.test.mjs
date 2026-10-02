import assert from "node:assert/strict";
import test from "node:test";

import {
  executeScenario,
  executeWorkload,
} from "../scripts/lib/workload-execution.mjs";

function scenario(overrides = {}) {
  return {
    id: "repository.inspect-tree-file",
    mutation: "none",
    requiresDisposable: false,
    cleanup: [],
    execution: {
      correctness: true,
      benchmarkRepetitions: 2,
      warmupRepetitions: 1,
    },
    ...overrides,
  };
}

function clock(step = 5) {
  let current = 0;
  return () => {
    const value = current;
    current += step;
    return value;
  };
}

test("correctness execution records MET-01 events and final-state verification", async () => {
  const result = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    execute: async ({ observe }) => {
      observe({ metric: "gitlab_mcp.tool.calls" });
      observe({ metric: "gitlab_mcp.gitlab.request.duration", value: 0.01 });
      observe({ metric: "gitlab_mcp.gitlab.response.size", value: 128 });
      observe({ metric: "gitlab_mcp.tool.result.size", value: 64 });
    },
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: [],
    }),
    now: clock(),
  });

  assert.equal(result.success, true);
  assert.equal(result.finalStateVerified, true);
  assert.equal(result.samples.length, 1);
  assert.equal(result.warmupsCompleted, 0);
  assert.equal(result.measurements.wallDurationMs, 5);
  assert.equal(result.measurements.toolCalls, 1);
  assert.equal(result.measurements.gitlabLogicalRequests, 1);
  assert.equal(result.measurements.gitlabPhysicalAttempts, 1);
  assert.equal(result.measurements.gitlabResponseBytes, 128);
  assert.equal(result.measurements.mcpResultBytes, 64);
});

test("benchmark warmups are excluded from measured samples", async () => {
  let executions = 0;
  let verifications = 0;
  const result = await executeScenario({
    scenario: scenario(),
    mode: "benchmark",
    execute: async ({ measured, observe }) => {
      executions += 1;
      observe({ metric: "gitlab_mcp.tool.calls" });
      if (measured) {
        observe({
          metric: "gitlab_mcp.gitlab.request.duration",
          value: 0.01,
        });
      }
    },
    verifyFinalState: async () => {
      verifications += 1;
      return {
        verified: true,
        forbiddenEffectsObserved: [],
      };
    },
    now: clock(2),
  });

  assert.equal(executions, 3);
  assert.equal(verifications, 3);
  assert.equal(result.warmupsCompleted, 1);
  assert.equal(result.samples.length, 2);
  assert.equal(result.measurements.toolCalls, 2);
  assert.equal(result.measurements.gitlabLogicalRequests, 2);
  assert.equal(result.measurements.wallDurationMs, 4);
});

test("unsafe warmup stops before measured samples and preserves the safety violation", async () => {
  let executions = 0;
  let measuredExecutions = 0;
  const result = await executeScenario({
    scenario: scenario(),
    mode: "benchmark",
    execute: async ({ measured }) => {
      executions += 1;
      if (measured) measuredExecutions += 1;
    },
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: ["unrelated_mutation"],
    }),
    now: clock(),
  });

  assert.equal(executions, 1);
  assert.equal(measuredExecutions, 0);
  assert.equal(result.samples.length, 0);
  assert.equal(result.warmupsCompleted, 0);
  assert.equal(result.success, false);
  assert.equal(result.finalStateVerified, true);
  assert.deepEqual(result.forbiddenEffectsObserved, ["unrelated_mutation"]);
  assert.equal(result.failurePhase, "verify");
});

test("scenario prepare and finalize run once around all repetitions", async () => {
  const calls = [];
  const result = await executeScenario({
    scenario: scenario(),
    mode: "benchmark",
    prepare: async () => calls.push("prepare"),
    setup: async ({ measured }) => calls.push(measured ? "setup-m" : "setup-w"),
    execute: async ({ measured }) =>
      calls.push(measured ? "execute-m" : "execute-w"),
    verifyFinalState: async () => {
      calls.push("verify");
      return {
        verified: true,
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async ({ measured }) =>
      calls.push(measured ? "cleanup-m" : "cleanup-w"),
    finalize: async () => calls.push("finalize"),
    now: clock(),
  });

  assert.deepEqual(calls, [
    "prepare",
    "setup-w",
    "execute-w",
    "verify",
    "cleanup-w",
    "setup-m",
    "execute-m",
    "verify",
    "cleanup-m",
    "setup-m",
    "execute-m",
    "verify",
    "cleanup-m",
    "finalize",
  ]);
  assert.equal(result.prepared, true);
  assert.equal(result.finalizeSucceeded, true);
  assert.equal(result.success, true);
});

test("finalize failure fails the scenario after successful measurements", async () => {
  const result = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    execute: async () => {},
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: [],
    }),
    finalize: async () => {
      throw new Error("fixture teardown failed");
    },
    now: clock(),
  });

  assert.equal(result.finalStateVerified, true);
  assert.equal(result.finalizeSucceeded, false);
  assert.equal(result.success, false);
});

test("fixture setup is excluded from measured wall duration", async () => {
  const calls = [];
  const result = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    setup: async () => calls.push("setup"),
    execute: async () => calls.push("execute"),
    verifyFinalState: async () => {
      calls.push("verify");
      return { verified: true, forbiddenEffectsObserved: [] };
    },
    cleanup: async () => calls.push("cleanup"),
    now: clock(7),
  });

  assert.deepEqual(calls, ["setup", "execute", "verify", "cleanup"]);
  assert.equal(result.measurements.wallDurationMs, 7);
  assert.equal(result.success, true);
});

test("verification and cleanup are excluded from measured wall duration", async () => {
  let current = 0;
  const result = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    setup: async () => {
      current += 100;
    },
    execute: async () => {
      current += 7;
    },
    verifyFinalState: async () => {
      current += 50;
      return { verified: true, forbiddenEffectsObserved: [] };
    },
    cleanup: async () => {
      current += 25;
    },
    now: () => current,
  });

  assert.equal(result.measurements.wallDurationMs, 7);
  assert.equal(current, 182);
  assert.equal(result.success, true);
});

test("failed execution preserves its measured duration before cleanup", async () => {
  let current = 0;
  const result = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    execute: async () => {
      current += 9;
      throw new Error("synthetic measured failure");
    },
    verifyFinalState: async () => ({ verified: true }),
    cleanup: async () => {
      current += 30;
    },
    now: () => current,
  });

  assert.equal(result.measurements.wallDurationMs, 9);
  assert.equal(current, 39);
  assert.equal(result.success, false);
});

test("cleanup runs when fixture setup fails before measurement starts", async () => {
  let cleanupCalls = 0;
  const result = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    setup: async () => {
      throw new Error("fixture setup failed");
    },
    execute: async () => {
      assert.fail("execution must not start after setup failure");
    },
    verifyFinalState: async () => ({ verified: true }),
    cleanup: async () => {
      cleanupCalls += 1;
    },
    now: clock(),
  });

  assert.equal(cleanupCalls, 1);
  assert.equal(result.success, false);
  assert.equal(result.measurements.wallDurationMs, 0);
});

test("benchmark stops measured repetitions after cleanup failure", async () => {
  let executions = 0;
  let measuredCleanups = 0;
  const result = await executeScenario({
    scenario: scenario(),
    mode: "benchmark",
    execute: async () => {
      executions += 1;
    },
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: [],
    }),
    cleanup: async ({ measured }) => {
      if (measured) {
        measuredCleanups += 1;
        throw new Error("cleanup failed");
      }
    },
    now: clock(),
  });

  assert.equal(executions, 2);
  assert.equal(measuredCleanups, 1);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].cleanupSucceeded, false);
  assert.equal(result.success, false);
  assert.equal(result.finalStateVerified, false);
});

test("benchmark stops measured repetitions after verification or safety failure", async () => {
  const measuredOnlyScenario = scenario({
    execution: {
      correctness: true,
      benchmarkRepetitions: 2,
      warmupRepetitions: 0,
    },
  });
  let verificationExecutions = 0;
  const verificationFailure = await executeScenario({
    scenario: measuredOnlyScenario,
    mode: "benchmark",
    execute: async () => {
      verificationExecutions += 1;
    },
    verifyFinalState: async () => ({
      verified: false,
      forbiddenEffectsObserved: [],
    }),
    now: clock(),
  });
  assert.equal(verificationExecutions, 1);
  assert.equal(verificationFailure.samples.length, 1);
  assert.equal(verificationFailure.success, false);

  let safetyExecutions = 0;
  const safetyFailure = await executeScenario({
    scenario: measuredOnlyScenario,
    mode: "benchmark",
    execute: async () => {
      safetyExecutions += 1;
    },
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: ["unrelated_mutation"],
    }),
    now: clock(),
  });
  assert.equal(safetyExecutions, 1);
  assert.equal(safetyFailure.samples.length, 1);
  assert.deepEqual(safetyFailure.forbiddenEffectsObserved, [
    "unrelated_mutation",
  ]);
  assert.equal(safetyFailure.success, false);
});

test("disposable safety is enforced before a mutation executes", async () => {
  let called = false;
  await assert.rejects(
    () =>
      executeScenario({
        scenario: scenario({
          id: "issues.create",
          mutation: "write",
          requiresDisposable: true,
          cleanup: ["restore_fixture"],
          execution: {
            correctness: true,
            benchmarkRepetitions: 1,
            warmupRepetitions: 0,
          },
        }),
        mode: "correctness",
        disposableTargetVerified: false,
        execute: async () => {
          called = true;
        },
        verifyFinalState: async () => ({ verified: true }),
      }),
    /positively verified disposable target/,
  );
  assert.equal(called, false);
});

test("cleanup runs after execution failure and marks the scenario failed", async () => {
  let cleanupCalls = 0;
  const result = await executeScenario({
    scenario: scenario({
      id: "issues.create",
      mutation: "write",
      requiresDisposable: true,
      cleanup: ["restore_fixture"],
      execution: {
        correctness: true,
        benchmarkRepetitions: 1,
        warmupRepetitions: 0,
      },
    }),
    mode: "correctness",
    disposableTargetVerified: true,
    execute: async () => {
      throw new Error("synthetic fixture failure");
    },
    verifyFinalState: async () => ({ verified: true }),
    cleanup: async () => {
      cleanupCalls += 1;
    },
    now: clock(),
  });

  assert.equal(cleanupCalls, 1);
  assert.equal(result.success, false);
  assert.equal(result.finalStateVerified, false);
  assert.equal(result.samples.length, 1);
});

test("forbidden effects fail the scenario independently of final-state verification", async () => {
  const result = await executeScenario({
    scenario: scenario(),
    mode: "correctness",
    execute: async () => {},
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: ["unrelated_mutation"],
    }),
    now: clock(),
  });

  assert.equal(result.success, false);
  assert.equal(result.finalStateVerified, true);
  assert.deepEqual(result.forbiddenEffectsObserved, ["unrelated_mutation"]);
});

test("workload execution requires an explicit handler for every scenario", async () => {
  await assert.rejects(
    () =>
      executeWorkload({
        scenarios: [scenario()],
        mode: "correctness",
        handlers: {},
      }),
    /No workload handler registered/,
  );
});
