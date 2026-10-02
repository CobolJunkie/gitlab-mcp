import { performance } from "node:perf_hooks";

import { boundedMcpProtocolVersion } from "./mcp-protocol.mjs";
import {
  enforceMetricCardinalityBudget,
  recordMetricMeasurement,
  sanitizeMetricMeasurement,
} from "./metric-contract.mjs";

export const OBSERVABILITY_SCHEMA_VERSION = 2;
export const OBSERVABILITY_OPERATION_TOKEN = Symbol("mcp_operation_token");
export const OBSERVABILITY_OPERATION_STARTED_AT = Symbol(
  "mcp_operation_started_at",
);
export const OBSERVABILITY_OPERATION_START_TIME = Symbol(
  "mcp_operation_start_time",
);
export const OBSERVABILITY_OPERATION_COMPLETION = Symbol(
  "operation_completion",
);

export const OBSERVABILITY_EVENTS = Object.freeze({
  HTTP_REQUEST: "http_request",
  METRIC: "metric",
  TOOL_CALL: "mcp_tool_call",
});

const SAFE_HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);
const SAFE_DEPLOYMENT_MODES = new Set(["embedded", "http", "stdio"]);
const SAFE_ERROR_CATEGORIES = new Set([
  "authentication",
  "gitlab_api",
  "internal",
  "timeout",
  "validation",
]);
const SAFE_ERROR_TYPES = new Set([
  "AbortError",
  "AggregateError",
  "Error",
  "GitLabApiError",
  "GitLabAuthenticationError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_MCP_METHOD = /^[A-Za-z0-9._:/-]{1,128}$/u;
const LEGACY_ROUTE_PATHS = Object.freeze({
  health: "/health",
  mcp: "/mcp",
  oauth_metadata: "/.well-known/oauth-protected-resource",
  readiness: "/ready",
  unmatched: "<unmatched>",
});

function notifyObserver(observer, event) {
  if (typeof observer !== "function") {
    return;
  }
  try {
    Promise.resolve(observer(event)).catch(() => undefined);
  } catch {
    // Observability must never affect product behavior.
  }
}

function normalizedIdentifier(value) {
  const candidate = String(value ?? "");
  return SAFE_IDENTIFIER.test(candidate) ? candidate : "unknown";
}

function normalizedMcpMethod(value) {
  const candidate = String(value ?? "");
  return SAFE_MCP_METHOD.test(candidate) ? candidate : "unknown";
}

function normalizedHttpMethod(value) {
  const candidate = String(value ?? "").toUpperCase();
  return SAFE_HTTP_METHODS.has(candidate) ? candidate : "OTHER";
}

function normalizedHttpStatus(value) {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : 0;
}

function normalizedHttpOutcome(status) {
  if (status >= 100 && status < 400) {
    return "success";
  }
  if (status >= 400 && status <= 599) {
    return "error";
  }
  return "unknown";
}

function normalizedHttpRoutePath(value) {
  if (typeof value !== "string") {
    return "";
  }
  const candidate = value.toLowerCase();
  return candidate.length > 1 && candidate.endsWith("/")
    ? candidate.slice(0, -1)
    : candidate;
}

function normalizedDeploymentMode(value) {
  return SAFE_DEPLOYMENT_MODES.has(value) ? value : "unknown";
}

function boundedObservabilityErrorCategoryHint(error) {
  try {
    const candidate = error?.observabilityCategory;
    return SAFE_ERROR_CATEGORIES.has(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function boundedObservabilityErrorType(error) {
  try {
    const candidate = error?.name;
    return SAFE_ERROR_TYPES.has(candidate) ? candidate : "Error";
  } catch {
    return "Error";
  }
}

export function observabilityErrorCategory(error) {
  const hintedCategory = boundedObservabilityErrorCategoryHint(error);
  if (hintedCategory) {
    return hintedCategory;
  }
  const type = boundedObservabilityErrorType(error);
  if (type === "GitLabAuthenticationError") {
    return "authentication";
  }
  if (type === "GitLabApiError") {
    return "gitlab_api";
  }
  if (type === "TimeoutError" || type === "AbortError") {
    return "timeout";
  }
  // Generic JavaScript exceptions are not proof of caller validation failure.
  // Known validation boundaries must opt in with a bounded category hint.
  return "internal";
}

export function observeMetric({
  observer,
  metric,
  value = 1,
  attributes,
} = {}) {
  if (typeof observer !== "function") {
    return undefined;
  }
  let measurement;
  try {
    const sanitized = sanitizeMetricMeasurement({ metric, value, attributes });
    if (!sanitized) {
      return undefined;
    }
    const boundedAttributes = enforceMetricCardinalityBudget(sanitized);
    if (!boundedAttributes) {
      return undefined;
    }
    measurement = Object.freeze({
      ...sanitized,
      attributes: boundedAttributes,
    });
  } catch {
    // Malformed telemetry input must never affect product behavior.
    return undefined;
  }
  try {
    recordMetricMeasurement(measurement);
  } catch {
    // Metric SDK failures must remain fail-open.
  }
  const event = Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    event: OBSERVABILITY_EVENTS.METRIC,
    ...measurement,
  });
  notifyObserver(observer, event);
  return event;
}

function boundedTraceContext(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const traceparent =
    typeof value.traceparent === "string" && value.traceparent.length <= 128
      ? value.traceparent
      : undefined;
  return traceparent ? Object.freeze({ traceparent }) : undefined;
}

function addInternalMetadata(metadata, property, value, predicate) {
  if (!predicate(value)) {
    return;
  }
  Object.defineProperty(metadata, property, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

function boundedToolScopeMetadata({
  method,
  tool,
  readOnly,
  deploymentMode,
  protocolVersion,
  traceContext,
  operationToken,
  operationStartedAt,
  operationStartTime,
  operationCompletion,
}) {
  const boundedContext = boundedTraceContext(traceContext);
  const boundedProtocolVersion = boundedMcpProtocolVersion(protocolVersion);
  const metadata = {
    ...(method === undefined
      ? undefined
      : { method: normalizedMcpMethod(method) }),
    ...(tool === undefined ? undefined : { tool: normalizedIdentifier(tool) }),
    readOnly: readOnly === true,
    deploymentMode: normalizedDeploymentMode(deploymentMode),
    ...(boundedProtocolVersion
      ? { protocolVersion: boundedProtocolVersion }
      : undefined),
    ...(boundedContext ? { traceContext: boundedContext } : undefined),
  };
  addInternalMetadata(
    metadata,
    OBSERVABILITY_OPERATION_TOKEN,
    operationToken,
    (value) => typeof value === "symbol",
  );
  addInternalMetadata(
    metadata,
    OBSERVABILITY_OPERATION_STARTED_AT,
    operationStartedAt,
    Number.isFinite,
  );
  addInternalMetadata(
    metadata,
    OBSERVABILITY_OPERATION_START_TIME,
    operationStartTime,
    Number.isFinite,
  );
  addInternalMetadata(
    metadata,
    OBSERVABILITY_OPERATION_COMPLETION,
    operationCompletion,
    (value) => value !== null && typeof value === "object",
  );
  return Object.freeze(metadata);
}

export function observationStartedAt() {
  return performance.now();
}

export function observationDurationMs(
  startedAt,
  endedAt = observationStartedAt(),
) {
  const start = Number(startedAt);
  const end = Number(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  const elapsed = Math.max(0, end - start);
  return Math.round(elapsed * 100) / 100;
}

/**
 * Run one operation inside an optional observability context.
 *
 * The scope receives only bounded metadata and an idempotent `run` callback.
 * Scope failures are ignored, while the product operation is guaranteed to
 * execute at most once. This lets tracing integrations establish active context
 * without allowing telemetry failures to alter product behavior.
 */
export async function runToolObservationScope({
  scope,
  method,
  tool,
  readOnly,
  deploymentMode,
  protocolVersion,
  traceContext,
  operationToken,
  operationStartedAt,
  operationStartTime,
  operationCompletion,
  operation,
}) {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function.");
  }
  if (typeof scope !== "function") {
    return operation();
  }

  const metadata = boundedToolScopeMetadata({
    method,
    tool,
    readOnly,
    deploymentMode,
    protocolVersion,
    traceContext,
    operationToken,
    operationStartedAt,
    operationStartTime,
    operationCompletion,
  });
  let operationPromise;
  const run = () => {
    operationPromise ??= Promise.resolve().then(operation);
    return operationPromise;
  };

  try {
    await scope(metadata, run);
  } catch {
    // A scope/exporter/instrumentation failure must not affect the operation.
  }
  return run();
}

export function classifyHttpRoute(routePath) {
  const candidates = new Set(
    (Array.isArray(routePath) ? routePath : [routePath]).map(
      normalizedHttpRoutePath,
    ),
  );
  if (
    candidates.has("/.well-known/oauth-protected-resource") ||
    candidates.has("/.well-known/oauth-protected-resource/mcp")
  ) {
    return "oauth_metadata";
  }
  if (candidates.has("/health")) {
    return "health";
  }
  if (candidates.has("/ready")) {
    return "readiness";
  }
  if (candidates.has("/mcp")) {
    return "mcp";
  }
  return "unmatched";
}

export function observeHttpRequest({
  observer,
  requestObserver,
  requestId,
  method,
  routePath,
  status,
  startedAt,
  endedAt,
}) {
  const route = classifyHttpRoute(routePath);
  const normalizedStatus = normalizedHttpStatus(status);
  const durationMs = observationDurationMs(startedAt, endedAt);
  const event = Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    event: OBSERVABILITY_EVENTS.HTTP_REQUEST,
    requestId: normalizedIdentifier(requestId),
    method: normalizedHttpMethod(method),
    route,
    status: normalizedStatus,
    outcome: normalizedHttpOutcome(normalizedStatus),
    durationMs,
  });
  notifyObserver(observer, event);
  notifyObserver(requestObserver, {
    requestId: event.requestId,
    method: event.method,
    path: LEGACY_ROUTE_PATHS[route],
    status: event.status,
    durationMs: event.durationMs,
  });
  if (route === "mcp" && normalizedStatus === 403) {
    observeMetric({
      observer,
      metric: "gitlab_mcp.http.admission.rejections",
      attributes: { reason: "host_header" },
    });
  }
  return event;
}

export function observeToolCall({
  observer,
  tool,
  readOnly,
  deploymentMode,
  outcome,
  error,
  startedAt,
  endedAt,
}) {
  const normalizedOutcome = outcome === "error" ? "error" : "success";
  const event = Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    event: OBSERVABILITY_EVENTS.TOOL_CALL,
    tool: normalizedIdentifier(tool),
    readOnly: readOnly === true,
    deploymentMode: normalizedDeploymentMode(deploymentMode),
    outcome: normalizedOutcome,
    durationMs: observationDurationMs(startedAt, endedAt),
    ...(normalizedOutcome === "error"
      ? { errorType: boundedObservabilityErrorType(error) }
      : undefined),
  });
  notifyObserver(observer, event);
  return event;
}
