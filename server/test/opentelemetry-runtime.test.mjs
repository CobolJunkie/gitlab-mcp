import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  sanitizeOtelSpanForExport,
  startOpenTelemetry,
} from "../src/opentelemetry.mjs";

const ENABLED_ENV = Object.freeze({
  MCP_OTEL_ENABLED: "true",
  MCP_OTEL_EXPORT_TIMEOUT_MS: "1000",
  MCP_OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
  MCP_OTEL_SHUTDOWN_TIMEOUT_MS: "100",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector.invalid/v1/metrics",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.invalid/v1/traces",
});

function inMemoryMetricExporter() {
  return new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
}

function fakeSdkFactory(options, overrides = {}) {
  return {
    options,
    start: () => undefined,
    shutdown: async () => undefined,
    ...overrides,
  };
}

test("disabled or incomplete telemetry never constructs exporters", async () => {
  let exporterFactoryCalls = 0;
  const factories = {
    traceExporterFactory() {
      exporterFactoryCalls += 1;
      return new InMemorySpanExporter();
    },
    metricExporterFactory() {
      exporterFactoryCalls += 1;
      return inMemoryMetricExporter();
    },
  };

  const disabled = await startOpenTelemetry({
    env: {},
    ...factories,
  });
  const incomplete = await startOpenTelemetry({
    env: { MCP_OTEL_ENABLED: "true" },
    ...factories,
  });

  assert.equal(disabled.enabled, false);
  assert.equal(incomplete.enabled, false);
  assert.equal(exporterFactoryCalls, 0);
});

test("preserves signal-specific OTLP endpoints and applies export timeout", async () => {
  const tracesEndpoint = "https://collector.invalid/custom/traces/?tenant=blue";
  const metricsEndpoint =
    "https://collector.invalid/custom/metrics/?tenant=blue";
  let traceOptions;
  let metricOptions;
  const runtime = await startOpenTelemetry({
    env: {
      ...ENABLED_ENV,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesEndpoint,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metricsEndpoint,
    },
    traceExporterFactory(options) {
      traceOptions = options;
      return new InMemorySpanExporter();
    },
    metricExporterFactory(options) {
      metricOptions = options;
      return inMemoryMetricExporter();
    },
    sdkFactory: fakeSdkFactory,
  });

  assert.equal(runtime.enabled, true);
  assert.deepEqual(traceOptions, {
    url: tracesEndpoint,
    timeoutMillis: 1_000,
  });
  assert.deepEqual(metricOptions, {
    url: metricsEndpoint,
    timeoutMillis: 1_000,
  });
  await runtime.shutdown();
});

test("registers only the standard OBS-02 instrumentations", async () => {
  let sdkOptions;
  const runtime = await startOpenTelemetry({
    env: ENABLED_ENV,
    traceExporterFactory: () => new InMemorySpanExporter(),
    metricExporterFactory: inMemoryMetricExporter,
    sdkFactory(options) {
      sdkOptions = options;
      return fakeSdkFactory(options);
    },
  });

  assert.equal(runtime.enabled, true);
  assert.deepEqual(
    sdkOptions.instrumentations.map(
      (instrumentation) => instrumentation.constructor.name,
    ),
    [
      "HttpInstrumentation",
      "UndiciInstrumentation",
      "HostMetricsInstrumentation",
      "RuntimeNodeInstrumentation",
    ],
  );
  await runtime.shutdown();
});

test("disables NodeSDK environment-driven log exporters", async () => {
  let sdkOptions;
  const runtime = await startOpenTelemetry({
    env: ENABLED_ENV,
    traceExporterFactory: () => new InMemorySpanExporter(),
    metricExporterFactory: inMemoryMetricExporter,
    sdkFactory(options) {
      sdkOptions = options;
      return fakeSdkFactory(options);
    },
  });

  assert.equal(runtime.enabled, true);
  assert.deepEqual(sdkOptions.logRecordProcessors, []);
  await runtime.shutdown();
});

test("SDK startup failures clean up and fail open", async () => {
  let shutdownCalls = 0;
  const runtime = await startOpenTelemetry({
    env: ENABLED_ENV,
    traceExporterFactory: () => new InMemorySpanExporter(),
    metricExporterFactory: inMemoryMetricExporter,
    sdkFactory(options) {
      return fakeSdkFactory(options, {
        start() {
          throw new Error("telemetry bootstrap unavailable");
        },
        async shutdown() {
          shutdownCalls += 1;
        },
      });
    },
  });

  assert.equal(runtime.enabled, false);
  assert.equal(shutdownCalls, 1);
  await runtime.shutdown();
});

test("partial bootstrap failures clean up constructed exporters", async () => {
  let traceShutdownCalls = 0;
  const runtime = await startOpenTelemetry({
    env: ENABLED_ENV,
    traceExporterFactory: () => ({
      export() {},
      async shutdown() {
        traceShutdownCalls += 1;
      },
    }),
    metricExporterFactory() {
      throw new Error("metric exporter unavailable");
    },
  });

  assert.equal(runtime.enabled, false);
  assert.equal(traceShutdownCalls, 1);
  await runtime.shutdown();
});

test("shutdown failures are bounded and fail open", async () => {
  const runtime = await startOpenTelemetry({
    env: ENABLED_ENV,
    traceExporterFactory: () => new InMemorySpanExporter(),
    metricExporterFactory: inMemoryMetricExporter,
    sdkFactory(options) {
      return fakeSdkFactory(options, {
        shutdown: () => new Promise(() => undefined),
      });
    },
  });

  const startedAt = performance.now();
  await runtime.shutdown();
  const elapsedMs = performance.now() - startedAt;

  assert.equal(runtime.enabled, true);
  assert.ok(elapsedMs >= 75, `shutdown returned too early: ${elapsedMs} ms`);
  assert.ok(elapsedMs < 1_000, `shutdown was not bounded: ${elapsedMs} ms`);
});

test("trace export uses a fail-closed privacy projection", () => {
  const canary = "CANARY_PRIVATE_OTEL_VALUE";
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const spanId = "b7ad6b7169203331";
  const traceState = {
    serialize() {
      return `vendor=${canary}`;
    },
  };
  const span = {
    name: `GET /private/${canary}`,
    attributes: {
      "server.address": `${canary}.example.com`,
      "http.request.method": "GET",
      "http.request.method_original": canary,
      "url.full": `https://gitlab.example.com/private/${canary}?token=${canary}`,
      "url.path": `/private/${canary}`,
      "url.query": `token=${canary}`,
      "http.request.header.authorization": `Bearer ${canary}`,
      "user_agent.original": canary,
      "future.semconv.attribute": canary,
      "url.scheme": "https",
      "network.protocol.version": "1.1",
    },
    events: [
      {
        name: `private-event-${canary}`,
        attributes: {
          "exception.type": canary,
          "exception.message": canary,
          "exception.stacktrace": `Error: ${canary}`,
        },
      },
    ],
    links: [
      {
        context: {
          traceId,
          spanId,
          traceFlags: 1,
          isRemote: true,
          traceState,
        },
        attributes: {
          "url.path": `/private/${canary}`,
          "http.request.method": "GET",
        },
      },
    ],
    parentSpanContext: {
      traceId,
      spanId,
      traceFlags: 1,
      isRemote: true,
      traceState,
    },
    spanContext() {
      return {
        traceId,
        spanId,
        traceFlags: 1,
        isRemote: false,
        traceState,
      };
    },
    status: {
      code: 2,
      message: `request failed: ${canary}`,
    },
  };

  const sanitized = sanitizeOtelSpanForExport(span);

  assert.equal(sanitized.name, "HTTP GET");
  assert.deepEqual(sanitized.attributes, {
    "http.request.method": "GET",
    "url.scheme": "https",
    "network.protocol.version": "1.1",
  });
  assert.equal(sanitized.events[0].name, "event");
  assert.deepEqual(sanitized.events[0].attributes, {});
  assert.deepEqual(sanitized.links[0].attributes, {
    "http.request.method": "GET",
  });
  assert.equal(sanitized.links[0].context.traceState, undefined);
  assert.equal(sanitized.parentSpanContext.traceState, undefined);
  assert.equal(sanitized.spanContext().traceState, undefined);
  assert.deepEqual(sanitized.status, { code: 2 });
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(canary));
});
