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
import { observationStartedAt, observeToolCall } from "../observability.mjs";

import { success, failure } from "./responses.mjs";

export function defaultClientFactory(extra) {
  return new GitLabClient({
    baseUrl: normalizeGitLabUrl(),
    token: tokenFromContext(extra),
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
    registeredToolNames.push(name);
    server.registerTool(
      name,
      {
        ...config,
        ...(securitySchemes
          ? {
              _meta: {
                ...config._meta,
                securitySchemes,
              },
            }
          : undefined),
        outputSchema: config.outputSchema || outputSchema,
      },
      async (args, extra) => {
        const startedAt = observationStartedAt();
        try {
          const client = clientFactory(extra);
          const result = await handler(client, args, extra);
          const response = success(result);
          observeToolCall({
            observer: observabilityObserver,
            tool: name,
            readOnly: config.annotations.readOnlyHint,
            deploymentMode,
            outcome: "success",
            startedAt,
          });
          return response;
        } catch (error) {
          const response = failure(error, authChallenge);
          observeToolCall({
            observer: observabilityObserver,
            tool: name,
            readOnly: config.annotations.readOnlyHint,
            deploymentMode,
            outcome: "error",
            error,
            startedAt,
          });
          return response;
        }
      },
    );
  };

  return { tool, registeredToolNames };
}
