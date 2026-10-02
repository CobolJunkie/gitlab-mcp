import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { boundedMcpProtocolVersion } from "../src/mcp-protocol.mjs";
import { OBSERVABILITY_OPERATION_TOKEN } from "../src/observability.mjs";
import { MCP_SEMCONV } from "../src/opentelemetry-semconv.mjs";
import { startOpenTelemetry } from "../src/opentelemetry.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

const ENABLED_ENV = Object.freeze({
  MCP_OTEL_ENABLED: "true",
  MCP_OTEL_EXPORT_TIMEOUT_MS: "1000",
  MCP_OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
  MCP_OTEL_SHUTDOWN_TIMEOUT_MS: "1000",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector.invalid/v1/metrics",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.invalid/v1/traces",
});

function inMemoryMetricExporter() {
  return new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
}

function metricDataByName(exporter, name) {
  return exporter
    .getMetrics()
    .flatMap(({ scopeMetrics }) => scopeMetrics)
    .flatMap(({ metrics }) => metrics)
    .find(({ descriptor }) => descriptor.name === name);
}

test("short metric intervals do not disable telemetry with longer exporter timeouts", async () => {
  let metricExporterOptions;
  const runtime = await startOpenTelemetry({
    env: {
      ...ENABLED_ENV,
      MCP_OTEL_EXPORT_TIMEOUT_MS: "10000",
      MCP_OTEL_METRIC_EXPORT_INTERVAL_MS: "1000",
    },
    traceExporterFactory: () => new InMemorySpanExporter(),
    metricExporterFactory(options) {
      metricExporterOptions = options;
      return inMemoryMetricExporter();
    },
    sdkFactory: (options) => ({
      options,
      start: () => undefined,
      shutdown: async () => undefined,
    }),
  });

  assert.equal(runtime.enabled, true);
  assert.equal(metricExporterOptions.timeoutMillis, 10_000);
  await runtime.shutdown();
});

test("MCP protocol revisions are bounded to the pinned SDK support set", () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(boundedMcpProtocolVersion(version), version);
  }
  assert.equal(boundedMcpProtocolVersion("2099-01-01"), undefined);
  assert.equal(
    boundedMcpProtocolVersion("private-cardinality-value"),
    undefined,
  );
  assert.equal(
    boundedMcpProtocolVersion([SUPPORTED_PROTOCOL_VERSIONS[0]]),
    undefined,
  );
});

test("HTTP handler metadata uses only a supported MCP-Protocol-Version header", async () => {
  const version = SUPPORTED_PROTOCOL_VERSIONS[0];
  const seen = [];
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "http",
    observabilityMcpScope: async (metadata, run) => {
      seen.push(metadata);
      return run();
    },
  });
  const handler = server.server._requestHandlers.get("tools/list");
  assert.ok(handler);

  await handler(
    { method: "tools/list", params: {} },
    { requestInfo: { headers: { "mcp-protocol-version": version } } },
  );
  await handler(
    { method: "tools/list", params: {} },
    {
      requestInfo: {
        headers: { "mcp-protocol-version": "private-cardinality-value" },
      },
    },
  );

  assert.equal(seen[0].protocolVersion, version);
  assert.equal(seen[1].protocolVersion, undefined);
});

test("transport negotiation carries the actual MCP protocol revision forward", async () => {
  const expectedVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
  const scopes = [];
  const completions = [];
  let resolveInitializeSent;
  let resolveListSent;
  let resolveInitializeCompletion;
  let resolveListCompletion;
  const initializeSent = new Promise((resolve) => {
    resolveInitializeSent = resolve;
  });
  const listSent = new Promise((resolve) => {
    resolveListSent = resolve;
  });
  const initializeCompletion = new Promise((resolve) => {
    resolveInitializeCompletion = resolve;
  });
  const listCompletion = new Promise((resolve) => {
    resolveListCompletion = resolve;
  });
  const transport = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    async start() {},
    async send(message) {
      if (message?.id === 1) {
        resolveInitializeSent(message);
      } else if (message?.id === 2) {
        resolveListSent(message);
      }
    },
    async close() {},
  };
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityMcpScope: async (metadata, run) => {
      scopes.push(metadata);
      return run();
    },
    observabilityMcpSent: (
      token,
      failed,
      responseStatusCode,
      toolError,
      protocolVersion,
    ) => {
      completions.push({
        token,
        failed,
        responseStatusCode,
        toolError,
        protocolVersion,
      });
      if (completions.length === 1) {
        resolveInitializeCompletion();
      } else if (completions.length === 2) {
        resolveListCompletion();
      }
    },
  });

  await server.connect(transport);
  transport.onmessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2099-01-01",
      capabilities: {},
      clientInfo: { name: "review-test", version: "1.0.0" },
    },
  });
  const initializeResponse = await initializeSent;
  await initializeCompletion;
  await transport.onmessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  transport.onmessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  await listSent;
  await listCompletion;

  const initializeScope = scopes.find(({ method }) => method === "initialize");
  const listScope = scopes.find(({ method }) => method === "tools/list");
  assert.ok(initializeScope);
  assert.equal(initializeScope.protocolVersion, undefined);
  assert.equal(initializeResponse.result.protocolVersion, expectedVersion);
  assert.ok(listScope);
  assert.equal(listScope.protocolVersion, expectedVersion);
  assert.equal(completions[0].protocolVersion, expectedVersion);
  assert.equal(completions.at(-1).protocolVersion, expectedVersion);
  await server.close();
});

test("OpenTelemetry exports bounded MCP protocol version on spans and metrics", async () => {
  const version = SUPPORTED_PROTOCOL_VERSIONS[0];
  let metricExporter;
  let metricReader;
  let spanExporter;
  const runtime = await startOpenTelemetry({
    env: ENABLED_ENV,
    metricExporterFactory: () => {
      metricExporter = inMemoryMetricExporter();
      return metricExporter;
    },
    traceExporterFactory: () => {
      spanExporter = new InMemorySpanExporter();
      return spanExporter;
    },
    sdkFactory: (options) => {
      const { traceExporter, ...sdkOptions } = options;
      metricReader = options.metricReaders[0];
      return new NodeSDK({
        ...sdkOptions,
        spanProcessors: [new SimpleSpanProcessor(traceExporter)],
      });
    },
  });
  assert.equal(runtime.enabled, true);

  const token = Symbol("protocol-version");
  await runtime.observabilityMcpScope(
    {
      method: "tools/list",
      deploymentMode: "stdio",
      [OBSERVABILITY_OPERATION_TOKEN]: token,
    },
    async () => ({ tools: [] }),
  );
  runtime.observabilityMcpSent(token, false, undefined, false, version);
  await metricReader.forceFlush();

  const span = spanExporter
    .getFinishedSpans()
    .find(({ name }) => name === "tools/list");
  assert.ok(span);
  assert.equal(span.attributes[MCP_SEMCONV.protocolVersion], version);

  const operationDuration = metricDataByName(
    metricExporter,
    MCP_SEMCONV.serverOperationDuration,
  );
  const point = operationDuration?.dataPoints.find(
    ({ attributes }) =>
      attributes["mcp.method.name"] === "tools/list" &&
      attributes[MCP_SEMCONV.protocolVersion] === version,
  );
  assert.ok(point);
  await runtime.shutdown();
});
