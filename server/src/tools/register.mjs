/**
 * Common tool-registration helper and default client factory.
 *
 * The factory creates a `tool(name, config, handler)` closure that every
 * GitLab tool family calls to register its tools.  This keeps the
 * registration ceremony identical across all tool families while
 * preserving access to the live `registeredToolNames` collection for
 * runtime inventory.
 */

import {
  GitLabClient,
  normalizeGitLabUrl,
  tokenFromContext,
} from "../gitlab-client.mjs";
import { registerMetricIdentifier } from "../metric-contract.mjs";
import {
  observationDurationMs,
  observationStartedAt,
  observabilityErrorCategory,
  observeMetric,
  observeToolCall,
  runToolObservationScope,
} from "../observability.mjs";

import { success, failure } from "./responses.mjs";

export function defaultClientFactory(extra, { observabilityObserver } = {}) {
  return new GitLabClient({
    baseUrl: normalizeGitLabUrl(),
    token: tokenFromContext(extra),
    observabilityObserver,
  });
}

/**
 * Create a `tool` registrar bound to the given server and options.
 *
 * @param {object} options
 * @param {object} options.server           - The MCP server instance.
 * @param {Function} [options.clientFactory] - Factory that builds a GitLabClient from extra context.
 * @param {object} [options.securitySchemes] - OAuth security schemes to attach to each tool.
 * @param {string} [options.authChallenge]   - WWW-Authenticate challenge for auth errors.
 * @param {boolean} [options.readOnly]       - When true, non-read-only tools are skipped.
 * @param {object} [options.outputSchema]    - Default structured-output schema.
 * @param {Function} [options.observabilityObserver] - Privacy-safe core event observer.
 * @param {Function} [options.observabilityToolScope] - Optional fail-open tool execution context.
 * @param {string} [options.deploymentMode] - Current MCP deployment mode.
 * @returns {{ tool: Function, registeredToolNames: string[] }}
 */
export function createToolRegistrar({
  server,
  clientFactory = defaultClientFactory,
  securitySchemes,
  authChallenge,
  readOnly = false,
  outputSchema,
  observabilityObserver,
  observabilityToolScope,
  deploymentMode = "embedded",
} = {}) {
  const registeredToolNames = [];

  const tool = (name, config, handler) => {
    if (typeof config.annotations?.readOnlyHint !== "boolean") {
      throw new TypeError(
        `GitLab MCP tool ${name} must declare a readOnlyHint annotation.`,
      );
    }
    if (readOnly && !config.annotations.readOnlyHint) {
      return;
    }
    const { resultPolicy, ...publicConfig } = config;
    registeredToolNames.push(name);
    registerMetricIdentifier("tool", name);
    const registeredConfig = {
      ...publicConfig,
      ...(securitySchemes
        ? {
            _meta: {
              ...publicConfig._meta,
              securitySchemes,
            },
          }
        : undefined),
      outputSchema: publicConfig.outputSchema || outputSchema,
    };
    server.registerTool(name, registeredConfig, async (args, extra) => {
      const startedAt = observationStartedAt();
      const startTime = Date.now();
      const operationCompletion = {};
      const access = config.annotations.readOnlyHint ? "read" : "write";
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.tool.active",
        value: 1,
        attributes: { tool: name, access },
      });
      let completed = false;
      const completeObservation = (outcome, error) => {
        if (completed) {
          return;
        }
        completed = true;
        const endedAt = observationStartedAt();
        const durationMs = observationDurationMs(startedAt, endedAt);
        const event = observeToolCall({
          observer: observabilityObserver,
          tool: name,
          readOnly: config.annotations.readOnlyHint,
          deploymentMode,
          outcome,
          ...(error === undefined ? undefined : { error }),
          startedAt,
          endedAt,
        });
        observeMetric({
          observer: observabilityObserver,
          metric: "gitlab_mcp.tool.active",
          value: -1,
          attributes: { tool: name, access },
        });
        observeMetric({
          observer: observabilityObserver,
          metric: "gitlab_mcp.tool.calls",
          attributes: {
            tool: name,
            access,
            outcome,
            error_category:
              outcome === "error" ? observabilityErrorCategory(error) : "none",
          },
        });
        observeMetric({
          observer: observabilityObserver,
          metric: "gitlab_mcp.tool.handler.duration",
          value: durationMs / 1_000,
          attributes: { tool: name, access, outcome },
        });
        operationCompletion.endTime = startTime + durationMs;
        operationCompletion.errorType = event.errorType;
      };

      return runToolObservationScope({
        scope: observabilityToolScope,
        tool: name,
        readOnly: config.annotations.readOnlyHint,
        deploymentMode,
        operationStartedAt: startedAt,
        operationStartTime: startTime,
        operationCompletion,
        operation: async () => {
          try {
            const client = clientFactory(extra, { observabilityObserver });
            const value = await handler(client, args, extra);
            const response = success(value, {
              observer: observabilityObserver,
              tool: name,
              resultPolicy,
            });
            completeObservation("success");
            return response;
          } catch (error) {
            const response = failure(error, authChallenge, {
              observer: observabilityObserver,
              tool: name,
            });
            completeObservation("error", error);
            return response;
          }
        },
      });
    });
  };

  return { tool, registeredToolNames };
}
