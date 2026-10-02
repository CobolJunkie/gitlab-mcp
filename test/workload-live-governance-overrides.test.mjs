import assert from "node:assert/strict";
import test from "node:test";

import { applyGovernanceWorkloadOverrides } from "../scripts/lib/workload-live-governance-overrides.mjs";

function baseSession(call) {
  return {
    project: 42,
    defaultBranch: "main",
    runId: "bench-governance",
    call,
    measured(_observe, operation) {
      return operation();
    },
  };
}

test("CI lint override rejects an invalid HTTP-200 lint result", async () => {
  const session = baseSession(async (name) => {
    assert.equal(name, "lint_ci_configuration");
    return { valid: false, errors: ["invalid fixture"] };
  });
  const handler = applyGovernanceWorkloadOverrides(session, {
    "ci.lint": { marker: "old" },
  })["ci.lint"];

  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /must lint valid/,
  );
});

test("schedule read accepts GitLab's canonical branch ref and cleans the fixture", async () => {
  const calls = [];
  const schedule = {
    id: 7,
    description: "BENCH bench-governance-governance-schedules",
    ref: "refs/heads/main",
    active: false,
  };
  const session = baseSession(async (name, args = {}) => {
    calls.push({ name, args });
    if (name === "create_pipeline_schedule") return schedule;
    if (name === "list_pipeline_schedules") return { data: [schedule] };
    if (name === "get_pipeline_schedule") return schedule;
    if (name === "delete_pipeline_schedule") return {};
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyGovernanceWorkloadOverrides(session, {
    "governance.schedules": { marker: "old" },
  })["governance.schedules"];

  await handler.prepare();
  await handler.execute({ observe: () => {} });
  assert.equal((await handler.verifyFinalState()).verified, true);
  await handler.finalize();

  const create = calls.find(({ name }) => name === "create_pipeline_schedule");
  assert.equal(create.args.ref, "main");
  assert.equal(create.args.active, false);
  assert.equal(
    calls.some(({ name }) => name === "delete_pipeline_schedule"),
    true,
  );
});

test("variable read proves metadata is present without exposing its value", async () => {
  const calls = [];
  let variable;
  const session = baseSession(async (name, args = {}) => {
    calls.push({ name, args });
    if (name === "create_project_ci_variable") {
      variable = {
        key: args.key,
        environment_scope: "*",
        protected: false,
        masked: false,
      };
      return variable;
    }
    if (name === "list_project_ci_variables") return { data: [variable] };
    if (name === "get_project_ci_variable") return variable;
    if (name === "delete_project_ci_variable") return {};
    assert.fail(`Unexpected tool call: ${name}`);
  });
  const handler = applyGovernanceWorkloadOverrides(session, {
    "governance.variables": { marker: "old" },
  })["governance.variables"];

  await handler.prepare();
  await handler.execute({ observe: () => {} });
  assert.equal((await handler.verifyFinalState()).verified, true);
  await handler.finalize();

  assert.equal(Object.hasOwn(variable, "value"), false);
  assert.equal(
    calls.some(({ name }) => name === "delete_project_ci_variable"),
    true,
  );
});
