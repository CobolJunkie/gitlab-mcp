#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PI_DISTRIBUTION } from "../adapters/pi/distribution.mjs";

const execFileAsync = promisify(execFile);
const rootPath = fileURLToPath(new URL("../", import.meta.url));
const standaloneExecutable = process.env.PI_STANDALONE_EXECUTABLE?.trim();
const runtimeVersion = process.env.PI_RUNTIME_VERSION?.trim();

if (!standaloneExecutable) {
  throw new Error(
    "PI_STANDALONE_EXECUTABLE must point to the official Pi standalone executable.",
  );
}

const executableStat = await stat(standaloneExecutable);
assert.ok(executableStat.isFile(), "Pi standalone executable must be a file.");

const materializedPackageRoot = join(
  rootPath,
  "release",
  PI_DISTRIBUTION.artifactName,
);
const packageStat = await stat(materializedPackageRoot);
assert.ok(
  packageStat.isDirectory(),
  "Pi package must be materialized before standalone validation.",
);

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function installProductionDependencies(packageRoot) {
  await execFileAsync(
    npmExecutable(),
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    { cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "gitlab-pi-standalone-"));
const isolatedPackageRoot = join(temporaryRoot, "package");
const workDirectory = join(temporaryRoot, "work");
const probePath = join(temporaryRoot, "standalone-probe.mjs");
const telemetryRequests = [];
const telemetryServer = createServer((request, response) => {
  if (request.method === "POST") {
    telemetryRequests.push({
      url: request.url,
      testHeader: request.headers["x-otel-test"],
    });
  }
  request.resume();
  response.writeHead(200, {
    "content-type": "application/x-protobuf",
    connection: "close",
  });
  response.end();
});

const probeSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.PI_STANDALONE_PACKAGE_ROOT;
assert.ok(packageRoot, "Standalone probe package root must be configured.");
assert.equal(
  typeof process.versions.bun,
  "string",
  "Official Pi standalone validation must execute under Bun.",
);

const canonical = JSON.parse(
  await readFile(join(packageRoot, "distribution.json"), "utf8"),
);
const extension = await import(
  pathToFileURL(join(packageRoot, "extensions/gitlab-mcp.mjs")).href
);
const tools = [];
const started = await extension.startPiMcpExtension({
  registerTool(tool) {
    tools.push(tool);
  },
});

try {
  const runtimeTool = tools.find((tool) => tool.name === "get_runtime_info");
  assert.ok(runtimeTool, "Standalone Pi bridge must register get_runtime_info.");
  const runtimeResult = await runtimeTool.execute(
    "pi-standalone-runtime-smoke",
    {},
    new AbortController().signal,
  );
  assert.deepEqual(
    runtimeResult.details?.mcp?.structuredContent?.result?.plugin,
    { name: canonical.name, version: canonical.version },
    "Standalone Pi bridge runtime provenance must match canonical metadata.",
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  console.log(
    JSON.stringify({
      bunVersion: process.versions.bun,
      toolCount: tools.length,
    }),
  );
} finally {
  await started.close();
}
`;

try {
  await listen(telemetryServer);
  const telemetryAddress = telemetryServer.address();
  assert.ok(
    telemetryAddress && typeof telemetryAddress === "object",
    "Standalone telemetry collector must expose a bound TCP address.",
  );
  const telemetryEndpoint = `http://127.0.0.1:${telemetryAddress.port}`;

  await cp(materializedPackageRoot, isolatedPackageRoot, { recursive: true });
  await mkdir(workDirectory, { recursive: true });
  await installProductionDependencies(isolatedPackageRoot);
  await writeFile(probePath, probeSource);

  const { stdout } = await execFileAsync(standaloneExecutable, [probePath], {
    cwd: workDirectory,
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
      GITLAB_TOKEN: "pi-standalone-smoke-test",
      GITLAB_URL: "https://gitlab.example.com",
      MCP_READ_ONLY: "false",
      MCP_OTEL_ENABLED: "true",
      MCP_OTEL_EXPORT_TIMEOUT_MS: "1000",
      MCP_OTEL_METRIC_EXPORT_INTERVAL_MS: "1000",
      MCP_OTEL_SHUTDOWN_TIMEOUT_MS: "1000",
      OTEL_EXPORTER_OTLP_ENDPOINT: telemetryEndpoint,
      OTEL_EXPORTER_OTLP_HEADERS: "x-otel-test=pi-standalone",
      PI_STANDALONE_PACKAGE_ROOT: isolatedPackageRoot,
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  const outputLines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.ok(
    outputLines.length > 0,
    "Standalone Pi probe must report a result.",
  );
  const summary = JSON.parse(outputLines.at(-1));
  assert.equal(typeof summary.bunVersion, "string");
  assert.ok(
    Number.isInteger(summary.toolCount) && summary.toolCount > 0,
    "Standalone Pi probe must register canonical MCP tools.",
  );
  const metricExport = telemetryRequests.find(
    ({ url }) => url === "/v1/metrics",
  );
  assert.ok(
    metricExport,
    "Standalone Pi MCP child must export OBS-02 metrics through the configured OTLP endpoint.",
  );
  assert.equal(
    metricExport.testHeader,
    "pi-standalone",
    "Standalone Pi MCP child must preserve supported OTLP exporter headers.",
  );

  const versionLabel = runtimeVersion ? `@${runtimeVersion}` : "";
  console.log(
    `Pi standalone validation passed: official Pi${versionLabel} Bun ${summary.bunVersion} launched ${summary.toolCount} packaged MCP tools, executed get_runtime_info, and exported OBS-02 metrics with OTLP headers.`,
  );
} finally {
  await closeServer(telemetryServer);
  await rm(temporaryRoot, { recursive: true, force: true });
}
