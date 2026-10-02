import assert from "node:assert/strict";
import test from "node:test";

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import {
  GITLAB_MCP_METRIC_CONTRACT,
  registerMetricIdentifier,
  resetMetricContractStateForTest,
} from "../src/metric-contract.mjs";
import { observeMetric } from "../src/observability.mjs";
import { startOpenTelemetry } from "../src/opentelemetry.mjs";

const CUSTOM_METRIC_INSTRUMENTATION_NAME = "@local/gitlab-mcp/custom-metrics";
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

function fixtureAttributes(definition) {
  return Object.fromEntries(
    Object.entries(definition.attributes).map(([name, attribute]) => [
      name,
      attribute.kind === "identifier"
        ? "unregistered_fixture"
        : attribute.values[0],
    ]),
  );
}

function assertContractView(options, metric) {
  const definition = GITLAB_MCP_METRIC_CONTRACT.metrics[metric];
  const view = options.views.find(
    (candidate) => candidate.instrumentName === metric,
  );
  assert.ok(view);
  assert.equal(view.meterName, CUSTOM_METRIC_INSTRUMENTATION_NAME);
  assert.equal(view.aggregationCardinalityLimit, definition.cardinalityBudget);
  const attributes = fixtureAttributes(definition);
  attributes.private_project = "private/project";
  const projected = view.attributesProcessors.reduce(
    (current, processor) => processor.process(current),
    attributes,
  );
  assert.equal(projected.private_project, undefined);
  assert.deepEqual(
    Object.keys(projected).sort(),
    Object.keys(definition.attributes).sort(),
  );
  for (const [name, attribute] of Object.entries(definition.attributes)) {
    if (attribute.kind === "identifier") {
      assert.equal(projected[name], "unknown");
    } else {
      assert.ok(attribute.values.includes(projected[name]));
    }
  }
}

test("custom metric contract instruments reach the OpenTelemetry exporter", async (t) => {
  resetMetricContractStateForTest();
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
      assert.equal(
        options.views.length,
        Object.keys(GITLAB_MCP_METRIC_CONTRACT.metrics).length,
      );
      assertContractView(options, "gitlab_mcp.tool.calls");
      assertContractView(options, "gitlab_mcp.cache.requests");
      const { traceExporter, ...sdkOptions } = options;
      metricReader = options.metricReaders[0];
      return new NodeSDK({
        ...sdkOptions,
        spanProcessors: [new SimpleSpanProcessor(traceExporter)],
      });
    },
  });

  t.after(async () => {
    resetMetricContractStateForTest();
    await runtime.shutdown();
  });
  assert.equal(runtime.enabled, true);
  assert.equal(registerMetricIdentifier("tool", "get_project"), true);

  observeMetric({
    observer: runtime.observabilityObserver,
    metric: "gitlab_mcp.tool.calls",
    attributes: {
      tool: "get_project",
      access: "read",
      outcome: "success",
      error_category: "none",
    },
  });
  observeMetric({
    observer: runtime.observabilityObserver,
    metric: "gitlab_mcp.tool.handler.duration",
    value: 0.25,
    attributes: {
      tool: "get_project",
      access: "read",
      outcome: "success",
    },
  });

  const customMeter = metrics.getMeter(CUSTOM_METRIC_INSTRUMENTATION_NAME);
  const bypassToolCounter = customMeter.createCounter(
    "gitlab_mcp.tool.presentation.truncations",
  );
  bypassToolCounter.add(1, {
    tool: "private/project",
    outcome: "success",
    private_project: "private/project",
  });

  const cacheDefinition =
    GITLAB_MCP_METRIC_CONTRACT.metrics["gitlab_mcp.cache.requests"];
  const bypassCounter = customMeter.createCounter("gitlab_mcp.cache.requests");
  for (
    let index = 0;
    index < cacheDefinition.cardinalityBudget + 4;
    index += 1
  ) {
    bypassCounter.add(1, {
      cache: index === 0 ? "private/project" : `bypass_${index}`,
      result: "hit",
      private_project: "private/project",
    });
  }

  await metricReader.forceFlush();

  const calls = metricDataByName(metricExporter, "gitlab_mcp.tool.calls");
  assert.ok(calls);
  assert.equal(calls.descriptor.unit, "{call}");
  assert.equal(calls.dataPointType, DataPointType.SUM);
  const legitimateCall = calls.dataPoints.find(
    (point) => point.attributes.tool === "get_project",
  );
  assert.ok(legitimateCall);
  assert.equal(legitimateCall.value, 1);
  assert.deepEqual(legitimateCall.attributes, {
    tool: "get_project",
    access: "read",
    outcome: "success",
    error_category: "none",
  });

  const presentationTruncations = metricDataByName(
    metricExporter,
    "gitlab_mcp.tool.presentation.truncations",
  );
  assert.ok(presentationTruncations);
  assert.equal(presentationTruncations.dataPointType, DataPointType.SUM);
  const boundedBypassCall = presentationTruncations.dataPoints.find(
    (point) => point.attributes.tool === "unknown",
  );
  assert.ok(boundedBypassCall);
  assert.equal(boundedBypassCall.value, 1);
  assert.deepEqual(boundedBypassCall.attributes, {
    tool: "unknown",
    outcome: "success",
  });

  const duration = metricDataByName(
    metricExporter,
    "gitlab_mcp.tool.handler.duration",
  );
  assert.ok(duration);
  assert.equal(duration.descriptor.unit, "s");
  assert.equal(duration.dataPointType, DataPointType.HISTOGRAM);
  assert.equal(duration.dataPoints.length, 1);
  assert.deepEqual(duration.dataPoints[0].attributes, {
    tool: "get_project",
    access: "read",
    outcome: "success",
  });
  assert.equal(duration.dataPoints[0].value.count, 1);
  assert.equal(duration.dataPoints[0].value.sum, 0.25);
  assert.deepEqual(
    duration.dataPoints[0].value.buckets.boundaries,
    GITLAB_MCP_METRIC_CONTRACT.metrics["gitlab_mcp.tool.handler.duration"]
      .boundaries,
  );

  const cacheRequests = metricDataByName(
    metricExporter,
    "gitlab_mcp.cache.requests",
  );
  assert.ok(cacheRequests);
  assert.ok(
    cacheRequests.dataPoints.length <= cacheDefinition.cardinalityBudget,
  );
  for (const point of cacheRequests.dataPoints) {
    assert.equal(Object.hasOwn(point.attributes, "private_project"), false);
    for (const attribute of Object.keys(point.attributes)) {
      assert.ok(
        Object.hasOwn(cacheDefinition.attributes, attribute) ||
          attribute === "otel.metric.overflow",
      );
    }
  }
  const serializedMetrics = JSON.stringify(metricExporter.getMetrics());
  assert.equal(serializedMetrics.includes("private/project"), false);
  assert.equal(serializedMetrics.includes("bypass_"), false);
});
