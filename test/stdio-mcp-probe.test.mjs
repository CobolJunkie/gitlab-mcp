import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import {
  MCP_PROTOCOL_VERSION,
  probeStdioMcp,
} from "../scripts/lib/stdio-mcp-probe.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(
  repositoryRoot,
  "test-dependency-boundaries",
  "fixtures",
  "stdio-mcp-fixture.mjs",
);

function probeFixture(mode = "success", overrides = {}) {
  return probeStdioMcp({
    command: process.execPath,
    args: [fixturePath, mode],
    env: { ...process.env },
    clientInfo: { name: "probe-test", version: "1.0.0" },
    ...overrides,
  });
}

function activeTimeoutCount() {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

function assertBoundedJsonRpcFailure(error, method) {
  assert.match(error.message, new RegExp(`^MCP ${method} failed:`));
  assert.match(error.message, /…\[truncated\]$/u);
  assert.ok(error.message.length < 2_100);
  return true;
}

test("stdio MCP probe protocol stays synchronized with the installed SDK", () => {
  assert.equal(MCP_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION);
});

test("stdio MCP probe initializes with the SDK protocol, lists tools, and reads runtime metadata", async () => {
  const result = await probeFixture();

  assert.equal(result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["get_runtime_info", "fixture_tool"],
  );
  assert.deepEqual(result.runtimeInfo.structuredContent.result.plugin, {
    name: "fixture",
    version: "1.0.0",
  });
});

test("stdio MCP probe clears its termination grace timer after clean shutdown", async () => {
  const baselineTimeouts = activeTimeoutCount();

  await probeFixture();

  assert.equal(activeTimeoutCount(), baselineTimeouts);
});

test("stdio MCP probe responds to server ping requests before matching responses", async () => {
  const result = await probeFixture("server-ping", { timeoutMs: 2_000 });

  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["get_runtime_info", "fixture_tool"],
  );
});

test("stdio MCP probe rejects malformed stdout as a controlled error", async () => {
  await assert.rejects(
    probeFixture("malformed"),
    /emitted invalid JSON: not-json/,
  );
});

test("stdio MCP probe rejects an invalid JSON-RPC response envelope", async () => {
  await assert.rejects(
    probeFixture("invalid-envelope"),
    /initialize response must contain exactly one of result or error/,
  );
});

test("stdio MCP probe bounds initialize JSON-RPC errors", async () => {
  await assert.rejects(probeFixture("initialize-error"), (error) =>
    assertBoundedJsonRpcFailure(error, "initialize"),
  );
});

test("stdio MCP probe bounds post-initialize JSON-RPC errors", async () => {
  await assert.rejects(probeFixture("tools-list-error"), (error) =>
    assertBoundedJsonRpcFailure(error, "tools/list"),
  );
});

test("stdio MCP probe rejects an unknown response id without timing out", async () => {
  await assert.rejects(
    probeFixture("unknown-response-id", { timeoutMs: 2_000 }),
    /response with unknown request id 101/,
  );
});

test("stdio MCP probe rejects an invalid initialize result", async () => {
  await assert.rejects(
    probeFixture("invalid-initialize"),
    /initialize result must contain a non-empty protocolVersion/,
  );
});

test("stdio MCP probe rejects unsupported protocol negotiation", async () => {
  await assert.rejects(
    probeFixture("unsupported-protocol"),
    new RegExp(
      `unsupported protocolVersion 2099-01-01; expected ${LATEST_PROTOCOL_VERSION}`,
    ),
  );
});

test("stdio MCP probe rejects oversized unterminated stdout", async () => {
  await assert.rejects(
    probeFixture("oversized-line", { timeoutMs: 2_000 }),
    /protocol line exceeded 1048576 characters/,
  );
});

test("stdio MCP probe rejects premature child exit", async () => {
  await assert.rejects(
    probeFixture("premature-exit"),
    /process exited before probe completion \(code=17, signal=null\)/,
  );
});

test("stdio MCP probe rejects closed child stdin instead of timing out", async () => {
  await assert.rejects(
    probeFixture("close-stdin", { timeoutMs: 2_000 }),
    /MCP stdio stdin(?: write)? failed:/,
  );
});

test("stdio MCP probe times out and terminates an unresponsive child", async () => {
  await assert.rejects(
    probeFixture("hang", { timeoutMs: 50 }),
    /probe timed out after 50ms/,
  );
});

test("stdio MCP probe force-kills a child that ignores graceful termination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stdio-mcp-probe-"));
  const pidFile = join(directory, "pid");

  try {
    await assert.rejects(
      probeFixture("ignore-sigterm", {
        timeoutMs: 500,
        env: {
          ...process.env,
          STDIO_MCP_FIXTURE_PID_FILE: pidFile,
        },
      }),
      /probe timed out after 500ms/,
    );

    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === "ESRCH",
      "Fixture child must not remain alive after forced probe cleanup.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
