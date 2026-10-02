import assert from "node:assert/strict";
import test from "node:test";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { registerPipelineTools } from "../src/tools/pipeline-tools.mjs";

const PROJECT = "group/project";
const PIPELINE_ID = 2430;
const PIPELINE_PATH = `/projects/group%2Fproject/pipelines/${PIPELINE_ID}`;
const RETRY_PATH = `${PIPELINE_PATH}/retry`;
const JOBS_PATH = `${PIPELINE_PATH}/jobs`;

function retryPipelineHandler() {
  let handler;
  registerPipelineTools((name, _config, candidate) => {
    if (name === "retry_pipeline") handler = candidate;
  });
  assert.equal(typeof handler, "function");
  return handler;
}

function retryArgs() {
  return {
    project: PROJECT,
    pipeline_id: PIPELINE_ID,
  };
}

function apiError(status) {
  return new GitLabApiError(`GitLab API returned ${status}.`, {
    status,
    method: "POST",
    path: RETRY_PATH,
  });
}

test("retry_pipeline preserves successful retry behavior", async () => {
  const calls = [];
  const handler = retryPipelineHandler();

  const result = await handler(
    {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        return { data: { id: PIPELINE_ID, status: "pending" } };
      },
    },
    retryArgs(),
  );

  assert.deepEqual(result, { id: PIPELINE_ID, status: "pending" });
  assert.deepEqual(calls, [{ path: RETRY_PATH, options: { method: "POST" } }]);
});

test("retry_pipeline reports 409 with created retry jobs as mutation-ambiguous", async () => {
  const calls = [];
  const handler = retryPipelineHandler();
  let jobs = [
    { id: 36549, status: "failed" },
    { id: 36551, status: "failed" },
  ];

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          if (path === RETRY_PATH) {
            jobs = [
              { id: 36569, status: "pending" },
              { id: 36568, status: "running" },
              ...jobs,
            ];
            throw apiError(409);
          }
          if (path === PIPELINE_PATH) {
            return { data: { id: PIPELINE_ID, status: "running" } };
          }
          if (path === JOBS_PATH) {
            return { data: jobs };
          }
          throw new Error(`Unexpected path: ${path}`);
        },
      },
      retryArgs(),
    ),
    (error) => {
      assert.match(error.message, /Pipeline retry outcome is ambiguous/u);
      assert.match(error.message, /409/u);
      assert.match(error.message, /4 job\(s\)/u);
      assert.match(error.message, /include_retried=true/u);
      assert.match(error.message, /cannot prove whether this request created/u);
      return true;
    },
  );

  assert.deepEqual(
    jobs.slice(0, 2).map((job) => job.id),
    [36569, 36568],
  );
  assert.deepEqual(calls, [
    { path: RETRY_PATH, options: { method: "POST" } },
    { path: PIPELINE_PATH, options: {} },
    {
      path: JOBS_PATH,
      options: {
        query: { include_retried: true, page: 1, per_page: 100 },
      },
    },
  ]);
});

test("retry_pipeline keeps a 409 ambiguous even when no new job is visible", async () => {
  const handler = retryPipelineHandler();

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          if (path === RETRY_PATH) throw apiError(409);
          if (path === PIPELINE_PATH) {
            return { data: { id: PIPELINE_ID, status: "failed" } };
          }
          if (path === JOBS_PATH) {
            return { data: [{ id: 36549, status: "failed" }] };
          }
          throw new Error(`Unexpected path: ${path}`);
        },
      },
      retryArgs(),
    ),
    /outcome is ambiguous/u,
  );
});

test("retry_pipeline preserves definitive 4xx rejections", async () => {
  const calls = [];
  const handler = retryPipelineHandler();
  const denied = apiError(403);

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          throw denied;
        },
      },
      retryArgs(),
    ),
    (error) => error === denied,
  );

  assert.deepEqual(calls, [{ path: RETRY_PATH, options: { method: "POST" } }]);
});

test("retry_pipeline treats response loss, 408, and 5xx as mutation-ambiguous", async (t) => {
  for (const failure of [
    new Error("socket reset"),
    apiError(408),
    apiError(500),
  ]) {
    await t.test(failure.message, async () => {
      const handler = retryPipelineHandler();

      await assert.rejects(
        handler(
          {
            request: async (path) => {
              if (path === RETRY_PATH) throw failure;
              if (path === PIPELINE_PATH) {
                return { data: { id: PIPELINE_ID, status: "failed" } };
              }
              if (path === JOBS_PATH) {
                return { data: [{ id: 36549, status: "failed" }] };
              }
              throw new Error(`Unexpected path: ${path}`);
            },
          },
          retryArgs(),
        ),
        (error) => {
          assert.match(error.message, /outcome is ambiguous/u);
          assert.match(error.message, /include_retried=true/u);
          return true;
        },
      );
    });
  }
});

test("retry_pipeline reports failed reconciliation without issuing another mutation", async () => {
  const calls = [];
  const handler = retryPipelineHandler();

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          if (path === RETRY_PATH) throw apiError(409);
          if (path === PIPELINE_PATH) {
            throw new Error("postflight connection reset");
          }
          throw new Error(`Unexpected path: ${path}`);
        },
      },
      retryArgs(),
    ),
    (error) => {
      assert.match(error.message, /outcome is ambiguous/u);
      assert.match(error.message, /postflight verification failed/u);
      assert.match(error.message, /Re-read pipeline 2430/u);
      return true;
    },
  );

  assert.deepEqual(calls, [
    { path: RETRY_PATH, options: { method: "POST" } },
    { path: PIPELINE_PATH, options: {} },
  ]);
});
