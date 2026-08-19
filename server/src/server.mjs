import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { resolveDistributionMetadata } from "../../shared/distribution-metadata.mjs";
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

export function createGitLabMcpServer(options = {}) {
  const readOnly = options.readOnly === true;
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

  registerGitLabTools(server, {
    ...options,
    readOnly,
    deploymentMode: options.deploymentMode || "embedded",
    distributionMetadata,
  });
  advertiseToolSecuritySchemes(server, options.securitySchemes);
  return server;
}
