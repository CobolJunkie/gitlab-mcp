import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  compareToolSurfaces,
  fetchRemoteToolSurface,
} from "../scripts/lib/mcp-surface-parity.mjs";

function tool(name, { property = "value", readOnly = true } = {}) {
  return {
    name,
    title: `${name} title`,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties: {
        [property]: { type: "string" },
      },
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: ["api"] }],
    },
    securitySchemes: [{ type: "oauth2", scopes: ["api"] }],
  };
}

test("surface parity reports a match while ignoring deployment security metadata", () => {
  const canonical = [tool("alpha"), tool("beta")];
  const remote = canonical.map(({ _meta, securitySchemes, ...entry }) => entry);
  const result = compareToolSurfaces(canonical, remote);
  assert.equal(result.status, "match");
  assert.equal(result.canonical.count, 2);
  assert.equal(result.remote.count, 2);
  assert.deepEqual(result.missingTools, { count: 0, names: [] });
  assert.deepEqual(result.extraTools, { count: 0, names: [] });
  assert.deepEqual(result.staleTools, { count: 0, names: [] });
});

test("surface parity rejects incomplete safety annotations", () => {
  const incomplete = tool("alpha");
  delete incomplete.annotations.openWorldHint;
  assert.throws(
    () => compareToolSurfaces([tool("alpha")], [incomplete]),
    /missing boolean annotation openWorldHint/,
  );
});

test("surface parity bounds individual reported tool names", () => {
  const longName = "x".repeat(200);
  const result = compareToolSurfaces([tool(longName)], []);
  assert.equal(result.missingTools.count, 1);
  assert.equal(result.missingTools.names[0].length, 128);
  assert.match(result.missingTools.names[0], /\.\.\.$/);
});

test("surface parity reports missing and extra tools", () => {
  const result = compareToolSurfaces(
    [tool("alpha"), tool("missing")],
    [tool("alpha"), tool("extra")],
  );
  assert.equal(result.status, "drift");
  assert.deepEqual(result.missingTools, { count: 1, names: ["missing"] });
  assert.deepEqual(result.extraTools, { count: 1, names: ["extra"] });
  assert.deepEqual(result.staleTools, { count: 0, names: [] });
});

test("surface parity detects stale argument schemas and safety annotations", () => {
  const schemaDrift = compareToolSurfaces(
    [tool("alpha")],
    [tool("alpha", { property: "obsolete_argument" })],
  );
  assert.equal(schemaDrift.staleTools.count, 1);
  assert.deepEqual(schemaDrift.staleTools.names, ["alpha"]);

  const annotationDrift = compareToolSurfaces(
    [tool("alpha", { readOnly: true })],
    [tool("alpha", { readOnly: false })],
  );
  assert.equal(annotationDrift.staleTools.count, 1);
});

test("surface parity bounds reported names while retaining full counts", () => {
  const canonical = Array.from({ length: 30 }, (_, index) =>
    tool(`tool_${String(index).padStart(2, "0")}`),
  );
  const result = compareToolSurfaces(canonical, [], { maxReportedNames: 5 });
  assert.equal(result.missingTools.count, 30);
  assert.equal(result.missingTools.names.length, 5);
  assert.deepEqual(result.missingTools.names, [
    "tool_00",
    "tool_01",
    "tool_02",
    "tool_03",
    "tool_04",
  ]);
});

test("remote tools/list uses bearer auth without returning the token", async (t) => {
  const secret = "surface-parity-secret";
  let authorization;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.method, "tools/list");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [tool("alpha")] },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const tools = await fetchRemoteToolSurface(
    `http://127.0.0.1:${address.port}/mcp`,
    {
      token: secret,
      allowInsecureHttp: true,
    },
  );
  assert.equal(authorization, `Bearer ${secret}`);
  assert.equal(tools.length, 1);
  assert.equal(JSON.stringify(tools).includes(secret), false);
});

test("remote tools/list follows bounded pagination", async (t) => {
  const cursors = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    cursors.push(body.params?.cursor);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.params?.cursor === "page-2"
            ? { tools: [tool("beta")] }
            : { tools: [tool("alpha")], nextCursor: "page-2" },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const tools = await fetchRemoteToolSurface(
    `http://127.0.0.1:${address.port}/mcp/`,
    { allowInsecureHttp: true },
  );
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["alpha", "beta"],
  );
  assert.deepEqual(cursors, [undefined, "page-2"]);
});

test("remote tools/list rejects malformed pagination cursors", async (t) => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [tool("alpha")], nextCursor: 7 },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  await assert.rejects(
    fetchRemoteToolSurface(`http://127.0.0.1:${address.port}/mcp`, {
      allowInsecureHttp: true,
    }),
    {
      name: "TypeError",
      message: "Remote MCP tools/list returned an invalid nextCursor.",
    },
  );
});
