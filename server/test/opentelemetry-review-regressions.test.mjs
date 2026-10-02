import assert from "node:assert/strict";
import test from "node:test";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { OBSERVABILITY_OPERATION_TOKEN } from "../src/observability.mjs";
import { MCP_SEMCONV } from "../src/opentelemetry-semconv.mjs";
import { startOpenTelemetry } from "../src/opentelemetry.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

const OTEL_TEST_ENV = Object.freeze({
  MCP_OTEL_ENABLED: "true",
  MCP_OTEL_EXPORT_TIMEOUT_MS: "1000",
  MCP_OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
  MCP_OTEL_SHUTDOWN_TIMEOUT_MS: "1000",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector.invalid/v1/metrics",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.invalid/v1/traces",
});

function metricDataByName(exporter, name) {
  return exporter
    .getMetrics()
    .flatMap(({ scopeMetrics }) => scopeMetrics)
    .flatMap(({ metrics }) => metrics)
    .find(({ descriptor }) => descriptor.name === name);
}

function hrTimeSeconds([seconds, nanoseconds]) {
  return seconds + nanoseconds / 1_000_000_000;
}

async function inMemoryRuntime(t) {
  let metricExporter;
  let metricReader;
  let spanExporter;
  const runtime = await startOpenTelemetry({
    env: OTEL_TEST_ENV,
    metricExporterFactory: () => {
      metricExporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE,
      );
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
  t.after(async () => runtime.shutdown());
  return { metricExporter, metricReader, runtime, spanExporter };
}

function testTransport() {
  const sent = [];
  return {
    sent,
    transport: {
      onmessage: undefined,
      onclose: undefined,
      onerror: undefined,
      async start() {},
      async send(message) {
        sent.push(message);
      },
      async close() {},
    },
  };
}

test("review regression coverage", async (t) => {
  const { metricExporter, metricReader, runtime, spanExporter } =
    await inMemoryRuntime(t);

  await t.test(
    "protocol-level JSON-RPC rejections retain MCP server telemetry without changing behavior",
    async () => {
      const { sent: controlSent, transport: controlTransport } =
        testTransport();
      const controlServer = createGitLabMcpServer({
        clientFactory: () => ({}),
        deploymentMode: "stdio",
      });
      await controlServer.connect(controlTransport);
      await controlTransport.onmessage({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {},
      });
      await controlServer.close();

      const { sent, transport } = testTransport();
      const server = createGitLabMcpServer({
        clientFactory: () => ({}),
        deploymentMode: "stdio",
        observabilityMcpScope: runtime.observabilityMcpScope,
        observabilityMcpSent: runtime.observabilityMcpSent,
        observabilityObserver: runtime.observabilityObserver,
        observabilityToolScope: runtime.observabilityToolScope,
      });
      await server.connect(transport);
      await transport.onmessage({
        jsonrpc: "2.0",
        id: 101,
        method: "private-user-controlled-method-name",
        params: {},
      });
      await transport.onmessage({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: {},
      });
      await server.close();
      await metricReader.forceFlush();

      assert.equal(controlSent.length, 1);
      assert.equal(sent.length, 2);
      assert.equal(sent[0].error.code, -32601);
      assert.equal(sent[1].error.code, controlSent[0].error.code);
      assert.equal(sent[1].error.code, -32603);

      const spans = spanExporter.getFinishedSpans();
      const unknownMethodSpan = spans.find(({ name }) => name === "unknown");
      const invalidToolCallSpan = spans.find(({ name }) =>
        name.startsWith("tools/call"),
      );
      assert.ok(unknownMethodSpan);
      assert.ok(invalidToolCallSpan);
      assert.equal(unknownMethodSpan.attributes["mcp.method.name"], "unknown");
      assert.equal(
        unknownMethodSpan.attributes["rpc.response.status_code"],
        "-32601",
      );
      assert.equal(unknownMethodSpan.attributes["error.type"], undefined);
      assert.equal(unknownMethodSpan.status.code, SpanStatusCode.UNSET);
      assert.equal(
        invalidToolCallSpan.attributes["rpc.response.status_code"],
        "-32603",
      );
      assert.equal(invalidToolCallSpan.attributes["error.type"], "-32603");
      assert.equal(invalidToolCallSpan.status.code, SpanStatusCode.ERROR);

      const operationDuration = metricDataByName(
        metricExporter,
        MCP_SEMCONV.serverOperationDuration,
      );
      assert.ok(operationDuration);
      const statusCodes = operationDuration.dataPoints
        .map(({ attributes }) => attributes["rpc.response.status_code"])
        .filter(Boolean)
        .sort();
      assert.deepEqual(statusCodes, ["-32601", "-32603"]);
      const internalErrorPoint = operationDuration.dataPoints.find(
        ({ attributes }) => attributes["rpc.response.status_code"] === "-32603",
      );
      assert.equal(internalErrorPoint?.attributes["error.type"], "-32603");
    },
  );

  await t.test(
    "execute-tool metric duration matches its span duration",
    async () => {
      const server = createGitLabMcpServer({
        clientFactory: () => ({}),
        deploymentMode: "stdio",
        observabilityObserver: runtime.observabilityObserver,
        observabilityToolScope: runtime.observabilityToolScope,
      });
      const handler = server.server._requestHandlers.get("tools/call");
      assert.ok(handler);
      const response = await handler(
        {
          method: "tools/call",
          params: { name: "get_runtime_info", arguments: {} },
        },
        {},
      );
      await server.close().catch(() => undefined);
      assert.equal(response.isError, undefined);
      await metricReader.forceFlush();

      const toolSpan = spanExporter
        .getFinishedSpans()
        .find(({ name }) => name === "execute_tool get_runtime_info");
      assert.ok(toolSpan);
      const executeToolDuration = metricDataByName(
        metricExporter,
        MCP_SEMCONV.executeToolDuration,
      );
      assert.ok(executeToolDuration);
      const dataPoint = executeToolDuration.dataPoints.find(
        ({ attributes }) =>
          attributes["gen_ai.tool.name"] === "get_runtime_info",
      );
      assert.ok(dataPoint);
      assert.ok(
        Math.abs(dataPoint.value.sum - hrTimeSeconds(toolSpan.duration)) < 1e-6,
        `metric ${dataPoint.value.sum}s != span ${hrTimeSeconds(toolSpan.duration)}s`,
      );
    },
  );

  await t.test(
    "non-tool results cannot be misclassified as tool errors",
    async () => {
      const token = Symbol("non-tool-result");
      await runtime.observabilityMcpScope(
        {
          method: "resources/list",
          deploymentMode: "stdio",
          [OBSERVABILITY_OPERATION_TOKEN]: token,
        },
        async () => ({ isError: true }),
      );
      runtime.observabilityMcpSent(token, false, undefined, true);
      await metricReader.forceFlush();

      const span = spanExporter
        .getFinishedSpans()
        .find(({ name }) => name === "resources/list");
      assert.ok(span);
      assert.equal(span.attributes["error.type"], undefined);
      assert.equal(span.status.code, SpanStatusCode.UNSET);
    },
  );
});
