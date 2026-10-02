import {
  context,
  isSpanContextValid,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HostMetricsInstrumentation } from "@opentelemetry/instrumentation-host-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

import metricContractDocument from "./gitlab-metric-contract.json" with { type: "json" };
import { sanitizeMetricMeasurement } from "./metric-contract.mjs";
import { boundedMcpProtocolVersion } from "./mcp-protocol.mjs";
import {
  boundedObservabilityErrorType,
  OBSERVABILITY_OPERATION_COMPLETION,
  OBSERVABILITY_OPERATION_STARTED_AT,
  OBSERVABILITY_OPERATION_START_TIME,
  OBSERVABILITY_OPERATION_TOKEN,
} from "./observability.mjs";
import {
  classifyMcpServerCompletion,
  EXECUTE_TOOL_DURATION_BOUNDARIES,
  MCP_SEMCONV,
  MCP_SERVER_OPERATION_DURATION_BOUNDARIES,
  mcpTransportAttributes,
  toExecuteToolDuration,
} from "./opentelemetry-semconv.mjs";
import { createTraceparentOnlyPropagator } from "./traceparent-propagator.mjs";

const INSTRUMENTATION_NAME = "@local/gitlab-mcp";
const CUSTOM_METRIC_INSTRUMENTATION_NAME = "@local/gitlab-mcp/custom-metrics";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const MAX_EARLY_MCP_COMPLETIONS = 1_024;
const EMPTY_METRIC_ATTRIBUTES = Object.freeze({});

const SAFE_SPAN_ATTRIBUTE_KEYS = new Set([
  "error.type",
  "gen_ai.operation.name",
  "gen_ai.tool.name",
  "http.request.method",
  "http.request.resend_count",
  "http.response.status_code",
  "mcp.method.name",
  MCP_SEMCONV.protocolVersion,
  "network.protocol.name",
  "network.protocol.version",
  "network.transport",
  "rpc.response.status_code",
  "url.scheme",
]);
const SAFE_SPAN_STRING_VALUE = /^[A-Za-z0-9._:/-]{1,128}$/u;
const SAFE_HTTP_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "QUERY",
  "TRACE",
]);

const DISABLED_RUNTIME = Object.freeze({
  enabled: false,
  observabilityObserver: undefined,
  observabilityMcpScope: undefined,
  observabilityMcpSent: undefined,
  observabilityToolScope: undefined,
  shutdown: async () => undefined,
});

function contractMetricAttributesProcessor(instrumentName) {
  return Object.freeze({
    process(attributes) {
      try {
        return (
          sanitizeMetricMeasurement({
            metric: instrumentName,
            value: 1,
            attributes,
          })?.attributes || EMPTY_METRIC_ATTRIBUTES
        );
      } catch {
        return EMPTY_METRIC_ATTRIBUTES;
      }
    },
  });
}

function metricContractViews() {
  return Object.entries(metricContractDocument.metrics).map(
    ([instrumentName, definition]) => ({
      instrumentName,
      meterName: CUSTOM_METRIC_INSTRUMENTATION_NAME,
      attributesProcessors: [contractMetricAttributesProcessor(instrumentName)],
      aggregationCardinalityLimit: definition.cardinalityBudget,
    }),
  );
}

function boundedInteger(value, fallback, { min = MIN_TIMEOUT_MS, max } = {}) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function validatedOtlpEndpoint(value) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("OTLP endpoint must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("OTLP endpoint must not contain embedded credentials.");
  }
  return url;
}

function normalizedOtlpBaseEndpoint(value) {
  if (!value) {
    return undefined;
  }
  const url = validatedOtlpEndpoint(value);
  url.search = "";
  url.hash = "";
  let pathname = url.pathname;
  while (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;
  return url;
}

function resolveSignalEndpoint(env, signal) {
  const signalValue = env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`];
  if (signalValue) {
    validatedOtlpEndpoint(signalValue);
    return signalValue;
  }
  const base = normalizedOtlpBaseEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!base) {
    return undefined;
  }
  const signalPath = `/v1/${signal.toLowerCase()}`;
  base.pathname =
    base.pathname === "/" ? signalPath : `${base.pathname}${signalPath}`;
  return base.toString();
}

function boundedSpanInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function normalizedSafeSpanAttribute(key, value) {
  if (!SAFE_SPAN_ATTRIBUTE_KEYS.has(key)) {
    return undefined;
  }
  if (key === "http.request.method") {
    const method = String(value || "").toUpperCase();
    return SAFE_HTTP_METHODS.has(method) ? method : "_OTHER";
  }
  if (key === "http.response.status_code") {
    return boundedSpanInteger(value, 100, 599);
  }
  if (key === "http.request.resend_count") {
    return boundedSpanInteger(value, 0, 1_000);
  }
  if (key === MCP_SEMCONV.protocolVersion) {
    return boundedMcpProtocolVersion(value);
  }
  if (key === "url.scheme") {
    return value === "http" || value === "https" ? value : undefined;
  }
  if (typeof value !== "string" || !SAFE_SPAN_STRING_VALUE.test(value)) {
    return undefined;
  }
  return value;
}

function sanitizedSpanAttributes(attributes) {
  const sanitized = {};
  if (!attributes || typeof attributes !== "object") {
    return sanitized;
  }
  for (const [key, value] of Object.entries(attributes)) {
    const safeValue = normalizedSafeSpanAttribute(key, value);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}

function sanitizedSpanContext(spanContext) {
  if (!spanContext || typeof spanContext !== "object") {
    return spanContext;
  }
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    ...(spanContext.isRemote === undefined
      ? undefined
      : { isRemote: spanContext.isRemote === true }),
  };
}

function sanitizedSpanName(attributes) {
  const httpMethod = attributes["http.request.method"];
  if (httpMethod) {
    return `HTTP ${httpMethod}`;
  }
  const mcpMethod = attributes["mcp.method.name"];
  const tool = attributes["gen_ai.tool.name"];
  if (mcpMethod) {
    return tool ? `${mcpMethod} ${tool}` : mcpMethod;
  }
  const operation = attributes["gen_ai.operation.name"];
  if (operation) {
    return tool ? `${operation} ${tool}` : operation;
  }
  return "operation";
}

function sanitizedSpanEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }
  return events.map((event) => ({
    name: event?.name === "exception" ? "exception" : "event",
    time: event?.time,
    droppedAttributesCount: event?.droppedAttributesCount,
    attributes: sanitizedSpanAttributes(event?.attributes),
  }));
}

function sanitizedSpanLinks(links) {
  if (!Array.isArray(links)) {
    return [];
  }
  return links.map((link) => ({
    context: sanitizedSpanContext(link?.context),
    droppedAttributesCount: link?.droppedAttributesCount,
    attributes: sanitizedSpanAttributes(link?.attributes),
  }));
}

export function sanitizeOtelSpanForExport(span) {
  if (!span || typeof span !== "object") {
    return span;
  }
  const attributes = sanitizedSpanAttributes(span.attributes);
  const events = sanitizedSpanEvents(span.events);
  const links = sanitizedSpanLinks(span.links);
  const status =
    span.status && typeof span.status === "object"
      ? { code: span.status.code }
      : span.status;
  const name = sanitizedSpanName(attributes);
  const parentSpanContext = sanitizedSpanContext(span.parentSpanContext);

  return new Proxy(span, {
    get(target, property) {
      if (property === "attributes") {
        return attributes;
      }
      if (property === "events") {
        return events;
      }
      if (property === "links") {
        return links;
      }
      if (property === "name") {
        return name;
      }
      if (property === "parentSpanContext") {
        return parentSpanContext;
      }
      if (property === "spanContext") {
        return () => sanitizedSpanContext(target.spanContext());
      }
      if (property === "status") {
        return status;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function privacySafeTraceExporter(delegate) {
  return {
    export(spans, resultCallback) {
      return delegate.export(
        spans.map(sanitizeOtelSpanForExport),
        resultCallback,
      );
    },
    shutdown() {
      return delegate.shutdown();
    },
    forceFlush() {
      return typeof delegate.forceFlush === "function"
        ? delegate.forceFlush()
        : Promise.resolve();
    },
  };
}

function standardInstrumentations() {
  return [
    new HttpInstrumentation(),
    new UndiciInstrumentation(),
    new HostMetricsInstrumentation({
      metricGroups: ["process.cpu", "process.memory"],
    }),
    new RuntimeNodeInstrumentation({
      captureUncaughtException: false,
    }),
  ];
}

function createToolObserver(histogram) {
  return (event) => {
    const measurement = toExecuteToolDuration(event);
    if (!measurement) {
      return;
    }
    histogram.record(measurement.value, measurement.attributes);
  };
}

function mcpParentAndLinks(traceContext) {
  const ambientSpanContext = trace.getSpan(context.active())?.spanContext();
  const links =
    ambientSpanContext && isSpanContextValid(ambientSpanContext)
      ? [{ context: ambientSpanContext }]
      : undefined;
  const parentContext = propagation.extract(
    ROOT_CONTEXT,
    traceContext || Object.freeze({}),
  );
  return { links, parentContext };
}

function createMcpTelemetry(tracer, histogram) {
  const pending = new Map();
  const completedBeforePending = new Map();

  const rememberEarlyCompletion = (operationToken, completion) => {
    completedBeforePending.set(operationToken, completion);
    while (completedBeforePending.size > MAX_EARLY_MCP_COMPLETIONS) {
      completedBeforePending.delete(completedBeforePending.keys().next().value);
    }
  };

  const finishOperation = (operation, completion = {}) => {
    if (operation.finished) {
      return;
    }
    operation.finished = true;
    const isToolCall =
      operation.attributes["gen_ai.operation.name"] ===
      MCP_SEMCONV.executeToolOperation;
    const response = classifyMcpServerCompletion({
      ...completion,
      toolError: isToolCall && completion.toolError === true,
    });
    const responseStatusCode = response.responseStatusCode;
    const errorType =
      responseStatusCode === undefined
        ? response.errorType || operation.errorType
        : response.errorType;
    const metricAttributes = { ...operation.attributes };
    const protocolVersion =
      completion.protocolVersion ||
      operation.attributes[MCP_SEMCONV.protocolVersion];

    if (protocolVersion) {
      operation.span.setAttribute(MCP_SEMCONV.protocolVersion, protocolVersion);
      metricAttributes[MCP_SEMCONV.protocolVersion] = protocolVersion;
    }
    if (responseStatusCode !== undefined) {
      operation.span.setAttribute(
        "rpc.response.status_code",
        responseStatusCode,
      );
      metricAttributes["rpc.response.status_code"] = responseStatusCode;
    }
    if (errorType) {
      operation.span.setAttribute("error.type", errorType);
      metricAttributes["error.type"] = errorType;
      operation.span.setStatus({ code: SpanStatusCode.ERROR });
    }

    operation.span.end();
    histogram.record(
      Math.max(0, performance.now() - operation.startedAt) / 1_000,
      metricAttributes,
    );
  };

  const scope = async (metadata, run) => {
    const method =
      metadata.method ||
      (metadata.tool ? MCP_SEMCONV.toolsCallMethod : "unknown");
    const isToolCall = method === MCP_SEMCONV.toolsCallMethod;
    const protocolVersion = boundedMcpProtocolVersion(metadata.protocolVersion);
    const attributes = {
      "mcp.method.name": method,
      ...(protocolVersion
        ? { [MCP_SEMCONV.protocolVersion]: protocolVersion }
        : undefined),
      ...mcpTransportAttributes(metadata.deploymentMode),
      ...(isToolCall && metadata.tool
        ? {
            "gen_ai.operation.name": MCP_SEMCONV.executeToolOperation,
            "gen_ai.tool.name": metadata.tool,
          }
        : undefined),
    };
    const spanName =
      isToolCall && metadata.tool ? `${method} ${metadata.tool}` : method;
    const transportStartedAt = metadata[OBSERVABILITY_OPERATION_STARTED_AT];
    const startedAt = Number.isFinite(transportStartedAt)
      ? transportStartedAt
      : performance.now();
    const transportStartTime = metadata[OBSERVABILITY_OPERATION_START_TIME];
    const { links, parentContext } = mcpParentAndLinks(metadata.traceContext);
    const operationToken = metadata[OBSERVABILITY_OPERATION_TOKEN];

    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.SERVER,
        attributes,
        ...(Number.isFinite(transportStartTime)
          ? { startTime: transportStartTime }
          : undefined),
        ...(links ? { links } : undefined),
      },
      parentContext,
      async (serverSpan) => {
        const operation = {
          span: serverSpan,
          startedAt,
          attributes,
          errorType: undefined,
          completion: undefined,
          handlerComplete: false,
          finished: false,
        };
        if (typeof operationToken === "symbol") {
          if (completedBeforePending.has(operationToken)) {
            operation.completion = completedBeforePending.get(operationToken);
            completedBeforePending.delete(operationToken);
          } else {
            pending.set(operationToken, operation);
          }
        }
        if (operation.completion?.cancelled) {
          finishOperation(operation, operation.completion);
        }

        try {
          const result = await run();
          if (isToolCall && result?.isError === true) {
            operation.errorType = "tool_error";
          }
          return result;
        } catch (error) {
          operation.errorType = boundedObservabilityErrorType(error);
          throw error;
        } finally {
          operation.handlerComplete = true;
          if (typeof operationToken !== "symbol") {
            finishOperation(operation);
          } else if (operation.completion && !operation.finished) {
            pending.delete(operationToken);
            finishOperation(operation, operation.completion);
          }
        }
      },
    );
  };

  const sent = (
    operationToken,
    failed,
    responseStatusCode,
    toolError,
    protocolVersion,
    cancelled,
  ) => {
    if (typeof operationToken !== "symbol") {
      return;
    }
    const boundedProtocolVersion = boundedMcpProtocolVersion(protocolVersion);
    const completion = Object.freeze({
      sendFailed: failed === true,
      cancelled: cancelled === true,
      ...(typeof responseStatusCode === "string"
        ? { responseStatusCode }
        : undefined),
      toolError: toolError === true,
      ...(boundedProtocolVersion
        ? { protocolVersion: boundedProtocolVersion }
        : undefined),
    });
    const operation = pending.get(operationToken);
    if (!operation) {
      rememberEarlyCompletion(operationToken, completion);
      return;
    }
    operation.completion = completion;
    if (completion.cancelled) {
      pending.delete(operationToken);
      finishOperation(operation, completion);
      return;
    }
    if (!operation.handlerComplete) {
      return;
    }
    pending.delete(operationToken);
    finishOperation(operation, completion);
  };

  const finishPending = () => {
    const operations = [...pending.values()];
    pending.clear();
    completedBeforePending.clear();
    for (const operation of operations) {
      finishOperation(operation, { sendFailed: true });
    }
  };

  return Object.freeze({ scope, sent, finishPending });
}

function createToolScope(tracer) {
  return async (metadata, run) => {
    const operationStartTime = metadata[OBSERVABILITY_OPERATION_START_TIME];
    const operationCompletion = metadata[OBSERVABILITY_OPERATION_COMPLETION];
    return tracer.startActiveSpan(
      `${MCP_SEMCONV.executeToolOperation} ${metadata.tool}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": MCP_SEMCONV.executeToolOperation,
          "gen_ai.tool.name": metadata.tool,
        },
        ...(Number.isFinite(operationStartTime)
          ? { startTime: operationStartTime }
          : undefined),
      },
      async (toolSpan) => {
        try {
          const result = await run();
          if (result?.isError === true) {
            toolSpan.setAttribute(
              "error.type",
              operationCompletion?.errorType || "Error",
            );
            toolSpan.setStatus({ code: SpanStatusCode.ERROR });
          }
          return result;
        } catch (error) {
          toolSpan.setAttribute(
            "error.type",
            boundedObservabilityErrorType(error),
          );
          toolSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          const endTime = operationCompletion?.endTime;
          toolSpan.end(Number.isFinite(endTime) ? endTime : undefined);
        }
      },
    );
  };
}

async function shutdownWithin(sdk, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => sdk.shutdown())
        .catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupFailedBootstrap(
  { sdk, metricReader, metricExporter, traceExporterDelegate },
  timeoutMs,
) {
  if (sdk) {
    await shutdownWithin(sdk, timeoutMs);
    return;
  }
  if (metricReader) {
    await shutdownWithin(metricReader, timeoutMs);
  } else if (metricExporter) {
    await shutdownWithin(metricExporter, timeoutMs);
  }
  if (traceExporterDelegate) {
    await shutdownWithin(traceExporterDelegate, timeoutMs);
  }
}

/**
 * Start the optional OpenTelemetry runtime.
 *
 * Telemetry is deliberately opt-in and fail-open. Both trace and metric OTLP
 * endpoints must resolve before the SDK starts, preventing the SDK from falling
 * back to implicit localhost exporters when operators have not configured OBS-02.
 */
export async function startOpenTelemetry({
  env = process.env,
  sdkFactory,
  traceExporterFactory,
  metricExporterFactory,
} = {}) {
  if (env.MCP_OTEL_ENABLED !== "true") {
    return DISABLED_RUNTIME;
  }

  let sdk;
  let traceExporterDelegate;
  let metricExporter;
  let metricReader;
  let shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  try {
    const tracesEndpoint = resolveSignalEndpoint(env, "TRACES");
    const metricsEndpoint = resolveSignalEndpoint(env, "METRICS");
    if (!tracesEndpoint || !metricsEndpoint) {
      return DISABLED_RUNTIME;
    }

    shutdownTimeoutMs = boundedInteger(
      env.MCP_OTEL_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      { max: MAX_TIMEOUT_MS },
    );
    const exportTimeoutMillis = boundedInteger(
      env.MCP_OTEL_EXPORT_TIMEOUT_MS,
      DEFAULT_EXPORT_TIMEOUT_MS,
      { max: MAX_TIMEOUT_MS },
    );
    const exportIntervalMillis = boundedInteger(
      env.MCP_OTEL_METRIC_EXPORT_INTERVAL_MS,
      DEFAULT_METRIC_EXPORT_INTERVAL_MS,
      { min: 1_000, max: 15 * 60_000 },
    );
    const metricReaderTimeoutMillis = Math.min(
      exportTimeoutMillis,
      exportIntervalMillis,
    );

    traceExporterDelegate = traceExporterFactory
      ? traceExporterFactory({
          url: tracesEndpoint,
          timeoutMillis: exportTimeoutMillis,
        })
      : new OTLPTraceExporter({
          url: tracesEndpoint,
          timeoutMillis: exportTimeoutMillis,
        });
    const traceExporter = privacySafeTraceExporter(traceExporterDelegate);
    metricExporter = metricExporterFactory
      ? metricExporterFactory({
          url: metricsEndpoint,
          timeoutMillis: exportTimeoutMillis,
        })
      : new OTLPMetricExporter({
          url: metricsEndpoint,
          timeoutMillis: exportTimeoutMillis,
        });
    metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis,
      exportTimeoutMillis: metricReaderTimeoutMillis,
    });
    const resource = defaultResource().merge(
      resourceFromAttributes({
        "service.name": "gitlab-mcp",
      }),
    );
    const sdkOptions = {
      autoDetectResources: false,
      resource,
      traceExporter,
      metricReaders: [metricReader],
      views: metricContractViews(),
      // NodeSDK otherwise auto-configures an OTLP logs exporter from OTEL_*.
      // OBS-02 intentionally owns only the privacy-reviewed trace/metric signals.
      logRecordProcessors: [],
      textMapPropagator: createTraceparentOnlyPropagator(),
      instrumentations: standardInstrumentations(),
    };
    sdk = sdkFactory ? sdkFactory(sdkOptions) : new NodeSDK(sdkOptions);
    await Promise.resolve(sdk.start());

    const tracer = trace.getTracer(INSTRUMENTATION_NAME);
    const meter = metrics.getMeter(INSTRUMENTATION_NAME);
    const operationDuration = meter.createHistogram(
      MCP_SEMCONV.serverOperationDuration,
      {
        unit: MCP_SEMCONV.serverOperationDurationUnit,
        description: "Duration of MCP server operations.",
        advice: {
          explicitBucketBoundaries: MCP_SERVER_OPERATION_DURATION_BOUNDARIES,
        },
      },
    );
    const executeToolDuration = meter.createHistogram(
      MCP_SEMCONV.executeToolDuration,
      {
        unit: MCP_SEMCONV.executeToolDurationUnit,
        description: "Duration of GenAI tool executions.",
        advice: {
          explicitBucketBoundaries: EXECUTE_TOOL_DURATION_BOUNDARIES,
        },
      },
    );
    const mcpTelemetry = createMcpTelemetry(tracer, operationDuration);
    let shutdownPromise;

    return Object.freeze({
      enabled: true,
      observabilityObserver: createToolObserver(executeToolDuration),
      observabilityMcpScope: mcpTelemetry.scope,
      observabilityMcpSent: mcpTelemetry.sent,
      observabilityToolScope: createToolScope(tracer),
      shutdown: () => {
        mcpTelemetry.finishPending();
        shutdownPromise ??= shutdownWithin(sdk, shutdownTimeoutMs);
        return shutdownPromise;
      },
    });
  } catch {
    await cleanupFailedBootstrap(
      { sdk, metricReader, metricExporter, traceExporterDelegate },
      shutdownTimeoutMs,
    );
    return DISABLED_RUNTIME;
  }
}
