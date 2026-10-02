import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSurfaceParityArgs,
  runSurfaceParityCheck,
} from "../scripts/check-mcp-surface-parity.mjs";

test("surface parity CLI keeps insecure HTTP opt-in explicit", () => {
  assert.deepEqual(
    parseSurfaceParityArgs(["https://mcp.example.com/mcp"], {
      readOnly: false,
    }),
    {
      endpoint: "https://mcp.example.com/mcp",
      readOnly: false,
      allowInsecureHttp: false,
    },
  );

  assert.deepEqual(
    parseSurfaceParityArgs(
      ["http://127.0.0.1:49152/mcp", "--read-only", "--allow-insecure-http"],
      { readOnly: false },
    ),
    {
      endpoint: "http://127.0.0.1:49152/mcp",
      readOnly: true,
      allowInsecureHttp: true,
    },
  );

  assert.equal(
    parseSurfaceParityArgs(["https://mcp.example.com/mcp"], {
      readOnly: true,
    }).readOnly,
    true,
  );
});

test("surface parity CLI rejects ambiguous or incomplete arguments", () => {
  assert.throws(
    () => parseSurfaceParityArgs([], { readOnly: false }),
    /Remote MCP endpoint is required\./u,
  );
  assert.throws(
    () =>
      parseSurfaceParityArgs(
        ["https://mcp.example.com/mcp", "https://other.example.com/mcp"],
        { readOnly: false },
      ),
    /Unknown argument: https:\/\/other\.example\.com\/mcp/u,
  );
  assert.throws(
    () =>
      parseSurfaceParityArgs(["https://mcp.example.com/mcp", "--unexpected"], {
        readOnly: false,
      }),
    /Unknown argument: --unexpected/u,
  );
});

test("surface parity CLI forwards bounded deployment intent without exposing token in args", async () => {
  const secret = "short-lived-secret";
  let received;
  const report = { status: "match" };

  assert.equal(
    await runSurfaceParityCheck(
      ["http://127.0.0.1:49152/mcp", "--allow-insecure-http"],
      {
        readOnly: true,
        token: secret,
        async checkRemote(options) {
          received = options;
          return report;
        },
      },
    ),
    report,
  );

  assert.deepEqual(received, {
    endpoint: "http://127.0.0.1:49152/mcp",
    readOnly: true,
    allowInsecureHttp: true,
    token: secret,
  });
});
