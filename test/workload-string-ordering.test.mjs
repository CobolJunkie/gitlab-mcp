import assert from "node:assert/strict";
import test from "node:test";

import { aggregateScenarioResults } from "../scripts/lib/workload-benchmark.mjs";
import { executeScenario } from "../scripts/lib/workload-execution.mjs";

const UNSORTED_EFFECTS = ["a_b", "a-b", "a.b", "aa", "a1", "a:b"];
const CODE_UNIT_ORDER = ["a-b", "a.b", "a1", "a:b", "a_b", "aa"];

function measurements() {
  return {
    wallDurationMs: 0,
    toolCalls: 0,
    gitlabLogicalRequests: 0,
    gitlabPhysicalAttempts: 0,
    gitlabResponseBytes: 0,
    mcpResultBytes: 0,
    presentationTruncations: 0,
    retries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    admissionRejections: 0,
  };
}

test("aggregate reports preserve code-unit ordering for forbidden effects", () => {
  const aggregate = aggregateScenarioResults([
    {
      scenarioId: "ordering",
      success: false,
      finalStateVerified: true,
      forbiddenEffectsObserved: UNSORTED_EFFECTS,
      measurements: measurements(),
    },
  ]);

  assert.deepEqual(
    aggregate.results[0].forbiddenEffectsObserved,
    CODE_UNIT_ORDER,
  );
});

test("scenario execution preserves code-unit ordering for forbidden effects", async () => {
  const result = await executeScenario({
    scenario: {
      id: "ordering",
      mutation: "none",
      requiresDisposable: false,
      execution: {},
    },
    mode: "correctness",
    execute: async () => {},
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: UNSORTED_EFFECTS,
    }),
  });

  assert.deepEqual(result.forbiddenEffectsObserved, CODE_UNIT_ORDER);
});
