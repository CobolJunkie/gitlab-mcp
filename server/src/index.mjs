#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { startHttpServer } from "./http.mjs";
import { createGitLabMcpServer } from "./server.mjs";

async function startStdio() {
  const server = createGitLabMcpServer({
    deploymentMode: "stdio",
    readOnly: process.env.MCP_READ_ONLY === "true",
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitLab MCP server running over stdio.");

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startHttp() {
  const { ready, shutdown } = startHttpServer();
  try {
    await ready;
  } catch {
    process.exitCode = 1;
    return;
  }
  let shuttingDown = false;
  const handleShutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

const args = new Set(process.argv.slice(2));
if (args.has("--http")) {
  startHttp().catch((error) => {
    console.error("GitLab MCP HTTP server failed:", error);
    process.exit(1);
  });
} else {
  startStdio().catch((error) => {
    console.error("GitLab MCP server failed:", error);
    process.exit(1);
  });
}
