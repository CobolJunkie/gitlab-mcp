import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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

import {
  OBSERVABILITY_OPERATION_STARTED_AT,
  OBSERVABILITY_OPERATION_START_TIME,
  OBSERVABILITY_OPERATION_TOKEN,
} from "../src/observability.mjs";
import { MCP_SEMCONV } from "../src/opentelemetry-semconv.mjs";
import { startOpenTelemetry } from "../src/opentelemetry.mjs";

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

function hrTimeToMilliseconds([seconds, nanoseconds]) {
  return seconds * 1_000 + nanoseconds / 1_000_000;
}

test("MCP telemetry completion lifecycle follows transport delivery", async () => {
  let metricExporter;
  let metricReader;
  let spanExporter;
  let shutdownSpans = [];
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
      return {
        export: (spans, callback) => spanExporter.export(spans, callback),
        shutdown: () => {
          shutdownSpans = [...spanExporter.getFinishedSpans()];
          return spanExporter.shutdown();
        },
      };
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

  const normalToken = Symbol("normal-send");
  const receiveDelayMs = 75;
  const receivedAt = performance.now() - receiveDelayMs;
  const receivedTime = Date.now() - receiveDelayMs;
  const normalResult = await runtime.observabilityMcpScope(
    {
      method: "tools/list",
      deploymentMode: "stdio",
      [OBSERVABILITY_OPERATION_TOKEN]: normalToken,
      [OBSERVABILITY_OPERATION_STARTED_AT]: receivedAt,
      [OBSERVABILITY_OPERATION_START_TIME]: receivedTime,
    },
    async () => ({ tools: [] }),
  );
  assert.deepEqual(normalResult, { tools: [] });
  assert.equal(spanExporter.getFinishedSpans().length, 0);

  runtime.observabilityMcpSent(normalToken, false);
  await metricReader.forceFlush();
  const normalSpan = spanExporter
    .getFinishedSpans()
    .find(({ name }) => name === "tools/list");
  assert.ok(normalSpan);
  assert.equal(normalSpan.status.code, SpanStatusCode.UNSET);
  assert.ok(
    Math.abs(hrTimeToMilliseconds(normalSpan.startTime) - receivedTime) < 50,
  );

  const operationDuration = metricDataByName(
    metricExporter,
    MCP_SEMCONV.serverOperationDuration,
  );
  const normalDuration = operationDuration?.dataPoints.find(
    ({ attributes }) => attributes["mcp.method.name"] === "tools/list",
  );
  assert.ok(normalDuration);
  assert.ok(normalDuration.value.sum >= receiveDelayMs / 1_000);

  const earlyFailureToken = Symbol("early-failed-send");
  runtime.observabilityMcpSent(earlyFailureToken, true);
  await runtime.observabilityMcpScope(
    {
      method: "resources/list",
      deploymentMode: "stdio",
      [OBSERVABILITY_OPERATION_TOKEN]: earlyFailureToken,
    },
    async () => ({ resources: [] }),
  );
  await metricReader.forceFlush();
  const earlyFailureSpan = spanExporter
    .getFinishedSpans()
    .find(({ name }) => name === "resources/list");
  assert.ok(earlyFailureSpan);
  assert.equal(earlyFailureSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(earlyFailureSpan.attributes["error.type"], "Error");

  const cancelledToken = Symbol("cancelled");
  await runtime.observabilityMcpScope(
    {
      method: "resources/read",
      deploymentMode: "stdio",
      [OBSERVABILITY_OPERATION_TOKEN]: cancelledToken,
    },
    async () => ({ contents: [] }),
  );
  runtime.observabilityMcpSent(
    cancelledToken,
    true,
    undefined,
    false,
    undefined,
    true,
  );
  await metricReader.forceFlush();
  const cancelledSpan = spanExporter
    .getFinishedSpans()
    .find(({ name }) => name === "resources/read");
  assert.ok(cancelledSpan);
  assert.equal(cancelledSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(cancelledSpan.attributes["error.type"], "cancelled");

  let releaseIgnoredHandler;
  let markIgnoredHandlerStarted;
  const ignoredHandlerGate = new Promise((resolve) => {
    releaseIgnoredHandler = resolve;
  });
  const ignoredHandlerStarted = new Promise((resolve) => {
    markIgnoredHandlerStarted = resolve;
  });
  const ignoredCancellationToken = Symbol("cancelled-while-handler-running");
  const ignoredHandlerOperation = runtime.observabilityMcpScope(
    {
      method: "resources/templates/list",
      deploymentMode: "stdio",
      [OBSERVABILITY_OPERATION_TOKEN]: ignoredCancellationToken,
    },
    async () => {
      markIgnoredHandlerStarted();
      await ignoredHandlerGate;
      return { resourceTemplates: [] };
    },
  );
  await ignoredHandlerStarted;
  runtime.observabilityMcpSent(
    ignoredCancellationToken,
    true,
    undefined,
    false,
    undefined,
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await metricReader.forceFlush();

  const ignoredCancellationSpans = () =>
    spanExporter
      .getFinishedSpans()
      .filter(({ name }) => name === "resources/templates/list");
  assert.equal(ignoredCancellationSpans().length, 1);
  assert.equal(
    ignoredCancellationSpans()[0].attributes["error.type"],
    "cancelled",
  );

  releaseIgnoredHandler();
  await ignoredHandlerOperation;
  await metricReader.forceFlush();
  assert.equal(ignoredCancellationSpans().length, 1);

  const shutdownToken = Symbol("shutdown-pending");
  await runtime.observabilityMcpScope(
    {
      method: "prompts/list",
      deploymentMode: "stdio",
      [OBSERVABILITY_OPERATION_TOKEN]: shutdownToken,
    },
    async () => ({ prompts: [] }),
  );
  assert.equal(
    spanExporter.getFinishedSpans().some(({ name }) => name === "prompts/list"),
    false,
  );

  await runtime.shutdown();
  const shutdownSpan = shutdownSpans.find(
    ({ name }) => name === "prompts/list",
  );
  assert.ok(shutdownSpan);
  assert.equal(shutdownSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(shutdownSpan.attributes["error.type"], "Error");
});
