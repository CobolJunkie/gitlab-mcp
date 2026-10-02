import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createGitLabMcpServer } from "../src/server.mjs";

async function connectedPair(request) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({ request }),
  });
  const client = new Client({
    name: "merge-request-pipeline-pagination-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test("merge-request pipeline schema exposes bounded optional pagination", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    return { data: [] };
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const tool = listed.tools.find(
    (candidate) => candidate.name === "list_merge_request_pipelines",
  );
  assert.ok(tool);
  assert.equal(tool.inputSchema.required.includes("page"), false);
  assert.equal(tool.inputSchema.required.includes("per_page"), false);
  assert.equal(tool.inputSchema.properties.page.minimum, 1);
  assert.equal(tool.inputSchema.properties.per_page.minimum, 1);
  assert.equal(tool.inputSchema.properties.per_page.maximum, 100);

  const invalid = await client.callTool({
    name: "list_merge_request_pipelines",
    arguments: {
      project: "group/project",
      merge_request_iid: 7,
      per_page: 101,
    },
  });

  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 0, "invalid pagination must not reach GitLab");
});

test("merge-request pipeline pagination forwards page selection and preserves metadata", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    const page = options.query?.page;
    if (page === 1) {
      return {
        data: [{ id: 101, status: "success" }],
        pagination: {
          page: 1,
          perPage: 1,
          nextPage: 2,
          total: 2,
          totalPages: 2,
        },
      };
    }
    return {
      data: [{ id: 102, status: "failed" }],
      pagination: {
        page: 2,
        perPage: 1,
        total: 2,
        totalPages: 2,
      },
    };
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const first = await client.callTool({
    name: "list_merge_request_pipelines",
    arguments: {
      project: "group/project",
      merge_request_iid: 7,
      page: 1,
      per_page: 1,
    },
  });
  const second = await client.callTool({
    name: "list_merge_request_pipelines",
    arguments: {
      project: "group/project",
      merge_request_iid: 7,
      page: 2,
      per_page: 1,
    },
  });

  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.deepEqual(first.structuredContent.result, {
    data: [{ id: 101, status: "success" }],
    pagination: {
      page: 1,
      perPage: 1,
      nextPage: 2,
      total: 2,
      totalPages: 2,
    },
  });
  assert.deepEqual(second.structuredContent.result, {
    data: [{ id: 102, status: "failed" }],
    pagination: {
      page: 2,
      perPage: 1,
      total: 2,
      totalPages: 2,
    },
  });
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/merge_requests/7/pipelines",
      options: { query: { page: 1, per_page: 1 } },
    },
    {
      path: "/projects/group%2Fproject/merge_requests/7/pipelines",
      options: { query: { page: 2, per_page: 1 } },
    },
  ]);
});

test("merge-request pipeline listing preserves single-page data without explicit paging", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    return {
      data: [{ id: 201, status: "success" }],
      pagination: {
        page: 1,
        perPage: 20,
        total: 1,
        totalPages: 1,
      },
    };
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "list_merge_request_pipelines",
    arguments: {
      project: "group/project",
      merge_request_iid: 7,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.result, {
    data: [{ id: 201, status: "success" }],
    pagination: {
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    },
  });
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/merge_requests/7/pipelines",
      options: { query: { page: undefined, per_page: undefined } },
    },
  ]);
});
