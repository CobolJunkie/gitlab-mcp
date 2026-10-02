import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateScenarioResults,
  deriveScenarioMetrics,
} from "../scripts/lib/workload-benchmark.mjs";

function measurements(logicalRequests = 12) {
  return {
    wallDurationMs: 30,
    toolCalls: 6,
    gitlabLogicalRequests: logicalRequests,
    gitlabPhysicalAttempts: logicalRequests,
    gitlabResponseBytes: 1200,
    mcpResultBytes: 600,
    presentationTruncations: 0,
    retries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    admissionRejections: 0,
  };
}

test("workflow amplification divides by completed measured executions", () => {
  const derived = deriveScenarioMetrics(measurements(), { completed: 3 });
  assert.equal(derived.workflowApiAmplification, 4);
});

test("aggregate workflow amplification uses repetition counts", () => {
  const aggregate = aggregateScenarioResults([
    {
      scenarioId: "context.identity",
      success: true,
      finalStateVerified: true,
      forbiddenEffectsObserved: [],
      measurements: measurements(),
      samples: [{}, {}, {}],
    },
  ]);

  assert.equal(aggregate.results[0].measurements.workflowApiAmplification, 4);
  assert.equal(aggregate.totals.workflowApiAmplification, 4);
});
