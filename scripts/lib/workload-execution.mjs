import {
  assertExecutionSafety,
  measurementsFromObservabilityEvents,
} from "./workload-benchmark.mjs";

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function.`);
  }
  return value;
}

function repetitionPlan(scenario, mode) {
  if (mode === "correctness") {
    return { warmups: 0, measured: 1 };
  }
  return {
    warmups: scenario.execution.warmupRepetitions,
    measured: scenario.execution.benchmarkRepetitions,
  };
}

function safeEffectList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim());
}

function unsafeSample(sample) {
  return (
    !sample.success ||
    !sample.cleanupSucceeded ||
    !sample.finalStateVerified ||
    sample.forbiddenEffectsObserved.length > 0
  );
}

function withFailurePhase(value, failurePhase) {
  if (failurePhase) value.failurePhase = failurePhase;
  return value;
}

async function invokeIteration({
  scenario,
  mode,
  iteration,
  measured,
  setup,
  execute,
  verifyFinalState,
  cleanup,
  now,
}) {
  const events = [];
  const observe = (event) => {
    if (event && typeof event === "object") {
      events.push(structuredClone(event));
    }
  };
  let startedAt;
  let finishedAt;
  let success = false;
  let finalStateVerified = false;
  let forbiddenEffectsObserved = [];
  let cleanupSucceeded = true;
  let failurePhase;
  let phase = "setup";

  try {
    await setup({ scenario, mode, iteration, measured });
    phase = "execute";
    startedAt = now();
    await execute({
      scenario,
      mode,
      iteration,
      measured,
      observe,
    });
    finishedAt = now();
    success = true;
    phase = "verify";
    const verification = await verifyFinalState({
      scenario,
      mode,
      iteration,
    });
    finalStateVerified = verification?.verified === true;
    forbiddenEffectsObserved = safeEffectList(
      verification?.forbiddenEffectsObserved,
    );
    if (!finalStateVerified || forbiddenEffectsObserved.length > 0) {
      failurePhase = "verify";
    }
  } catch {
    failurePhase ||= phase;
    if (startedAt !== undefined && finishedAt === undefined) {
      finishedAt = now();
    }
    success = false;
  } finally {
    try {
      await cleanup({ scenario, mode, iteration, measured });
    } catch {
      cleanupSucceeded = false;
      success = false;
      failurePhase ||= "cleanup";
    }
  }

  const wallDurationMs =
    startedAt === undefined || finishedAt === undefined
      ? 0
      : Math.max(0, finishedAt - startedAt);
  if (!measured) {
    return withFailurePhase(
      {
        warmup: true,
        success,
        cleanupSucceeded,
        finalStateVerified,
        forbiddenEffectsObserved,
      },
      failurePhase,
    );
  }
  return withFailurePhase(
    {
      warmup: false,
      success,
      cleanupSucceeded,
      finalStateVerified,
      forbiddenEffectsObserved,
      measurements: measurementsFromObservabilityEvents(events, {
        wallDurationMs,
      }),
    },
    failurePhase,
  );
}

function emptyMeasurements() {
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

function sumMeasurements(samples) {
  const totals = emptyMeasurements();
  for (const sample of samples) {
    for (const metric of Object.keys(totals)) {
      totals[metric] += sample.measurements[metric];
    }
  }
  return totals;
}

function failedScenarioResult({
  scenario,
  warmupsCompleted = 0,
  prepared = false,
  finalStateVerified = false,
  forbiddenEffectsObserved = [],
  failurePhase,
} = {}) {
  return withFailurePhase(
    {
      scenarioId: scenario.id,
      success: false,
      finalStateVerified,
      forbiddenEffectsObserved: safeEffectList(forbiddenEffectsObserved),
      measurements: emptyMeasurements(),
      samples: [],
      warmupsCompleted,
      prepared,
      finalizeSucceeded: true,
    },
    failurePhase,
  );
}

async function runWarmups({
  scenario,
  mode,
  plan,
  prepared,
  setup,
  execute,
  verifyFinalState,
  cleanup,
  now,
}) {
  for (let iteration = 0; iteration < plan.warmups; iteration += 1) {
    const warmup = await invokeIteration({
      scenario,
      mode,
      iteration,
      measured: false,
      setup,
      execute,
      verifyFinalState,
      cleanup,
      now,
    });
    if (unsafeSample(warmup)) {
      return failedScenarioResult({
        scenario,
        warmupsCompleted: iteration,
        prepared,
        finalStateVerified: warmup.finalStateVerified,
        forbiddenEffectsObserved: warmup.forbiddenEffectsObserved,
        failurePhase: warmup.failurePhase || "verify",
      });
    }
  }
  return undefined;
}

async function runMeasuredIterations({
  scenario,
  mode,
  plan,
  prepared,
  setup,
  execute,
  verifyFinalState,
  cleanup,
  now,
}) {
  const samples = [];
  for (let iteration = 0; iteration < plan.measured; iteration += 1) {
    const sample = await invokeIteration({
      scenario,
      mode,
      iteration,
      measured: true,
      setup,
      execute,
      verifyFinalState,
      cleanup,
      now,
    });
    samples.push(sample);
    if (unsafeSample(sample)) break;
  }

  const firstUnsafeSample = samples.find((sample) => unsafeSample(sample));
  const result = {
    scenarioId: scenario.id,
    success:
      samples.length === plan.measured &&
      samples.every((sample) => !unsafeSample(sample)),
    finalStateVerified:
      samples.length === plan.measured &&
      samples.every((sample) => sample.finalStateVerified),
    forbiddenEffectsObserved: [
      ...new Set(samples.flatMap((sample) => sample.forbiddenEffectsObserved)),
    ].sort((left, right) => (left > right) - (left < right)),
    measurements: sumMeasurements(samples),
    samples,
    warmupsCompleted: plan.warmups,
    prepared,
    finalizeSucceeded: true,
  };
  if (!result.success) {
    result.failurePhase = firstUnsafeSample?.failurePhase || "verify";
  }
  return result;
}

export async function executeScenario({
  scenario,
  mode,
  disposableTargetVerified = false,
  prepare = async () => {},
  setup = async () => {},
  execute,
  verifyFinalState,
  cleanup = async () => {},
  finalize = async () => {},
  now = () => performance.now(),
}) {
  assertExecutionSafety([scenario], { mode, disposableTargetVerified });
  assertFunction(prepare, "prepare");
  assertFunction(setup, "setup");
  assertFunction(execute, "execute");
  assertFunction(verifyFinalState, "verifyFinalState");
  assertFunction(cleanup, "cleanup");
  assertFunction(finalize, "finalize");
  assertFunction(now, "now");

  const plan = repetitionPlan(scenario, mode);
  let prepared = false;
  let result;

  try {
    await prepare({ scenario, mode });
    prepared = true;
    result = await runWarmups({
      scenario,
      mode,
      plan,
      prepared,
      setup,
      execute,
      verifyFinalState,
      cleanup,
      now,
    });
    if (!result) {
      result = await runMeasuredIterations({
        scenario,
        mode,
        plan,
        prepared,
        setup,
        execute,
        verifyFinalState,
        cleanup,
        now,
      });
    }
  } catch {
    result = failedScenarioResult({
      scenario,
      prepared,
      failurePhase: prepared ? "execute" : "prepare",
    });
  } finally {
    try {
      await finalize({ scenario, mode, prepared });
    } catch {
      if (!result) {
        result = failedScenarioResult({
          scenario,
          prepared,
          failurePhase: "finalize",
        });
      }
      result.success = false;
      result.finalizeSucceeded = false;
      result.failurePhase ||= "finalize";
    }
  }

  return result;
}

export async function executeWorkload({
  scenarios,
  mode,
  disposableTargetVerified = false,
  handlers,
  now,
}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("At least one scenario is required.");
  }
  if (!handlers || typeof handlers !== "object") {
    throw new TypeError("handlers must be an object keyed by scenario id.");
  }

  assertExecutionSafety(scenarios, { mode, disposableTargetVerified });
  for (const scenario of scenarios) {
    if (!handlers[scenario.id]) {
      throw new Error(`No workload handler registered for ${scenario.id}.`);
    }
  }

  const results = [];
  for (const scenario of scenarios) {
    const handler = handlers[scenario.id];
    const result = await executeScenario({
      scenario,
      mode,
      disposableTargetVerified,
      prepare: handler.prepare,
      setup: handler.setup,
      execute: handler.execute,
      verifyFinalState: handler.verifyFinalState,
      cleanup: handler.cleanup,
      finalize: handler.finalize,
      now,
    });
    results.push(result);
    if (!result.success) break;
  }
  return results;
}
