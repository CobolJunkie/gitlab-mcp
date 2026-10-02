import { OBSERVABILITY_EVENTS } from "./observability.mjs";

/**
 * OpenTelemetry GenAI MCP semantic-convention snapshot used by OBS-02.
 *
 * MCP conventions are still Development status, so keep their translation in
 * this module rather than scattering attribute names through runtime code.
 */
export const MCP_SEMCONV = Object.freeze({
  repository: "open-telemetry/semantic-conventions-genai",
  snapshotDate: "2026-09-09",
  status: "development",
  serverOperationDuration: "mcp.server.operation.duration",
  serverOperationDurationUnit: "s",
  protocolVersion: "mcp.protocol.version",
  executeToolDuration: "gen_ai.execute_tool.duration",
  executeToolDurationUnit: "s",
  toolsCallMethod: "tools/call",
  executeToolOperation: "execute_tool",
});

export const MCP_SERVER_OPERATION_DURATION_BOUNDARIES = Object.freeze([
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
]);

export const EXECUTE_TOOL_DURATION_BOUNDARIES = Object.freeze([
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
]);

const MCP_SERVER_CALLER_ERROR_CODES = new Set([
  "-32700",
  "-32600",
  "-32601",
  "-32602",
  "-32002",
]);
const MCP_SERVER_KNOWN_ERROR_CODES = new Set([
  ...MCP_SERVER_CALLER_ERROR_CODES,
  "-32603",
]);
const MCP_SERVER_OTHER_ERROR = "other_error";

function boundedMcpResponseStatusCode(responseStatusCode) {
  return MCP_SERVER_KNOWN_ERROR_CODES.has(responseStatusCode)
    ? responseStatusCode
    : MCP_SERVER_OTHER_ERROR;
}

export function mcpTransportAttributes(deploymentMode) {
  if (deploymentMode === "stdio") {
    return { "network.transport": "pipe" };
  }
  if (deploymentMode === "http") {
    return {
      "network.transport": "tcp",
      "network.protocol.name": "http",
    };
  }
  return {};
}

export function classifyMcpServerCompletion({
  responseStatusCode,
  toolError = false,
  sendFailed = false,
  cancelled = false,
} = {}) {
  if (cancelled) {
    return Object.freeze({ errorType: "cancelled", isError: true });
  }

  if (sendFailed) {
    return Object.freeze({ errorType: "Error", isError: true });
  }

  if (typeof responseStatusCode === "string") {
    const boundedStatusCode = boundedMcpResponseStatusCode(responseStatusCode);
    const isError = !MCP_SERVER_CALLER_ERROR_CODES.has(boundedStatusCode);
    return Object.freeze({
      responseStatusCode: boundedStatusCode,
      ...(isError ? { errorType: boundedStatusCode } : undefined),
      isError,
    });
  }

  if (toolError) {
    return Object.freeze({ errorType: "tool_error", isError: true });
  }

  return Object.freeze({ isError: false });
}

/**
 * Translate one bounded OBS-01 tool completion event into the standard
 * execute-tool duration measurement. MCP server-operation telemetry is measured
 * separately at the centralized inbound MCP request/notification boundary.
 */
export function toExecuteToolDuration(event) {
  if (event?.event !== OBSERVABILITY_EVENTS.TOOL_CALL) {
    return undefined;
  }

  const attributes = {
    "gen_ai.tool.name": event.tool,
  };
  if (event.outcome === "error") {
    attributes["error.type"] = event.errorType || "Error";
  }

  return Object.freeze({
    name: MCP_SEMCONV.executeToolDuration,
    unit: MCP_SEMCONV.executeToolDurationUnit,
    value: Math.max(0, Number(event.durationMs) || 0) / 1_000,
    attributes: Object.freeze(attributes),
  });
}
