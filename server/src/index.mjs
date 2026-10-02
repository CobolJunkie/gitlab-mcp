#!/usr/bin/env node

import canonicalDistributionSource from "../../distribution.json" with { type: "json" };

import { normalizeCanonicalDistribution } from "../../shared/canonical-distribution.mjs";
import {
  getDistributionMetadata,
  setDistributionMetadata,
} from "../../shared/distribution-metadata.mjs";
import { startOpenTelemetry } from "./opentelemetry.mjs";

function establishCanonicalDistributionMetadata() {
  if (getDistributionMetadata()) {
    return;
  }
  const canonical = normalizeCanonicalDistribution(canonicalDistributionSource);
  setDistributionMetadata({
    name: canonical.name,
    version: canonical.version,
  });
}

async function shutdownAndExit(shutdown, telemetry) {
  let exitCode = 0;
  try {
    await shutdown();
  } catch {
    exitCode = 1;
  }
  try {
    await telemetry.shutdown();
  } catch {
    exitCode = 1;
  }
  process.exit(exitCode);
}

function installShutdownHandlers(shutdown, telemetry) {
  let shuttingDown = false;
  const handleShutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdownAndExit(shutdown, telemetry);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

async function startHttp(telemetry) {
  const [{ startHttpServer }, { createGitLabMcpServer }] = await Promise.all([
    import("./http.mjs"),
    import("./server.mjs"),
  ]);
  const { ready, shutdown } = startHttpServer({
    observabilityObserver: telemetry.observabilityObserver,
    serverFactory: (options) =>
      createGitLabMcpServer({
        ...options,
        observabilityMcpScope: telemetry.observabilityMcpScope,
        observabilityMcpSent: telemetry.observabilityMcpSent,
        observabilityToolScope: telemetry.observabilityToolScope,
      }),
  });
  await ready;
  installShutdownHandlers(shutdown, telemetry);
}

async function startStdio(telemetry) {
  const [{ StdioServerTransport }, { createGitLabMcpServer }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("./server.mjs"),
    ]);
  const server = createGitLabMcpServer({
    deploymentMode: "stdio",
    readOnly: process.env.MCP_READ_ONLY === "true",
    observabilityObserver: telemetry.observabilityObserver,
    observabilityMcpScope: telemetry.observabilityMcpScope,
    observabilityMcpSent: telemetry.observabilityMcpSent,
    observabilityToolScope: telemetry.observabilityToolScope,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitLab MCP server running over stdio.");
  installShutdownHandlers(
    () => server.close().catch(() => undefined),
    telemetry,
  );
}

async function main() {
  establishCanonicalDistributionMetadata();
  const args = new Set(process.argv.slice(2));
  const deploymentMode = args.has("--http") ? "http" : "stdio";
  const telemetry = await startOpenTelemetry();

  try {
    if (deploymentMode === "http") {
      await startHttp(telemetry);
    } else {
      await startStdio(telemetry);
    }
  } catch (error) {
    await telemetry.shutdown();
    throw error;
  }
}

function reportStartupFailure(error) {
  const args = new Set(process.argv.slice(2));
  const message = args.has("--http")
    ? "GitLab MCP HTTP server failed:"
    : "GitLab MCP server failed:";
  console.error(message, error);
  process.exit(1);
}

// The canonical distribution is bundled as CommonJS, so source-level top-level
// await is not available here. Schedule the async bootstrap and attach the
// failure handler to that bootstrap only, preserving normal process-level
// unhandled-rejection behavior for unrelated application code.
process.nextTick(() => {
  void main().catch(reportStartupFailure);
});
