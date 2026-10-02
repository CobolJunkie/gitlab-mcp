import assert from "node:assert/strict";

import {
  cleanupPipelineFixture,
  createPipelineFixture,
  waitForPipeline,
} from "./workload-live-fixtures.mjs";

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

async function cleanupOperations(label, operations) {
  const errors = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${label} encountered multiple failures.`);
  }
}

async function resolveEnvironment(session, environmentName) {
  const result = await session.call("list_environments", {
    project: session.project,
    search: environmentName,
    page: 1,
    per_page: 20,
  });
  const matches = rows(result).filter(
    (entry) => entry?.name === environmentName,
  );
  assert.equal(
    matches.length,
    1,
    `Expected exactly one benchmark environment named ${environmentName}.`,
  );
  assert.ok(
    Number.isSafeInteger(matches[0].id) && matches[0].id > 0,
    "Benchmark environment must expose a positive numeric ID.",
  );
  return matches[0];
}

async function resolveOwnedEnvironment(
  session,
  pipelineFixture,
  environmentName,
) {
  const environment = await resolveEnvironment(session, environmentName);
  const result = await session.call("list_deployments", {
    project: session.project,
    environment: environmentName,
    ref: pipelineFixture.branch,
    page: 1,
    per_page: 100,
  });
  const matches = rows(result).filter(
    (entry) =>
      entry?.environment?.id === environment.id &&
      entry?.ref === pipelineFixture.branch &&
      entry?.sha === pipelineFixture.commit?.id &&
      entry?.status === "success",
  );
  assert.equal(
    matches.length,
    1,
    `Expected exactly one successful benchmark deployment for ${environmentName}.`,
  );
  assert.ok(
    Number.isSafeInteger(matches[0].id) && matches[0].id > 0,
    "Benchmark deployment must expose a positive numeric ID.",
  );
  return { environment, deployment: matches[0] };
}

export async function cleanupDeploymentFixture(session, fixture) {
  if (!fixture) return;
  const operations = [];
  if (fixture.environment?.id && fixture.deployment?.id) {
    operations.push(() =>
      session.cleanupBenchmarkEnvironment({
        environmentId: fixture.environment.id,
        environmentName: fixture.environmentName,
      }),
    );
  }
  operations.push(() =>
    cleanupPipelineFixture(session, fixture.pipelineFixture),
  );
  await cleanupOperations("Deployment fixture cleanup", operations);
}

export async function createDeploymentFixture(
  session,
  { label, environmentName, ciYaml },
) {
  const fixture = { environmentName };
  try {
    fixture.pipelineFixture = await createPipelineFixture(
      session,
      label,
      ciYaml,
    );
    await waitForPipeline(
      session,
      fixture.pipelineFixture.pipeline.id,
      "success",
    );
    const owned = await resolveOwnedEnvironment(
      session,
      fixture.pipelineFixture,
      environmentName,
    );
    fixture.environment = owned.environment;
    fixture.deployment = owned.deployment;
    return fixture;
  } catch (error) {
    if (!fixture.environment && fixture.pipelineFixture) {
      try {
        const owned = await resolveOwnedEnvironment(
          session,
          fixture.pipelineFixture,
          environmentName,
        );
        fixture.environment = owned.environment;
        fixture.deployment = owned.deployment;
      } catch {
        // Cleanup must not guess an environment without exact deployment provenance.
      }
    }
    try {
      await cleanupDeploymentFixture(session, fixture);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Deployment fixture setup failed and cleanup could not be completed.",
      );
    }
    throw error;
  }
}
