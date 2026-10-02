import assert from "node:assert/strict";
import test from "node:test";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { registerDeploymentTools } from "../src/tools/deployment-tools.mjs";

const PROJECT = "group/project";
const ENVIRONMENT_ID = 17;
const ENVIRONMENT_NAME = "review/contract";
const ENVIRONMENT_PATH = `/projects/group%2Fproject/environments/${ENVIRONMENT_ID}`;

function stopEnvironmentHandler() {
  let handler;
  registerDeploymentTools((name, _config, candidate) => {
    if (name === "stop_environment") handler = candidate;
  });
  return handler;
}

function apiError(status, method, path) {
  return new GitLabApiError(`GitLab API returned ${status}.`, {
    status,
    method,
    path,
  });
}

function args() {
  return {
    project: PROJECT,
    environment_id: ENVIRONMENT_ID,
    expected_environment_name: ENVIRONMENT_NAME,
    force: true,
    acknowledge_environment_stop: true,
  };
}

test("stop_environment treats disappearance after preflight as idempotent cleanup", async () => {
  const calls = [];
  const handler = stopEnvironmentHandler();
  const result = await handler(
    {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        if (calls.length === 1) {
          return {
            data: {
              id: ENVIRONMENT_ID,
              name: ENVIRONMENT_NAME,
              state: "available",
            },
          };
        }
        throw apiError(404, options.method, path);
      },
    },
    args(),
  );

  assert.deepEqual(calls, [
    { path: ENVIRONMENT_PATH, options: {} },
    {
      path: `${ENVIRONMENT_PATH}/stop`,
      options: { method: "POST", body: { force: true } },
    },
    { path: ENVIRONMENT_PATH, options: {} },
  ]);
  assert.deepEqual(result, {
    environment_id: ENVIRONMENT_ID,
    environment_name: ENVIRONMENT_NAME,
    state: "absent",
    outcome: "already_absent_after_preflight",
    changed: false,
  });
});

test("stop_environment preserves a mutation 404 when the target still exists", async () => {
  let calls = 0;
  const handler = stopEnvironmentHandler();

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls += 1;
          if (calls === 1 || calls === 3) {
            return {
              data: {
                id: ENVIRONMENT_ID,
                name: ENVIRONMENT_NAME,
                state: "available",
              },
            };
          }
          throw apiError(404, options.method, path);
        },
      },
      args(),
    ),
    (error) => error instanceof GitLabApiError && error.status === 404,
  );
  assert.equal(calls, 3);
});

test("stop_environment still propagates non-idempotent mutation failures", async () => {
  let calls = 0;
  const handler = stopEnvironmentHandler();

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls += 1;
          if (calls === 1) {
            return {
              data: {
                id: ENVIRONMENT_ID,
                name: ENVIRONMENT_NAME,
                state: "available",
              },
            };
          }
          throw apiError(403, options.method, path);
        },
      },
      args(),
    ),
    (error) => error instanceof GitLabApiError && error.status === 403,
  );
  assert.equal(calls, 2);
});
