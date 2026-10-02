import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";
import { registerDeploymentTools } from "../src/tools/deployment-tools.mjs";

const PROJECT = "group/project";
const ENVIRONMENT_ID = 17;
const ENVIRONMENT_NAME = "review/contract";
const ENVIRONMENT_PATH = `/projects/group%2Fproject/environments/${ENVIRONMENT_ID}`;

function lifecycleTools() {
  const registrations = new Map();
  registerDeploymentTools((name, config, handler) => {
    registrations.set(name, { config, handler });
  });
  return registrations;
}

function environment(state = "available") {
  return {
    id: ENVIRONMENT_ID,
    name: ENVIRONMENT_NAME,
    state,
  };
}

function apiError(status, method = "GET", path = ENVIRONMENT_PATH) {
  return new GitLabApiError(`GitLab API returned ${status}.`, {
    status,
    method,
    path,
  });
}

function args(extra = {}) {
  return {
    project: PROJECT,
    environment_id: ENVIRONMENT_ID,
    expected_environment_name: ENVIRONMENT_NAME,
    ...extra,
  };
}

async function listedTools({ readOnly }) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    readOnly,
    clientFactory: () => ({
      request: async () => ({ data: {} }),
    }),
  });
  const client = new Client({
    name: "environment-lifecycle-test",
    version: "1.0.0",
  });
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

test("list_deployments preserves GitLab-supported server filters when ref is omitted", async () => {
  const calls = [];
  const { config, handler } = lifecycleTools().get("list_deployments");

  assert.equal(config.inputSchema.order_by.safeParse("ref").success, true);

  const result = await handler(
    {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        return { data: [], pagination: { page: 2, perPage: 50 } };
      },
    },
    {
      project: PROJECT,
      order_by: "ref",
      sort: "desc",
      status: "success",
      environment: "production",
      updated_after: "2026-09-01T00:00:00Z",
      updated_before: "2026-09-30T23:59:59Z",
      finished_after: "2026-09-01T00:00:00Z",
      finished_before: "2026-09-30T23:59:59Z",
      page: 2,
      per_page: 50,
    },
  );

  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/deployments",
      options: {
        query: {
          order_by: "ref",
          sort: "desc",
          status: "success",
          environment: "production",
          updated_after: "2026-09-01T00:00:00Z",
          updated_before: "2026-09-30T23:59:59Z",
          finished_after: "2026-09-01T00:00:00Z",
          finished_before: "2026-09-30T23:59:59Z",
          page: 2,
          per_page: 50,
        },
      },
    },
  ]);
  assert.deepEqual(result, {
    data: [],
    pagination: { page: 2, perPage: 50 },
  });
});

test("list_deployments ref filtering returns an empty page for an impossible ref", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async () => ({
        data: [{ id: 1, ref: "main" }],
        pagination: {
          page: 1,
          perPage: 100,
          total: 1,
          totalPages: 1,
        },
      }),
    },
    {
      project: PROJECT,
      ref: "__audit_ref_that_does_not_exist__",
    },
  );

  assert.deepEqual(result, {
    data: [],
    pagination: {
      page: 1,
      perPage: 20,
      total: 0,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering omits previous page when requested page is out of range", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async () => ({
        data: [{ id: 1, ref: "release/v1" }],
        pagination: {
          page: 1,
          perPage: 100,
          total: 1,
          totalPages: 1,
        },
      }),
    },
    {
      project: PROJECT,
      ref: "release/v1",
      page: 100,
      per_page: 20,
    },
  );

  assert.deepEqual(result, {
    data: [],
    pagination: {
      page: 100,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments implements ref filtering across complete upstream pagination", async () => {
  const calls = [];
  const { handler } = lifecycleTools().get("list_deployments");
  const pages = new Map([
    [
      1,
      {
        data: [
          { id: 1, ref: "other" },
          { id: 2, ref: "release/v1" },
          { id: 3, ref: "release/v1" },
        ],
        pagination: { page: 1, perPage: 100, nextPage: 2, totalPages: 2 },
      },
    ],
    [
      2,
      {
        data: [
          { id: 4, ref: "release/v1" },
          { id: 5, ref: "other" },
        ],
        pagination: { page: 2, perPage: 100, totalPages: 2 },
      },
    ],
  ]);

  const result = await handler(
    {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        return pages.get(options.query.page);
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
      order_by: "ref",
      sort: "desc",
      status: "success",
      environment: "production",
      page: 2,
      per_page: 2,
    },
  );

  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.path, "/projects/group%2Fproject/deployments");
    assert.equal(call.options.query.ref, undefined);
    assert.equal(call.options.query.page, index + 1);
    assert.equal(call.options.query.per_page, 100);
    assert.equal(call.options.query.order_by, "ref");
    assert.equal(call.options.query.status, "success");
    assert.equal(call.options.query.environment, "production");
  }
  assert.deepEqual(result, {
    data: [{ id: 4, ref: "release/v1" }],
    pagination: {
      page: 2,
      perPage: 2,
      previousPage: 1,
      total: 3,
      totalPages: 2,
    },
  });
});

test("list_deployments ref filtering trusts explicit total-pages exhaustion over a full final page", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async (_path, options = {}) => {
        calls += 1;
        const pageNumber = options.query.page;
        return {
          data: Array.from({ length: 100 }, (_, index) => ({
            id: (pageNumber - 1) * 100 + index + 1,
            ref: pageNumber === 100 && index === 99 ? "release/v1" : "other",
          })),
          pagination: {
            page: pageNumber,
            perPage: 100,
            totalPages: 100,
          },
        };
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 100);
  assert.deepEqual(result, {
    data: [{ id: 10_000, ref: "release/v1" }],
    pagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
  });
});

test("list_deployments ref filtering continues after a full page with sparse pagination metadata", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async (_path, options = {}) => {
        calls += 1;
        if (options.query.page === 1) {
          return {
            data: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              ref: index === 99 ? "release/v1" : "other",
            })),
            pagination: { page: 1, perPage: 100 },
          };
        }
        return {
          data: [],
          pagination: { page: 2, perPage: 100 },
        };
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result, {
    data: [{ id: 100, ref: "release/v1" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering follows explicit total-pages through a sparse intermediate page", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async (_path, options = {}) => {
        calls += 1;
        if (options.query.page === 1) {
          return {
            data: [{ id: 1, ref: "other" }],
            pagination: {
              page: 1,
              perPage: 100,
              totalPages: 2,
            },
          };
        }
        return {
          data: [{ id: 2, ref: "release/v1" }],
          pagination: {
            page: 2,
            perPage: 100,
            totalPages: 2,
          },
        };
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result, {
    data: [{ id: 2, ref: "release/v1" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering accepts a sparse partial 100th page as terminal", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async (_path, options = {}) => {
        calls += 1;
        const pageNumber = options.query.page;
        const finalPage = pageNumber === 100;
        return {
          data: Array.from({ length: finalPage ? 1 : 100 }, (_, index) => ({
            id: (pageNumber - 1) * 100 + index + 1,
            ref: finalPage ? "release/v1" : "other",
          })),
          pagination: {
            page: pageNumber,
            perPage: 100,
          },
        };
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 100);
  assert.deepEqual(result, {
    data: [{ id: 9_901, ref: "release/v1" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering rejects scan pages that exceed the requested 100-row ceiling", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  for (const response of [
    {
      data: Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        ref: "other",
      })),
      pagination: { page: 1 },
    },
    {
      data: Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        ref: "other",
      })),
      pagination: { page: 1, perPage: 101 },
    },
  ]) {
    await assert.rejects(
      handler(
        {
          request: async () => response,
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /invalid upstream pagination/u,
    );
  }
});

test("list_deployments ref filtering rejects rows without a valid ref", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  for (const deployment of [
    null,
    {},
    { id: 1 },
    { id: 1, ref: null },
    { id: 1, ref: 123 },
  ]) {
    await assert.rejects(
      handler(
        {
          request: async () => ({
            data: [deployment],
            pagination: {
              page: 1,
              perPage: 100,
              total: 1,
              totalPages: 1,
            },
          }),
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /deployment without a valid ref/u,
    );
  }
});

test("list_deployments ref filtering rejects a malformed upstream data payload", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  for (const data of [undefined, null, {}]) {
    await assert.rejects(
      handler(
        {
          request: async () => ({ data }),
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /invalid upstream response/u,
    );
  }
});

test("list_deployments ref filtering rejects skipped and mismatched upstream pages", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  for (const pagination of [
    { page: 1, perPage: 100, nextPage: 3 },
    { page: 2, perPage: 100, totalPages: 2 },
    { page: 2, perPage: 100, nextPage: 2 },
    { page: 1, perPage: 100, totalPages: 0 },
  ]) {
    await assert.rejects(
      handler(
        {
          request: async () => ({
            data: [{ id: 1, ref: "release/v1" }],
            pagination,
          }),
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /invalid upstream pagination/u,
    );
  }
});

test("list_deployments ref filtering uses derived total pages when total-pages is omitted", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async () => {
        calls += 1;
        return {
          data: [{ id: 1, ref: "release/v1" }],
          pagination: { page: 1, perPage: 100, total: 1 },
        };
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    data: [{ id: 1, ref: "release/v1" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering rejects next-page metadata beyond a derived total", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  await assert.rejects(
    handler(
      {
        request: async () => ({
          data: [{ id: 1, ref: "release/v1" }],
          pagination: {
            page: 1,
            perPage: 100,
            total: 1,
            nextPage: 2,
          },
        }),
      },
      {
        project: PROJECT,
        ref: "release/v1",
      },
    ),
    /invalid upstream pagination/u,
  );
});

test("list_deployments ref filtering rejects contradictory total pagination metadata", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  for (const pagination of [
    { page: 1, perPage: 100, total: 101, totalPages: 1 },
    { page: 1, perPage: 100, total: 0, totalPages: 2 },
    { page: 1, perPage: 0, total: 1, totalPages: 1 },
    { page: 1, perPage: 100, total: -1, totalPages: 1 },
  ]) {
    await assert.rejects(
      handler(
        {
          request: async () => ({
            data: [{ id: 1, ref: "release/v1" }],
            pagination,
          }),
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /(?:invalid upstream pagination|inconsistent upstream pagination totals)/u,
    );
  }
});

test("list_deployments ref filtering rejects an incomplete terminal page against upstream total", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  await assert.rejects(
    handler(
      {
        request: async (_path, options = {}) => {
          if (options.query.page === 1) {
            return {
              data: Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                ref: "other",
              })),
              pagination: {
                page: 1,
                perPage: 100,
                total: 102,
                totalPages: 2,
                nextPage: 2,
              },
            };
          }
          return {
            data: [{ id: 101, ref: "other" }],
            pagination: {
              page: 2,
              perPage: 100,
              total: 102,
              totalPages: 2,
            },
          };
        },
      },
      {
        project: PROJECT,
        ref: "release/v1",
      },
    ),
    /incomplete upstream pagination/u,
  );
});

test("list_deployments ref filtering rejects pagination totals that change during the scan", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  await assert.rejects(
    handler(
      {
        request: async (_path, options = {}) => ({
          data: [{ id: options.query.page, ref: "release/v1" }],
          pagination:
            options.query.page === 1
              ? {
                  page: 1,
                  perPage: 1,
                  total: 2,
                  nextPage: 2,
                }
              : {
                  page: 2,
                  perPage: 1,
                  total: 3,
                  nextPage: 3,
                },
        }),
      },
      {
        project: PROJECT,
        ref: "release/v1",
      },
    ),
    /inconsistent upstream pagination totals/u,
  );
});

test("list_deployments ref filtering carries reported per-page metadata across sparse later pages", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const pages = new Map([
    [
      1,
      {
        data: [
          { id: 1, ref: "other" },
          { id: 2, ref: "other" },
        ],
        pagination: { page: 1, perPage: 2 },
      },
    ],
    [
      2,
      {
        data: [
          { id: 3, ref: "other" },
          { id: 4, ref: "other" },
        ],
        pagination: { page: 2 },
      },
    ],
    [
      3,
      {
        data: [{ id: 5, ref: "release/v1" }],
        pagination: { page: 3 },
      },
    ],
  ]);

  const result = await handler(
    {
      request: async (_path, options = {}) => {
        calls += 1;
        return pages.get(options.query.page);
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(result, {
    data: [{ id: 5, ref: "release/v1" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering rejects changing per-page or total-page metadata", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  for (const secondPagePagination of [
    { page: 2, perPage: 3 },
    { page: 2, perPage: 2, totalPages: 3 },
  ]) {
    await assert.rejects(
      handler(
        {
          request: async (_path, options = {}) =>
            options.query.page === 1
              ? {
                  data: [
                    { id: 1, ref: "other" },
                    { id: 2, ref: "other" },
                  ],
                  pagination: {
                    page: 1,
                    perPage: 2,
                    totalPages: 2,
                    nextPage: 2,
                  },
                }
              : {
                  data: [{ id: 3, ref: "release/v1" }],
                  pagination: secondPagePagination,
                },
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /inconsistent upstream pagination metadata/u,
    );
  }
});

test("list_deployments ref filtering honors sparse reported per-page metadata", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            data: [
              { id: 1, ref: "release/v1" },
              { id: 2, ref: "other" },
            ],
            pagination: { perPage: 2 },
          };
        }
        return {
          data: [],
          pagination: { perPage: 2 },
        };
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result, {
    data: [{ id: 1, ref: "release/v1" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering rejects an empty terminal page in a multi-page result", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  await assert.rejects(
    handler(
      {
        request: async (_path, options = {}) =>
          options.query.page === 1
            ? {
                data: [{ id: 1, ref: "other" }],
                pagination: {
                  page: 1,
                  perPage: 1,
                  totalPages: 2,
                  nextPage: 2,
                },
              }
            : {
                data: [],
                pagination: {
                  page: 2,
                  perPage: 1,
                  totalPages: 2,
                },
              },
      },
      {
        project: PROJECT,
        ref: "release/v1",
      },
    ),
    /empty terminal page for a multi-page result/u,
  );
});

test("list_deployments ref filtering rejects empty pages with contradictory next-page metadata", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  await assert.rejects(
    handler(
      {
        request: async () => ({
          data: [],
          pagination: { page: 1, perPage: 100, nextPage: 2 },
        }),
      },
      {
        project: PROJECT,
        ref: "release/v1",
      },
    ),
    /empty page with more upstream pages reported/u,
  );
});

test("list_deployments ref filtering fails fast when metadata proves the scan bound is exceeded", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  for (const pagination of [
    {
      page: 1,
      perPage: 100,
      total: 10_001,
      totalPages: 101,
      nextPage: 2,
    },
    {
      page: 1,
      perPage: 100,
      total: 10_001,
      nextPage: 2,
    },
  ]) {
    calls = 0;
    await assert.rejects(
      handler(
        {
          request: async () => {
            calls += 1;
            return {
              data: Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                ref: "other",
              })),
              pagination,
            };
          },
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /exceeded the bounded scan of 100 pages/u,
    );
    assert.equal(calls, 1);
  }
});

test("list_deployments ref filtering rejects continuation after consuming the stable total", async () => {
  const { handler } = lifecycleTools().get("list_deployments");

  for (const pagination of [
    {
      page: 1,
      total: 1,
      nextPage: 2,
    },
    {
      page: 1,
      total: 1,
      totalPages: 2,
    },
  ]) {
    await assert.rejects(
      handler(
        {
          request: async () => ({
            data: [{ id: 1, ref: "release/v1" }],
            pagination,
          }),
        },
        {
          project: PROJECT,
          ref: "release/v1",
        },
      ),
      /continuation after exhausting the upstream total/u,
    );
  }
});

test("list_deployments ref filtering accepts a stable total that proves exhaustion at the scan bound", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  const result = await handler(
    {
      request: async (_path, options = {}) => {
        calls += 1;
        const pageNumber = options.query.page;
        return {
          data: Array.from({ length: 100 }, (_, index) => ({
            id: (pageNumber - 1) * 100 + index + 1,
            ref: pageNumber === 100 && index === 99 ? "release/v1" : "other",
          })),
          pagination: {
            page: pageNumber,
            total: 10_000,
          },
        };
      },
    },
    {
      project: PROJECT,
      ref: "release/v1",
    },
  );

  assert.equal(calls, 100);
  assert.deepEqual(result, {
    data: [{ id: 10_000, ref: "release/v1" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
});

test("list_deployments ref filtering fails closed when its bounded scan cannot prove exhaustion", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("list_deployments");

  await assert.rejects(
    handler(
      {
        request: async (_path, options = {}) => {
          calls += 1;
          return {
            data: Array.from({ length: 100 }, (_, index) => ({
              id: (options.query.page - 1) * 100 + index + 1,
              ref: "other",
            })),
            pagination: {
              page: options.query.page,
              perPage: 100,
              nextPage: options.query.page + 1,
            },
          };
        },
      },
      {
        project: PROJECT,
        ref: "release/v1",
      },
    ),
    /exceeded the bounded scan of 100 pages/u,
  );
  assert.equal(calls, 100);
});

test("environment lifecycle tools have explicit idempotent safety classes", () => {
  const tools = lifecycleTools();
  assert.deepEqual(tools.get("stop_environment").config.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(tools.get("delete_environment").config.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
});

test("stop_environment preflights exact identity before stopping", async () => {
  const calls = [];
  const { handler } = lifecycleTools().get("stop_environment");
  const result = await handler(
    {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        if (calls.length === 1) return { data: environment("available") };
        return { data: environment("stopped") };
      },
    },
    args({ force: true, acknowledge_environment_stop: true }),
  );

  assert.deepEqual(calls, [
    { path: ENVIRONMENT_PATH, options: {} },
    {
      path: `${ENVIRONMENT_PATH}/stop`,
      options: { method: "POST", body: { force: true } },
    },
  ]);
  assert.deepEqual(result, {
    environment_id: ENVIRONMENT_ID,
    environment_name: ENVIRONMENT_NAME,
    state: "stopped",
    outcome: "stopped",
    changed: true,
  });
});

test("stop_environment reports an initiated asynchronous stop consistently", async () => {
  let calls = 0;
  const { handler } = lifecycleTools().get("stop_environment");
  const result = await handler(
    {
      request: async () => {
        calls += 1;
        return {
          data:
            calls === 1 ? environment("available") : environment("stopping"),
        };
      },
    },
    args({ acknowledge_environment_stop: true }),
  );

  assert.equal(calls, 2);
  assert.deepEqual(result, {
    environment_id: ENVIRONMENT_ID,
    environment_name: ENVIRONMENT_NAME,
    state: "stopping",
    outcome: "stop_in_progress",
    changed: true,
  });
});

test("stop_environment rejects unexpected mutation response states", async () => {
  const { handler } = lifecycleTools().get("stop_environment");

  for (const mutationResult of [
    environment("available"),
    { id: ENVIRONMENT_ID, name: ENVIRONMENT_NAME },
  ]) {
    let calls = 0;
    await assert.rejects(
      handler(
        {
          request: async () => {
            calls += 1;
            if (calls === 1) return { data: environment("available") };
            return { data: mutationResult };
          },
        },
        args({ acknowledge_environment_stop: true }),
      ),
      /unexpected state/u,
    );
    assert.equal(calls, 2);
  }
});

test("stop_environment rejects an identity mismatch before mutation", async () => {
  const calls = [];
  const { handler } = lifecycleTools().get("stop_environment");

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          return {
            data: { ...environment(), name: "production" },
          };
        },
      },
      args({ acknowledge_environment_stop: true }),
    ),
    /expected name.*review\/contract.*production/u,
  );
  assert.equal(calls.length, 1);
});

test("stop_environment is idempotent for stopped, stopping, and absent targets", async () => {
  const { handler } = lifecycleTools().get("stop_environment");
  for (const [state, outcome] of [
    ["stopped", "already_stopped"],
    ["stopping", "stop_in_progress"],
  ]) {
    let calls = 0;
    const result = await handler(
      {
        request: async () => {
          calls += 1;
          return { data: environment(state) };
        },
      },
      args({ acknowledge_environment_stop: true }),
    );
    assert.equal(calls, 1);
    assert.equal(result.changed, false);
    assert.equal(result.outcome, outcome);
    assert.equal(result.state, state);
  }

  const missing = await handler(
    {
      request: async () => {
        throw apiError(404);
      },
    },
    args({ acknowledge_environment_stop: true }),
  );
  assert.deepEqual(missing, {
    environment_id: ENVIRONMENT_ID,
    environment_name: ENVIRONMENT_NAME,
    state: "absent",
    outcome: "already_absent",
    changed: false,
  });
});

test("stop_environment rejects unsupported states without mutation", async () => {
  const calls = [];
  const { handler } = lifecycleTools().get("stop_environment");

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          return { data: environment("preparing") };
        },
      },
      args({ acknowledge_environment_stop: true }),
    ),
    /unsupported state "preparing"/u,
  );
  assert.equal(calls.length, 1);
});

test("delete_environment requires an exact stopped target", async () => {
  const calls = [];
  const { handler } = lifecycleTools().get("delete_environment");

  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          return { data: environment("available") };
        },
      },
      args({ acknowledge_environment_deletion: true }),
    ),
    /requires state "stopped"/u,
  );
  assert.equal(calls.length, 1);

  calls.length = 0;
  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls.push({ path, options });
          return { data: { ...environment("stopped"), name: "production" } };
        },
      },
      args({ acknowledge_environment_deletion: true }),
    ),
    /expected name/u,
  );
  assert.equal(calls.length, 1);
});

test("delete_environment deletes a stopped target and bounds the result", async () => {
  const calls = [];
  const { handler } = lifecycleTools().get("delete_environment");
  const result = await handler(
    {
      request: async (path, options = {}) => {
        calls.push({ path, options });
        if (calls.length === 1) return { data: environment("stopped") };
        return { data: null };
      },
    },
    args({ acknowledge_environment_deletion: true }),
  );

  assert.deepEqual(calls, [
    { path: ENVIRONMENT_PATH, options: {} },
    { path: ENVIRONMENT_PATH, options: { method: "DELETE" } },
  ]);
  assert.deepEqual(result, {
    environment_id: ENVIRONMENT_ID,
    environment_name: ENVIRONMENT_NAME,
    state: "absent",
    outcome: "deleted",
    changed: true,
  });
});

test("delete_environment treats missing and concurrent deletion as idempotent cleanup", async () => {
  const { handler } = lifecycleTools().get("delete_environment");

  const missing = await handler(
    {
      request: async () => {
        throw apiError(404);
      },
    },
    args({ acknowledge_environment_deletion: true }),
  );
  assert.equal(missing.outcome, "already_absent");
  assert.equal(missing.changed, false);

  let calls = 0;
  const raced = await handler(
    {
      request: async (path, options = {}) => {
        calls += 1;
        if (calls === 1) return { data: environment("stopped") };
        throw apiError(404, options.method, path);
      },
    },
    args({ acknowledge_environment_deletion: true }),
  );
  assert.equal(calls, 3);
  assert.equal(raced.outcome, "already_absent_after_preflight");
  assert.equal(raced.changed, false);

  let persistentCalls = 0;
  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          persistentCalls += 1;
          if (persistentCalls === 1 || persistentCalls === 3) {
            return { data: environment("stopped") };
          }
          throw apiError(404, options.method, path);
        },
      },
      args({ acknowledge_environment_deletion: true }),
    ),
    (error) => error instanceof GitLabApiError && error.status === 404,
  );
  assert.equal(persistentCalls, 3);
});

test("environment lifecycle propagates non-idempotent GitLab failures", async () => {
  const { handler } = lifecycleTools().get("delete_environment");
  let calls = 0;
  await assert.rejects(
    handler(
      {
        request: async (path, options = {}) => {
          calls += 1;
          if (calls === 1) return { data: environment("stopped") };
          throw apiError(403, options.method, path);
        },
      },
      args({ acknowledge_environment_deletion: true }),
    ),
    (error) => error instanceof GitLabApiError && error.status === 403,
  );
});

test("environment lifecycle propagates preflight permission or tier restrictions", async () => {
  for (const [toolName, acknowledgement] of [
    ["stop_environment", { acknowledge_environment_stop: true }],
    ["delete_environment", { acknowledge_environment_deletion: true }],
  ]) {
    const { handler } = lifecycleTools().get(toolName);
    let calls = 0;
    await assert.rejects(
      handler(
        {
          request: async () => {
            calls += 1;
            throw apiError(403);
          },
        },
        args(acknowledgement),
      ),
      (error) => error instanceof GitLabApiError && error.status === 403,
    );
    assert.equal(calls, 1);
  }
});

test("read-only mode exposes environment inspection but omits lifecycle mutations", async () => {
  const tools = await listedTools({ readOnly: true });
  const names = new Set(tools.map(({ name }) => name));
  assert.equal(names.has("get_environment"), true);
  assert.equal(names.has("list_environments"), true);
  assert.equal(names.has("stop_environment"), false);
  assert.equal(names.has("delete_environment"), false);
});

test("lifecycle acknowledgements are required by the MCP schema before dispatch", async (t) => {
  const calls = [];
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (...call) => {
        calls.push(call);
        return { data: environment("available") };
      },
    }),
  });
  const client = new Client({
    name: "environment-ack-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const stop = await client.callTool({
    name: "stop_environment",
    arguments: args(),
  });
  const remove = await client.callTool({
    name: "delete_environment",
    arguments: args(),
  });
  const oversizedName = "x".repeat(256);
  const oversizedStop = await client.callTool({
    name: "stop_environment",
    arguments: args({
      expected_environment_name: oversizedName,
      acknowledge_environment_stop: true,
    }),
  });
  const oversizedRemove = await client.callTool({
    name: "delete_environment",
    arguments: args({
      expected_environment_name: oversizedName,
      acknowledge_environment_deletion: true,
    }),
  });
  assert.equal(stop.isError, true);
  assert.equal(oversizedStop.isError, true);
  assert.equal(oversizedRemove.isError, true);
  assert.equal(remove.isError, true);
  assert.equal(calls.length, 0);
});
