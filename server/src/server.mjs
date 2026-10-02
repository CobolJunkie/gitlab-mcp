import { performance } from "node:perf_hooks";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { resolveDistributionMetadata } from "../../shared/distribution-metadata.mjs";
import { boundedMcpProtocolVersion } from "./mcp-protocol.mjs";
import { observeMetric, runToolObservationScope } from "./observability.mjs";
import { registerGitLabTools } from "./tools.mjs";
import { SERVER_VERSION } from "./version.mjs";

export const SERVER_NAME = "gitlab";
export { SERVER_VERSION };

export function decorateToolSecurity(tool, securitySchemes) {
  return {
    ...tool,
    securitySchemes,
    _meta: {
      ...tool._meta,
      securitySchemes,
    },
  };
}

function advertiseToolSecuritySchemes(server, securitySchemes) {
  if (!securitySchemes) {
    return;
  }

  // MCP SDK 1.29 preserves extension metadata but predates the top-level
  // securitySchemes field documented by OpenAI. Mirror it in both locations
  // until the stable SDK exposes the field directly.
  const originalHandler = server.server._requestHandlers.get("tools/list");
  if (!originalHandler) {
    throw new Error("MCP tools/list handler was not initialized.");
  }
  server.server.setRequestHandler(
    ListToolsRequestSchema,
    async (request, extra) => {
      const result = await originalHandler(request, extra);
      return {
        ...result,
        tools: result.tools.map((tool) =>
          decorateToolSecurity(tool, securitySchemes),
        ),
      };
    },
  );
}

function installToolSurfaceMetrics(
  server,
  { observabilityObserver, deploymentMode, readOnly },
) {
  if (typeof observabilityObserver !== "function") {
    return;
  }

  try {
    const originalHandler = server.server._requestHandlers.get("tools/list");
    if (!originalHandler) {
      return;
    }
    const boundedDeploymentMode = ["embedded", "http", "stdio"].includes(
      deploymentMode,
    )
      ? deploymentMode
      : "unknown";
    const attributes = {
      deployment_mode: boundedDeploymentMode,
      read_only: String(readOnly),
    };
    server.server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra) => {
        const result = await originalHandler(request, extra);
        try {
          const tools = Array.isArray(result?.tools) ? result.tools : [];
          observeMetric({
            observer: observabilityObserver,
            metric: "gitlab_mcp.tool.surface.count",
            value: tools.length,
            attributes,
          });
          observeMetric({
            observer: observabilityObserver,
            metric: "gitlab_mcp.tool.surface.definition.size",
            value: Buffer.byteLength(JSON.stringify(tools), "utf8"),
            attributes,
          });
        } catch {
          // Surface telemetry is fail-open and must not alter tools/list.
        }
        return result;
      },
    );
  } catch {
    // Telemetry installation must never prevent server construction.
  }
}

function isInboundMessage(message) {
  return (
    message && typeof message === "object" && typeof message.method === "string"
  );
}

function isInboundRequest(message) {
  return isInboundMessage(message) && message.id !== undefined;
}

function isOutboundResponse(message) {
  return (
    message &&
    typeof message === "object" &&
    message.method === undefined &&
    message.id !== undefined
  );
}

function requestInfoProtocolVersion(extra) {
  try {
    const headers = extra?.requestInfo?.headers;
    const rawValue =
      typeof headers?.get === "function"
        ? headers.get("mcp-protocol-version")
        : headers?.["mcp-protocol-version"];
    let value = rawValue;
    if (Array.isArray(rawValue)) {
      value = rawValue.length === 1 ? rawValue[0] : undefined;
    }
    return boundedMcpProtocolVersion(value);
  } catch {
    return undefined;
  }
}

function requestProtocolVersion(message, extra, negotiatedProtocolVersion) {
  if (message?.method === "initialize") {
    return boundedMcpProtocolVersion(message?.params?.protocolVersion);
  }
  return (
    requestInfoProtocolVersion(extra) ||
    boundedMcpProtocolVersion(negotiatedProtocolVersion)
  );
}

function outboundCompletion(message, failed) {
  if (failed) {
    return { failed: true };
  }
  try {
    const responseStatusCode = Number.isSafeInteger(message?.error?.code)
      ? String(message.error.code)
      : undefined;
    return {
      failed: false,
      ...(responseStatusCode === undefined
        ? undefined
        : { responseStatusCode }),
      toolError: message?.result?.isError === true,
    };
  } catch {
    return { failed: false };
  }
}

function createMcpTransportBridge(onOperationSent) {
  const canCorrelateSend = typeof onOperationSent === "function";
  const requestRecord = new WeakMap();
  const tokenById = new Map();
  const methodById = new Map();
  const claimedTokens = new Set();
  const ambiguousIds = new Map();
  const sendingIds = new Set();
  let negotiatedProtocolVersion;

  const notifySent = (token, completion) => {
    if (
      !canCorrelateSend ||
      typeof token !== "symbol" ||
      !claimedTokens.delete(token)
    ) {
      return;
    }
    try {
      Promise.resolve(
        onOperationSent(
          token,
          completion.failed,
          completion.responseStatusCode,
          completion.toolError,
          completion.protocolVersion,
          completion.cancelled === true,
        ),
      ).catch(() => undefined);
    } catch {
      // Transport telemetry must never alter MCP behavior.
    }
  };

  const completeCancelledRequest = (message) => {
    if (message?.method !== "notifications/cancelled") {
      return;
    }
    const requestId = message?.params?.requestId;
    // MCP SDK 1.29 ignores falsy cancellation IDs; mirror product behavior so
    // telemetry cannot report a cancellation the server itself did not apply.
    if (
      !requestId ||
      ambiguousIds.has(requestId) ||
      sendingIds.has(requestId)
    ) {
      return;
    }
    const token = tokenById.get(requestId);
    if (!token) {
      return;
    }
    tokenById.delete(requestId);
    methodById.delete(requestId);
    notifySent(token, { failed: true, cancelled: true });
  };

  const registerInbound = (message, extra) => {
    if (!isInboundMessage(message)) {
      return;
    }
    const protocolVersion = requestProtocolVersion(
      message,
      extra,
      negotiatedProtocolVersion,
    );
    const timing = {
      startedAt: performance.now(),
      startTime: Date.now(),
      ...(protocolVersion ? { protocolVersion } : undefined),
    };
    if (!isInboundRequest(message) || !canCorrelateSend) {
      requestRecord.set(message, timing);
      completeCancelledRequest(message);
      return;
    }

    const id = message.id;
    if (ambiguousIds.has(id)) {
      ambiguousIds.set(id, ambiguousIds.get(id) + 1);
      requestRecord.set(message, { id, ...timing });
      return;
    }
    const previousToken = tokenById.get(id);
    if (previousToken) {
      tokenById.delete(id);
      methodById.delete(id);
      ambiguousIds.set(id, 2);
      notifySent(previousToken, { failed: true });
      requestRecord.set(message, { id, ...timing });
      return;
    }
    const token = Symbol("mcp_request");
    requestRecord.set(message, { id, token, ...timing });
    tokenById.set(id, token);
    methodById.set(id, message.method);
  };

  const consumeAmbiguousResponse = (id) => {
    const remaining = ambiguousIds.get(id);
    if (!remaining) {
      return false;
    }
    if (remaining === 1) {
      ambiguousIds.delete(id);
    } else {
      ambiguousIds.set(id, remaining - 1);
    }
    return true;
  };

  const completeOutbound = (message, failed) => {
    const messages = Array.isArray(message) ? message : [message];
    for (const candidate of messages) {
      if (!isOutboundResponse(candidate)) {
        continue;
      }
      if (consumeAmbiguousResponse(candidate.id)) {
        continue;
      }
      const token = tokenById.get(candidate.id);
      if (!token) {
        continue;
      }
      const requestMethod = methodById.get(candidate.id);
      tokenById.delete(candidate.id);
      methodById.delete(candidate.id);
      if (requestMethod === "initialize") {
        const responseProtocolVersion = boundedMcpProtocolVersion(
          candidate?.result?.protocolVersion,
        );
        if (responseProtocolVersion) {
          negotiatedProtocolVersion = responseProtocolVersion;
        }
      }
      notifySent(token, {
        ...outboundCompletion(candidate, failed),
        ...(negotiatedProtocolVersion
          ? { protocolVersion: negotiatedProtocolVersion }
          : undefined),
      });
    }
  };

  const outboundResponseIds = (message) => {
    const messages = Array.isArray(message) ? message : [message];
    return messages
      .filter((candidate) => isOutboundResponse(candidate))
      .map((candidate) => candidate.id);
  };

  const completeAll = () => {
    const pendingTokens = new Set(tokenById.values());
    tokenById.clear();
    methodById.clear();
    ambiguousIds.clear();
    sendingIds.clear();
    for (const token of pendingTokens) {
      notifySent(token, { failed: true });
    }
    claimedTokens.clear();
  };

  const contextFor = (request, { markScoped = false } = {}) => {
    const record = requestRecord.get(request);
    if (!record) {
      return undefined;
    }
    if (markScoped) {
      record.scoped = true;
    }
    const timing = {
      operationStartedAt: record.startedAt,
      operationStartTime: record.startTime,
      ...(record.protocolVersion
        ? { protocolVersion: record.protocolVersion }
        : undefined),
    };
    if (!record.token || tokenById.get(record.id) !== record.token) {
      return Object.freeze(timing);
    }
    claimedTokens.add(record.token);
    return Object.freeze({
      ...timing,
      operationToken: record.token,
    });
  };

  const wrap = (transport, observeInbound) =>
    new Proxy(transport, {
      get(target, property) {
        if (property === "send") {
          return async (message, options) => {
            const responseIds = outboundResponseIds(message);
            for (const id of responseIds) {
              sendingIds.add(id);
            }
            let failed = false;
            try {
              return await target.send(message, options);
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              completeOutbound(message, failed);
              for (const id of responseIds) {
                sendingIds.delete(id);
              }
            }
          };
        }
        if (property === "close") {
          return async () => {
            try {
              return await target.close();
            } finally {
              completeAll();
            }
          };
        }
        const value = Reflect.get(target, property, target);
        if (property === "setProtocolVersion" && typeof value === "function") {
          return (version) => {
            negotiatedProtocolVersion = boundedMcpProtocolVersion(version);
            return value.call(target, version);
          };
        }
        if (
          property === "onmessage" ||
          property === "onclose" ||
          property === "onerror"
        ) {
          return value;
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) {
        if (property === "onmessage" && typeof value === "function") {
          const handler = value;
          return Reflect.set(
            target,
            property,
            (message, extra) => {
              registerInbound(message, extra);
              const run = handler.bind(undefined, message, extra);
              return typeof observeInbound === "function"
                ? observeInbound(message, extra, run)
                : run();
            },
            target,
          );
        }
        if (property === "onclose" && typeof value === "function") {
          const handler = value;
          return Reflect.set(
            target,
            property,
            () => {
              completeAll();
              return handler();
            },
            target,
          );
        }
        return Reflect.set(target, property, value, target);
      },
    });

  return Object.freeze({
    contextFor,
    isScoped: (request) => requestRecord.get(request)?.scoped === true,
    wrap,
  });
}

function installMcpObservability(
  server,
  {
    observabilityMcpScope,
    observabilityMcpSent,
    deploymentMode,
    registeredToolNames,
  },
) {
  if (typeof observabilityMcpScope !== "function") {
    return;
  }

  const transportBridge = createMcpTransportBridge(observabilityMcpSent);
  const registeredTools = new Set(registeredToolNames);
  const registeredMethods = new Set([
    ...server.server._requestHandlers.keys(),
    ...server.server._notificationHandlers.keys(),
  ]);

  const boundedOperationMetadata = (request) => {
    const actualMethod = isInboundMessage(request) ? request.method : undefined;
    const method = registeredMethods.has(actualMethod)
      ? actualMethod
      : "unknown";
    const requestedTool =
      actualMethod === "tools/call" ? request?.params?.name : undefined;
    let tool;
    if (actualMethod === "tools/call") {
      tool = registeredTools.has(requestedTool)
        ? requestedTool
        : "unknown_tool";
    }
    return { method, tool };
  };

  const runObservedOperation = (
    request,
    extra,
    operation,
    operationContext,
  ) => {
    const { method, tool } = boundedOperationMetadata(request);
    const protocolVersion =
      operationContext?.protocolVersion ||
      requestProtocolVersion(request, extra, undefined);
    return runToolObservationScope({
      scope: observabilityMcpScope,
      method,
      ...(tool === undefined ? undefined : { tool }),
      readOnly: false,
      deploymentMode,
      ...(protocolVersion ? { protocolVersion } : undefined),
      traceContext: request?.params?._meta,
      ...operationContext,
      operation,
    });
  };

  const wrapHandler = (originalHandler) => async (request, extra) => {
    if (transportBridge.isScoped(request)) {
      return originalHandler(request, extra);
    }
    return runObservedOperation(
      request,
      extra,
      () => originalHandler(request, extra),
      transportBridge.contextFor(request),
    );
  };

  for (const [method, handler] of server.server._requestHandlers) {
    server.server._requestHandlers.set(method, wrapHandler(handler));
  }
  for (const [method, handler] of server.server._notificationHandlers) {
    server.server._notificationHandlers.set(method, wrapHandler(handler));
  }

  const originalConnect = server.connect.bind(server);
  server.connect = (transport) =>
    originalConnect(
      transportBridge.wrap(transport, (request, extra, operation) => {
        if (!isInboundRequest(request)) {
          return operation();
        }
        return runObservedOperation(
          request,
          extra,
          operation,
          transportBridge.contextFor(request, { markScoped: true }),
        );
      }),
    );
}

export function createGitLabMcpServer(options = {}) {
  const readOnly = options.readOnly === true;
  const deploymentMode = options.deploymentMode || "embedded";
  const distributionMetadata = resolveDistributionMetadata(options);
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: readOnly
        ? "This server is configured for read-only GitLab inspection. Resolve a project path before project-scoped calls. For review work, list discussions and report actionable threads without replying or resolving them. For CI failures, inspect pipeline jobs then fetch only relevant bounded job logs."
        : "Resolve a project path before project-scoped calls. Read current state before writes. Treat merge, delete, cancel, resolve, approve, comment, reaction, branch, commit, and pipeline actions as externally visible. For review work, list discussions before replying or resolving. For CI failures, inspect pipeline jobs then fetch only relevant job logs.",
    },
  );

  let registeredToolNames = [];
  registerGitLabTools(server, {
    ...options,
    readOnly,
    deploymentMode,
    distributionMetadata,
    registeredToolObserver: (toolNames) => {
      registeredToolNames = toolNames;
    },
  });
  advertiseToolSecuritySchemes(server, options.securitySchemes);
  installToolSurfaceMetrics(server, {
    observabilityObserver: options.observabilityObserver,
    deploymentMode,
    readOnly,
  });
  installMcpObservability(server, {
    observabilityMcpScope: options.observabilityMcpScope,
    observabilityMcpSent: options.observabilityMcpSent,
    deploymentMode,
    registeredToolNames,
  });
  return server;
}
