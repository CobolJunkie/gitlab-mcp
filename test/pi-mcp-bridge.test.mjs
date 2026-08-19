import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiToolDefinition,
  listAllMcpTools,
  registerMcpTools,
  translateMcpContent,
} from "../adapters/pi/mcp-bridge.mjs";

function mcpTool(name, options = {}) {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
    ...options,
  };
}

test("Pi bridge discovers paginated MCP tools before registering them", async () => {
  const calls = [];
  const client = {
    async listTools(params) {
      calls.push(params);
      if (!params) {
        return {
          tools: [
            mcpTool("read_project", { annotations: { readOnlyHint: true } }),
          ],
          nextCursor: "page-2",
        };
      }
      assert.deepEqual(params, { cursor: "page-2" });
      return { tools: [mcpTool("update_project")] };
    },
    async callTool() {
      return { content: [] };
    },
  };
  const registered = [];
  const tools = await registerMcpTools(
    { registerTool: (definition) => registered.push(definition) },
    client,
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["read_project", "update_project"],
  );
  assert.deepEqual(calls, [undefined, { cursor: "page-2" }]);
  assert.equal(registered[0].description, "read_project description");
  assert.deepEqual(registered[0].parameters, tools[0].inputSchema);
  assert.notEqual(registered[0].parameters, tools[0].inputSchema);
  assert.equal(registered[0].executionMode, "parallel");
  assert.equal(registered[1].executionMode, "sequential");
});

test("Pi bridge preserves valid optional-object MCP schemas without provider-specific normalization", () => {
  const inputSchema = {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  };
  const definition = createPiToolDefinition(
    mcpTool("optional_search", { inputSchema }),
    {
      async callTool() {
        return { content: [] };
      },
    },
  );

  assert.deepEqual(definition.parameters, inputSchema);
  assert.notEqual(definition.parameters, inputSchema);
  assert.equal(Object.hasOwn(definition.parameters, "required"), false);
});

test("Pi bridge treats an empty MCP cursor as opaque pagination state", async () => {
  const calls = [];
  const client = {
    async listTools(params) {
      calls.push(params);
      return params === undefined
        ? { tools: [mcpTool("first")], nextCursor: "" }
        : { tools: [mcpTool("second")] };
    },
  };

  const tools = await listAllMcpTools(client);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["first", "second"],
  );
  assert.deepEqual(calls, [undefined, { cursor: "" }]);
});

test("Pi bridge forwards calls unchanged and preserves structured MCP details", async () => {
  const calls = [];
  const definition = createPiToolDefinition(
    mcpTool("get_project", {
      title: "Get Project",
      annotations: { readOnlyHint: true, idempotentHint: true },
    }),
    {
      async callTool(request, resultSchema, options) {
        calls.push({ request, resultSchema, options });
        return {
          content: [{ type: "text", text: "project result" }],
          structuredContent: { project: { id: 12 } },
          _meta: { source: "fixture" },
        };
      },
    },
  );
  const signal = new AbortController().signal;

  const result = await definition.execute(
    "call-1",
    { value: "gitlab" },
    signal,
  );
  assert.equal(definition.label, "Get Project");
  assert.deepEqual(calls, [
    {
      request: { name: "get_project", arguments: { value: "gitlab" } },
      resultSchema: undefined,
      options: { signal },
    },
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "project result" }]);
  assert.deepEqual(result.details, {
    mcp: {
      annotations: { readOnlyHint: true, idempotentHint: true },
      structuredContent: { project: { id: 12 } },
      meta: { source: "fixture" },
    },
  });
});

test("Pi bridge preserves images and serializes unsupported MCP content", () => {
  const translated = translateMcpContent([
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "resource_link", uri: "gitlab://project/12", name: "project" },
  ]);
  assert.deepEqual(translated[0], {
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/png",
  });
  assert.equal(translated[1].type, "text");
  assert.match(translated[1].text, /resource_link/u);
  assert.match(translated[1].text, /gitlab:\/\/project\/12/u);

  assert.deepEqual(translateMcpContent([], { id: 12 }), [
    { type: "text", text: '{"id":12}' },
  ]);
});

test("Pi bridge converts MCP error results into Pi tool execution errors", async () => {
  const definition = createPiToolDefinition(mcpTool("update_project"), {
    async callTool() {
      return {
        isError: true,
        content: [{ type: "text", text: "permission denied" }],
        structuredContent: { status: 403 },
      };
    },
  });

  await assert.rejects(
    definition.execute("call-2", { value: "x" }),
    /MCP tool update_project failed: permission denied/u,
  );
});

test("Pi bridge uses structured error details when text content is absent", async () => {
  const definition = createPiToolDefinition(mcpTool("update_project"), {
    async callTool() {
      return { isError: true, structuredContent: { status: 403 } };
    },
  });

  await assert.rejects(
    definition.execute("call-structured-error", {}),
    (error) =>
      error?.message === 'MCP tool update_project failed: {"status":403}',
  );
});

test("Pi bridge fails before dispatch when Pi aborts a tool call", async () => {
  let called = false;
  const definition = createPiToolDefinition(mcpTool("get_project"), {
    async callTool() {
      called = true;
      return { content: [] };
    },
  });
  const controller = new AbortController();
  controller.abort(new Error("cancelled by Pi"));

  await assert.rejects(
    definition.execute("call-3", {}, controller.signal),
    /cancelled by Pi/u,
  );
  assert.equal(called, false);
});

test("Pi bridge rejects duplicate tool names and runaway pagination", async () => {
  const duplicateClient = {
    async listTools(params) {
      return params
        ? { tools: [mcpTool("same")] }
        : { tools: [mcpTool("same")], nextCursor: "again" };
    },
  };
  await assert.rejects(
    listAllMcpTools(duplicateClient),
    /duplicate tool same/u,
  );

  const endlessClient = {
    async listTools() {
      return { tools: [], nextCursor: "again" };
    },
  };
  await assert.rejects(
    listAllMcpTools(endlessClient, { maxPages: 2 }),
    /exceeded the 2-page safety limit/u,
  );
});
