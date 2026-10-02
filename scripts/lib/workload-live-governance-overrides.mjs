import assert from "node:assert/strict";

import { fixtureLabel } from "./workload-live-fixtures.mjs";

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

function successVerification() {
  return { verified: true, forbiddenEffectsObserved: [] };
}

function isNotFound(error) {
  return error?.result?.status === 404 || error?.status === 404;
}

async function ignoreNotFound(operation) {
  try {
    return await operation();
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function matchesBranchRef(ref, branch) {
  return ref === branch || ref === `refs/heads/${branch}`;
}

function ciLintHandler(session) {
  return {
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const result = await session.call("lint_ci_configuration", {
          project: session.project,
          content:
            'image: node:22-alpine\nbenchmark:\n  script: ["echo BENCHMARK_LINT_OK"]\n',
          ref: session.defaultBranch,
          dry_run: true,
          include_jobs: true,
        });
        assert.equal(
          result?.valid,
          true,
          "Benchmark CI fixture must lint valid.",
        );
        assert.deepEqual(result?.errors || [], []);
      }),
    verifyFinalState: async () => successVerification(),
  };
}

function scheduleHandler(session) {
  let schedule;
  let created = false;
  const description = `BENCH ${fixtureLabel(session, "governance.schedules")}`;

  return {
    prepare: async () => {
      schedule = await session.call("create_pipeline_schedule", {
        project: session.project,
        description,
        ref: session.defaultBranch,
        cron: "0 0 1 1 *",
        cron_timezone: "UTC",
        active: false,
      });
      created = true;
      assert.ok(
        Number.isSafeInteger(schedule?.id) && schedule.id > 0,
        "Benchmark schedule fixture must return a positive ID.",
      );
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const schedules = await session.call("list_pipeline_schedules", {
          project: session.project,
          page: 1,
          per_page: 100,
        });
        const target = rows(schedules).find(
          (entry) => entry.id === schedule.id,
        );
        assert.equal(target?.description, description);
        assert.equal(
          matchesBranchRef(target?.ref, session.defaultBranch),
          true,
        );
        assert.equal(target?.active, false);
      }),
    verifyFinalState: async () => {
      const current = await session.call("get_pipeline_schedule", {
        project: session.project,
        pipeline_schedule_id: schedule.id,
      });
      return {
        verified:
          current?.id === schedule.id &&
          current?.description === description &&
          matchesBranchRef(current?.ref, session.defaultBranch) &&
          current?.active === false,
        forbiddenEffectsObserved: [],
      };
    },
    finalize: async () => {
      if (!created || !Number.isSafeInteger(schedule?.id)) return;
      await ignoreNotFound(() =>
        session.call("delete_pipeline_schedule", {
          project: session.project,
          pipeline_schedule_id: schedule.id,
        }),
      );
      created = false;
      schedule = undefined;
    },
  };
}

function variableHandler(session) {
  let created = false;
  const key = `BENCHMARK_METADATA_${fixtureLabel(
    session,
    "governance.variables",
  )}`
    .replace(/\W/g, "_")
    .toUpperCase();
  const value = "benchmark-non-secret-metadata";

  return {
    prepare: async () => {
      await session.call("create_project_ci_variable", {
        project: session.project,
        key,
        value,
        protected: false,
        masked: false,
        raw: false,
        environment_scope: "*",
      });
      created = true;
    },
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const variables = await session.call("list_project_ci_variables", {
          project: session.project,
          page: 1,
          per_page: 100,
        });
        const target = rows(variables).find((entry) => entry.key === key);
        assert.ok(target, "Benchmark variable metadata must be listed.");
        assert.equal(Object.hasOwn(target, "value"), false);
        assert.equal(target?.environment_scope, "*");
      }),
    verifyFinalState: async () => {
      const current = await session.call("get_project_ci_variable", {
        project: session.project,
        key,
        filter_environment_scope: "*",
      });
      return {
        verified:
          current?.key === key &&
          current?.environment_scope === "*" &&
          Object.hasOwn(current || {}, "value") === false,
        forbiddenEffectsObserved: Object.hasOwn(current || {}, "value")
          ? ["secret_exposure"]
          : [],
      };
    },
    finalize: async () => {
      if (!created) return;
      await ignoreNotFound(() =>
        session.call("delete_project_ci_variable", {
          project: session.project,
          key,
          filter_environment_scope: "*",
        }),
      );
      created = false;
    },
  };
}

export function applyGovernanceWorkloadOverrides(session, handlers) {
  handlers["ci.lint"] = ciLintHandler(session);
  handlers["governance.schedules"] = scheduleHandler(session);
  handlers["governance.variables"] = variableHandler(session);
  return handlers;
}
