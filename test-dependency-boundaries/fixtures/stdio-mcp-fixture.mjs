import { closeSync, writeFileSync } from "node:fs";

import { MCP_PROTOCOL_VERSION } from "../../scripts/lib/stdio-mcp-probe.mjs";

const mode = process.argv[2] ?? "success";
const pidFile = process.env.STDIO_MCP_FIXTURE_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

function initializeResult(protocolVersion = MCP_PROTOCOL_VERSION) {
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1.0.0" },
  };
}

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "x".repeat(10_000) },
    })}\n`,
  );
}

if (mode === "close-stdin") {
  closeSync(0);
  setTimeout(() => writeResponse(1, initializeResult()), 50);
  setTimeout(() => {}, 10_000);
} else {
  if (mode === "ignore-sigterm") {
    process.on("SIGTERM", () => {});
  }
  process.stdin.setEncoding("utf8");

  let input = "";
  let serverPingInitializeId;
  let serverPingProtocolVersion;
  process.stdin.on("data", (chunk) => {
    input += chunk;
    let newlineIndex;
    while ((newlineIndex = input.indexOf("\n")) !== -1) {
      const line = input.slice(0, newlineIndex).trim();
      input = input.slice(newlineIndex + 1);
      if (!line) continue;

      const message = JSON.parse(line);
      const requestedProtocolVersion =
        message.params?.protocolVersion ?? MCP_PROTOCOL_VERSION;
      if (
        mode === "server-ping" &&
        !Object.hasOwn(message, "method") &&
        message.id === serverPingInitializeId
      ) {
        writeResponse(
          serverPingInitializeId,
          initializeResult(serverPingProtocolVersion),
        );
        serverPingInitializeId = undefined;
        serverPingProtocolVersion = undefined;
        continue;
      }
      if (mode === "malformed") {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: initializeResult(requestedProtocolVersion),
          })}\nnot-json\n`,
        );
        continue;
      }
      if (mode === "invalid-envelope") {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id })}\n`,
        );
        continue;
      }
      if (mode === "unknown-response-id" && message.method === "initialize") {
        writeResponse(
          message.id + 100,
          initializeResult(requestedProtocolVersion),
        );
        continue;
      }
      if (mode === "invalid-initialize" && message.method === "initialize") {
        writeResponse(message.id, {
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        });
        continue;
      }
      if (mode === "unsupported-protocol" && message.method === "initialize") {
        writeResponse(message.id, {
          ...initializeResult(requestedProtocolVersion),
          protocolVersion: "2099-01-01",
        });
        continue;
      }
      if (mode === "initialize-error" && message.method === "initialize") {
        writeError(message.id);
        continue;
      }
      if (mode === "tools-list-error" && message.method === "tools/list") {
        writeError(message.id);
        continue;
      }
      if (mode === "server-ping" && message.method === "initialize") {
        serverPingInitializeId = message.id;
        serverPingProtocolVersion = requestedProtocolVersion;
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            method: "ping",
            params: {},
          })}\n`,
        );
        continue;
      }
      if (mode === "oversized-line") {
        process.stdout.write("x".repeat(1_048_577));
        continue;
      }
      if (mode === "premature-exit") {
        process.exitCode = 17;
        process.stdin.destroy();
        return;
      }
      if (mode === "hang" || mode === "ignore-sigterm") {
        continue;
      }
      if (message.method === "notifications/initialized") {
        continue;
      }

      let result;
      if (message.method === "initialize") {
        result = initializeResult(requestedProtocolVersion);
      } else if (message.method === "tools/list") {
        result = {
          tools: [{ name: "get_runtime_info" }, { name: "fixture_tool" }],
        };
      } else if (message.method === "tools/call") {
        result = {
          structuredContent: {
            result: {
              plugin: { name: "fixture", version: "1.0.0" },
            },
          },
        };
      }

      writeResponse(message.id, result);
    }
  });
}
