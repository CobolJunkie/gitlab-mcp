import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
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

import { GitLabClient } from "../src/gitlab-client.mjs";
import {
  observeToolCall,
  runToolObservationScope,
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

function serializedTelemetry(spans, metricExports) {
  return JSON.stringify({
    spans: spans.map((span) => ({
      attributes: span.attributes,
      name: span.name,
      resource: span.resource.attributes,
      status: span.status,
    })),
    metrics: metricExports,
  });
}

async function listenGitLabStub(t) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 1 }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("exports bounded MCP spans and metrics without private payloads", async (t) => {
  const canary = "CANARY_OTEL_PRIVATE_PAYLOAD_7f5fce";
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

  t.after(async () => runtime.shutdown());
  assert.equal(runtime.enabled, true);

  const gitlabUrl = await listenGitLabStub(t);
  const client = new GitLabClient({
    allowInsecureHttp: true,
    baseUrl: gitlabUrl,
    token: `glpat-${canary}`,
  });
  const successResult = await runtime.observabilityMcpScope(
    {
      tool: "get_project",
      readOnly: false,
      deploymentMode: "stdio",
    },
    () =>
      runtime.observabilityToolScope(
        {
          tool: "get_project",
          readOnly: true,
          deploymentMode: "stdio",
        },
        () => client.request(`/projects/${canary}`),
      ),
  );
  assert.deepEqual(successResult, { data: { id: 1 } });

  const productError = new Error(`product failure: ${canary}`);
  await assert.rejects(
    runtime.observabilityMcpScope(
      {
        tool: "create_issue",
        readOnly: false,
        deploymentMode: "http",
      },
      () =>
        runtime.observabilityToolScope(
          {
            tool: "create_issue",
            readOnly: false,
            deploymentMode: "http",
          },
          async () => {
            throw productError;
          },
        ),
    ),
    (error) => error === productError,
  );

  const propagatedTraceId = "0af7651916cd43dd8448eb211c80319c";
  const propagatedParentSpanId = "b7ad6b7169203331";
  let ambientSpanContext;
  await trace
    .getTracer("@local/gitlab-mcp-test")
    .startActiveSpan("ambient-http", async (ambientSpan) => {
      ambientSpanContext = ambientSpan.spanContext();
      await runtime.observabilityMcpScope(
        {
          tool: "context_tool",
          readOnly: true,
          deploymentMode: "http",
          traceContext: {
            traceparent: `00-${propagatedTraceId}-${propagatedParentSpanId}-01`,
          },
        },
        () =>
          runtime.observabilityToolScope(
            {
              tool: "context_tool",
              readOnly: true,
              deploymentMode: "http",
            },
            async () => ({ ok: true }),
          ),
      );
      ambientSpan.end();
    });

  const listResult = await runtime.observabilityMcpScope(
    {
      method: "tools/list",
      readOnly: true,
      deploymentMode: "stdio",
    },
    async () => ({ tools: [] }),
  );
  assert.deepEqual(listResult, { tools: [] });

  runtime.observabilityObserver(
    observeToolCall({
      tool: "get_project",
      readOnly: true,
      deploymentMode: "stdio",
      outcome: "success",
      startedAt: 0,
      endedAt: 250,
    }),
  );
  runtime.observabilityObserver(
    observeToolCall({
      tool: "create_issue",
      readOnly: false,
      deploymentMode: "http",
      outcome: "error",
      error: productError,
      startedAt: 0,
      endedAt: 500,
    }),
  );

  await metricReader.forceFlush();

  const spans = spanExporter.getFinishedSpans();
  const successToolSpan = spans.find(
    ({ name }) => name === "execute_tool get_project",
  );
  const successServerSpan = spans.find(
    ({ name }) => name === "tools/call get_project",
  );
  const failedToolSpan = spans.find(
    ({ name }) => name === "execute_tool create_issue",
  );
  const failedServerSpan = spans.find(
    ({ name }) => name === "tools/call create_issue",
  );
  const contextServerSpan = spans.find(
    ({ name }) => name === "tools/call context_tool",
  );
  const listServerSpan = spans.find(({ name }) => name === "tools/list");
  const gitlabClientSpans = spans.filter(
    ({ kind }) => kind === SpanKind.CLIENT,
  );
  const [gitlabClientSpan] = gitlabClientSpans;

  assert.ok(successToolSpan);
  assert.ok(successServerSpan);
  assert.ok(failedToolSpan);
  assert.ok(failedServerSpan);
  assert.ok(contextServerSpan);
  assert.ok(listServerSpan);
  assert.equal(
    gitlabClientSpans.length,
    1,
    "expected exactly one instrumented GitLab client span",
  );
  assert.ok(gitlabClientSpan);
  assert.equal(successServerSpan.kind, SpanKind.SERVER);
  assert.equal(successToolSpan.kind, SpanKind.INTERNAL);
  assert.equal(listServerSpan.kind, SpanKind.SERVER);
  assert.equal(
    successToolSpan.spanContext().traceId,
    successServerSpan.spanContext().traceId,
  );
  assert.equal(
    successToolSpan.parentSpanContext?.spanId,
    successServerSpan.spanContext().spanId,
  );
  assert.equal(
    gitlabClientSpan.spanContext().traceId,
    successToolSpan.spanContext().traceId,
  );
  assert.equal(
    gitlabClientSpan.parentSpanContext?.spanId,
    successToolSpan.spanContext().spanId,
  );
  assert.equal(
    failedToolSpan.spanContext().traceId,
    failedServerSpan.spanContext().traceId,
  );
  assert.equal(
    failedToolSpan.parentSpanContext?.spanId,
    failedServerSpan.spanContext().spanId,
  );
  assert.equal(contextServerSpan.parentSpanContext?.traceId, propagatedTraceId);
  assert.equal(
    contextServerSpan.parentSpanContext?.spanId,
    propagatedParentSpanId,
  );
  assert.equal(contextServerSpan.parentSpanContext?.isRemote, true);
  assert.equal(contextServerSpan.links.length, 1);
  assert.equal(
    contextServerSpan.links[0].context.traceId,
    ambientSpanContext.traceId,
  );
  assert.equal(
    contextServerSpan.links[0].context.spanId,
    ambientSpanContext.spanId,
  );
  assert.equal(
    contextServerSpan.links[0].context.traceFlags,
    ambientSpanContext.traceFlags,
  );
  assert.equal(contextServerSpan.links[0].context.traceState, undefined);
  assert.deepEqual(successServerSpan.attributes, {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "get_project",
    "network.transport": "pipe",
  });
  assert.deepEqual(successToolSpan.attributes, {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "get_project",
  });
  assert.deepEqual(failedServerSpan.attributes, {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "create_issue",
    "network.transport": "tcp",
    "network.protocol.name": "http",
    "error.type": "Error",
  });
  assert.deepEqual(failedToolSpan.attributes, {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "create_issue",
    "error.type": "Error",
  });
  assert.deepEqual(listServerSpan.attributes, {
    "mcp.method.name": "tools/list",
    "network.transport": "pipe",
  });
  assert.equal(successServerSpan.status.code, SpanStatusCode.UNSET);
  assert.equal(successToolSpan.status.code, SpanStatusCode.UNSET);
  assert.equal(failedServerSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(failedToolSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(listServerSpan.status.code, SpanStatusCode.UNSET);
  for (const span of spans) {
    assert.equal(span.resource.attributes["service.name"], "gitlab-mcp");
  }

  const operationDuration = metricDataByName(
    metricExporter,
    MCP_SEMCONV.serverOperationDuration,
  );
  assert.ok(operationDuration);
  assert.equal(operationDuration.descriptor.unit, "s");
  assert.equal(operationDuration.dataPointType, DataPointType.HISTOGRAM);
  assert.deepEqual(
    operationDuration.dataPoints.map(({ attributes }) => attributes),
    [
      {
        "mcp.method.name": "tools/call",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "get_project",
        "network.transport": "pipe",
      },
      {
        "mcp.method.name": "tools/call",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "create_issue",
        "network.transport": "tcp",
        "network.protocol.name": "http",
        "error.type": "Error",
      },
      {
        "mcp.method.name": "tools/call",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "context_tool",
        "network.transport": "tcp",
        "network.protocol.name": "http",
      },
      {
        "mcp.method.name": "tools/list",
        "network.transport": "pipe",
      },
    ],
  );

  const executeToolDuration = metricDataByName(
    metricExporter,
    MCP_SEMCONV.executeToolDuration,
  );
  assert.ok(executeToolDuration);
  assert.equal(executeToolDuration.descriptor.unit, "s");
  assert.deepEqual(
    executeToolDuration.dataPoints.map(({ attributes }) => attributes),
    [
      {
        "gen_ai.tool.name": "get_project",
      },
      {
        "gen_ai.tool.name": "create_issue",
        "error.type": "Error",
      },
    ],
  );

  assert.doesNotMatch(
    serializedTelemetry(spans, metricExporter.getMetrics()),
    new RegExp(canary),
  );
});

test("trace exporter failures cannot alter tool success or product errors", async (t) => {
  const exporterFailure = new Error("trace exporter unavailable");
  const productFailure = new TypeError("product failure");
  const runtime = await startOpenTelemetry({
    env: OTEL_TEST_ENV,
    metricExporterFactory: () =>
      new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    traceExporterFactory: () => ({
      export() {
        throw exporterFailure;
      },
      shutdown: async () => undefined,
    }),
    sdkFactory: (options) => {
      const { traceExporter, ...sdkOptions } = options;
      return new NodeSDK({
        ...sdkOptions,
        spanProcessors: [new SimpleSpanProcessor(traceExporter)],
      });
    },
  });

  t.after(async () => runtime.shutdown());
  assert.equal(runtime.enabled, true);

  const success = await runToolObservationScope({
    scope: runtime.observabilityToolScope,
    tool: "get_project",
    readOnly: true,
    deploymentMode: "stdio",
    operation: async () => ({ id: 1 }),
  });
  assert.deepEqual(success, { id: 1 });

  await assert.rejects(
    runToolObservationScope({
      scope: runtime.observabilityToolScope,
      tool: "create_issue",
      readOnly: false,
      deploymentMode: "http",
      operation: async () => {
        throw productFailure;
      },
    }),
    (error) => error === productFailure,
  );
});
