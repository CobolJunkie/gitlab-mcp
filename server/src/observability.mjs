import { performance } from "node:perf_hooks";

export const OBSERVABILITY_SCHEMA_VERSION = 1;

export const OBSERVABILITY_EVENTS = Object.freeze({
  HTTP_REQUEST: "http_request",
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

function normalizedErrorType(error) {
  try {
    const candidate = error?.name;
    return SAFE_ERROR_TYPES.has(candidate) ? candidate : "Error";
  } catch {
    return "Error";
  }
}

export function observationStartedAt() {
  return performance.now();
}

export function observationDurationMs(
  startedAt,
  endedAt = observationStartedAt(),
) {
  const elapsed = endedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return 0;
  }
  return Math.round(elapsed * 100) / 100;
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
  const event = Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    event: OBSERVABILITY_EVENTS.HTTP_REQUEST,
    requestId: normalizedIdentifier(requestId),
    method: normalizedHttpMethod(method),
    route,
    status: normalizedStatus,
    outcome: normalizedHttpOutcome(normalizedStatus),
    durationMs: observationDurationMs(startedAt, endedAt),
  });
  notifyObserver(observer, event);
  notifyObserver(requestObserver, {
    requestId: event.requestId,
    method: event.method,
    path: LEGACY_ROUTE_PATHS[route],
    status: event.status,
    durationMs: event.durationMs,
  });
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
      ? { errorType: normalizedErrorType(error) }
      : undefined),
  });
  notifyObserver(observer, event);
  return event;
}
