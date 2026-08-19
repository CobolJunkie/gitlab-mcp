import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiServerEnvironment,
  createPiServerLaunch,
  registerPiMcpLifecycle,
  startPiMcpExtension,
} from "../adapters/pi/extensions/gitlab-mcp.mjs";

const CANONICAL = {
  name: "gitlab",
  version: "1.2.3",
  mcp: { bundle: "server/dist/gitlab-mcp.cjs" },
};
const TOOL = {
  name: "get_project",
  description: "Get a project",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

function createPiFixture() {
  const tools = [];
  const handlers = new Map();
  return {
    handlers,
    pi: {
      registerTool(tool) {
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    },
    tools,
  };
}

function createClientFixture(index, records, { failListTools = false } = {}) {
  const calls = [];
  const record = { calls, closeCount: 0, index };
  records.push(record);
  return {
    async connect(transport) {
      calls.push(["connect", transport]);
    },
    async listTools() {
      calls.push(["listTools"]);
      if (failListTools) throw new Error(`list failed ${index}`);
      return { tools: [TOOL] };
    },
    async callTool(request) {
      calls.push(["callTool", request]);
      return { content: [{ type: "text", text: `ok-${index}` }] };
    },
    async close() {
      record.closeCount += 1;
    },
  };
}

test("Pi child environment forwards only server configuration and safe runtime variables", () => {
  const environment = createPiServerEnvironment({
    GITLAB_URL: "https://gitlab.example.com",
    GITLAB_TOKEN: "gitlab-token",
    MCP_READ_ONLY: "true",
    NODE_EXTRA_CA_CERTS: "/tmp/gitlab-ca.pem",
    BUN_BE_BUN: "user-controlled-value",
    UNRELATED_SECRET: "must-not-propagate",
  });

  assert.equal(environment.GITLAB_URL, "https://gitlab.example.com");
  assert.equal(environment.GITLAB_TOKEN, "gitlab-token");
  assert.equal(environment.MCP_READ_ONLY, "true");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "/tmp/gitlab-ca.pem");
  assert.equal(environment.BUN_BE_BUN, undefined);
  assert.equal(environment.UNRELATED_SECRET, undefined);
  assert.equal(typeof environment.PATH, "string");
});

test("Pi server launch uses the active Node executable without a Bun override", () => {
  const launch = createPiServerLaunch(
    CANONICAL,
    {
      GITLAB_URL: "https://gitlab.example.com",
      BUN_BE_BUN: "must-not-propagate",
    },
    {
      execPath: "/usr/local/bin/node",
      versions: { node: "22.0.0" },
    },
  );

  assert.equal(launch.command, "/usr/local/bin/node");
  assert.match(launch.args[0], /server[\\/]dist[\\/]gitlab-mcp\.cjs$/u);
  assert.equal(launch.args[1], "--stdio");
  assert.equal(launch.env.GITLAB_URL, "https://gitlab.example.com");
  assert.equal(launch.env.BUN_BE_BUN, undefined);
});

test("Pi server launch makes a Bun-compiled standalone executable act as the runtime CLI", () => {
  const launch = createPiServerLaunch(
    CANONICAL,
    {
      GITLAB_TOKEN: "gitlab-token",
      BUN_BE_BUN: "must-not-control-launch-mode",
      UNRELATED_SECRET: "must-not-propagate",
    },
    {
      execPath: "/opt/pi/pi",
      versions: { bun: "1.2.16" },
    },
  );

  assert.equal(launch.command, "/opt/pi/pi");
  assert.match(launch.args[0], /server[\\/]dist[\\/]gitlab-mcp\.cjs$/u);
  assert.equal(launch.args[1], "--stdio");
  assert.equal(launch.env.GITLAB_TOKEN, "gitlab-token");
  assert.equal(launch.env.BUN_BE_BUN, "1");
  assert.equal(launch.env.UNRELATED_SECRET, undefined);
});

test("Pi server launch rejects a runtime without an executable path", () => {
  assert.throws(
    () => createPiServerLaunch(CANONICAL, {}, { versions: {} }),
    /runtime executable path must be a non-empty string/u,
  );
});

test("Pi session startup connects and registers MCP tools", async () => {
  const calls = [];
  let closeCount = 0;
  const client = {
    async connect(transport) {
      calls.push(["connect", transport]);
    },
    async listTools() {
      return { tools: [TOOL] };
    },
    async callTool(request) {
      calls.push(["callTool", request]);
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {
      closeCount += 1;
    },
  };
  const transport = { fixture: true };
  const fixture = createPiFixture();

  const started = await startPiMcpExtension(fixture.pi, {
    canonical: CANONICAL,
    client,
    transport,
  });

  assert.deepEqual(calls, [["connect", transport]]);
  assert.deepEqual(started.tools, [TOOL]);
  assert.equal(fixture.tools.length, 1);
  assert.equal(fixture.tools[0].name, "get_project");
  assert.equal(fixture.tools[0].executionMode, "parallel");

  assert.deepEqual(await fixture.tools[0].execute("call-1", {}), {
    content: [{ type: "text", text: "ok" }],
    details: {
      mcp: {
        annotations: { readOnlyHint: true },
        structuredContent: null,
        meta: null,
      },
    },
  });
  assert.deepEqual(calls[1], [
    "callTool",
    { name: "get_project", arguments: {} },
  ]);

  await started.close();
  await started.close();
  assert.equal(closeCount, 1);
});

test("Pi lifecycle defers resources until session_start and reconnects after session replacement", async () => {
  const clients = [];
  let clientIndex = 0;
  const fixture = createPiFixture();
  const lifecycle = registerPiMcpLifecycle(fixture.pi, {
    canonical: CANONICAL,
    createClient() {
      clientIndex += 1;
      return createClientFixture(clientIndex, clients);
    },
    createTransport() {
      return { session: clientIndex };
    },
  });

  assert.equal(clients.length, 0);
  assert.equal(fixture.tools.length, 0);
  assert.equal(typeof fixture.handlers.get("session_start"), "function");
  assert.equal(typeof fixture.handlers.get("session_shutdown"), "function");

  await fixture.handlers.get("session_start")();
  assert.equal(clients.length, 1);
  assert.equal(fixture.tools.length, 1);
  assert.deepEqual(await fixture.tools.at(-1).execute("call-1", {}), {
    content: [{ type: "text", text: "ok-1" }],
    details: {
      mcp: {
        annotations: { readOnlyHint: true },
        structuredContent: null,
        meta: null,
      },
    },
  });

  await fixture.handlers.get("session_shutdown")();
  await fixture.handlers.get("session_shutdown")();
  assert.equal(clients[0].closeCount, 1);
  assert.equal(lifecycle.activeSession, undefined);

  await fixture.handlers.get("session_start")();
  assert.equal(clients.length, 2);
  assert.equal(fixture.tools.length, 2);
  assert.deepEqual(await fixture.tools.at(-1).execute("call-2", {}), {
    content: [{ type: "text", text: "ok-2" }],
    details: {
      mcp: {
        annotations: { readOnlyHint: true },
        structuredContent: null,
        meta: null,
      },
    },
  });
  assert.equal(
    clients[0].calls.some(([name]) => name === "callTool"),
    true,
  );
  assert.equal(
    clients[1].calls.some(([name]) => name === "callTool"),
    true,
  );

  await lifecycle.close();
  assert.equal(clients[1].closeCount, 1);
});

test("Pi lifecycle cleans a failed replacement session and can retry cleanly", async () => {
  const clients = [];
  let clientIndex = 0;
  const fixture = createPiFixture();
  registerPiMcpLifecycle(fixture.pi, {
    canonical: CANONICAL,
    createClient() {
      clientIndex += 1;
      return createClientFixture(clientIndex, clients, {
        failListTools: clientIndex === 2,
      });
    },
    createTransport() {
      return { session: clientIndex };
    },
  });

  await fixture.handlers.get("session_start")();
  await fixture.handlers.get("session_shutdown")();
  await assert.rejects(
    fixture.handlers.get("session_start")(),
    /list failed 2/u,
  );
  assert.equal(clients[1].closeCount, 1);

  await fixture.handlers.get("session_start")();
  assert.equal(clients.length, 3);
  assert.deepEqual(await fixture.tools.at(-1).execute("call-3", {}), {
    content: [{ type: "text", text: "ok-3" }],
    details: {
      mcp: {
        annotations: { readOnlyHint: true },
        structuredContent: null,
        meta: null,
      },
    },
  });
  await fixture.handlers.get("session_shutdown")();
  assert.equal(clients[2].closeCount, 1);
});

test("Pi extension closes the MCP client when startup registration fails", async () => {
  let closeCount = 0;
  const client = {
    async connect() {},
    async listTools() {
      return { tools: [TOOL] };
    },
    async callTool() {
      return { content: [] };
    },
    async close() {
      closeCount += 1;
    },
  };
  const pi = {
    registerTool() {
      throw new Error("Pi registration failed");
    },
    on() {},
  };

  await assert.rejects(
    startPiMcpExtension(pi, {
      canonical: CANONICAL,
      client,
      transport: {},
    }),
    /Pi registration failed/u,
  );
  assert.equal(closeCount, 1);
});
