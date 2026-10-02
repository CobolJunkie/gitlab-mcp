import assert from "node:assert/strict";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

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

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("HTTP mode emits bounded standard server request metrics", async (t) => {
  let metricExporter;
  let metricReader;
  const runtime = await startOpenTelemetry({
    env: OTEL_TEST_ENV,
    metricExporterFactory: () => {
      metricExporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE,
      );
      return metricExporter;
    },
    traceExporterFactory: () => new InMemorySpanExporter(),
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

  const { createHttpApp } = await import("../src/http.mjs");
  const { app } = createHttpApp({
    allowServerToken: true,
    errorLogger: () => undefined,
    host: "127.0.0.1",
    port: 3_000,
    requestIdFactory: () => "otel-http-test",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  t.after(() => closeServer(server));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const canary = "CANARY_HTTP_METRIC_PRIVATE_PATH_7f5fce";
  const response = await fetch(
    `http://127.0.0.1:${address.port}/private/${canary}?secret=${canary}`,
  );
  assert.equal(response.status, 404);
  await response.text();
  await metricReader.forceFlush();

  const duration = metricDataByName(
    metricExporter,
    "http.server.request.duration",
  );
  assert.ok(duration, "expected standard HTTP server request duration metric");
  assert.equal(duration.descriptor.unit, "s");
  assert.ok(duration.dataPoints.length >= 1);

  const attributes = duration.dataPoints.at(-1).attributes;
  assert.equal(attributes["http.request.method"], "GET");
  assert.equal(attributes["url.scheme"], "http");
  assert.equal(attributes["url.path"], undefined);
  assert.equal(attributes["url.query"], undefined);
  assert.doesNotMatch(JSON.stringify(duration), new RegExp(canary));
});
