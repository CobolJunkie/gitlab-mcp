/**
 * Runtime and capability tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import { createHash } from "node:crypto";

import * as z from "zod/v4";

import { getGitLabCapabilities } from "../capabilities.mjs";
import { SERVER_VERSION } from "../version.mjs";

import { READ_ONLY } from "./annotations.mjs";
import { project } from "./schemas.mjs";

function runtimeBuildId(value) {
  const normalized = String(value || "").trim();
  return /^[a-f0-9]{7,64}$/i.test(normalized)
    ? normalized.toLowerCase()
    : "not_configured";
}

function runtimeDistributionMetadata(distributionMetadata) {
  const name =
    typeof distributionMetadata?.name === "string"
      ? distributionMetadata.name.trim()
      : "";
  const version =
    typeof distributionMetadata?.version === "string"
      ? distributionMetadata.version.trim()
      : "";

  return name && version
    ? { name, version }
    : { name: "gitlab", version: SERVER_VERSION };
}

function runtimeInfo({
  toolNames,
  readOnly,
  deploymentMode,
  buildId,
  distributionMetadata,
}) {
  const names = [...toolNames].sort((a, b) => a.localeCompare(b));
  const fingerprint = createHash("sha256")
    .update(names.join("\n"))
    .digest("hex");
  return {
    server: {
      name: "gitlab",
      version: SERVER_VERSION,
    },
    plugin: runtimeDistributionMetadata(distributionMetadata),
    build: {
      id: runtimeBuildId(buildId),
    },
    deployment: {
      mode: deploymentMode,
      readOnly,
    },
    toolInventory: {
      count: names.length,
      fingerprint: `sha256:${fingerprint}`,
    },
  };
}

/**
 * Register runtime and capability tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 * @param {object} options
 * @param {string[]} options.registeredToolNames - Live list of all registered tool names.
 * @param {boolean} options.readOnly - Whether the server is in read-only mode.
 * @param {string} options.deploymentMode - Current deployment mode.
 * @param {string} [options.buildId] - Optional build identifier.
 * @param {{name: string, version: string}} [options.distributionMetadata] - Optional harness distribution identity.
 */
export function registerRuntimeTools(
  tool,
  {
    registeredToolNames,
    readOnly,
    deploymentMode,
    buildId,
    distributionMetadata,
  },
) {
  tool(
    "get_runtime_info",
    {
      title: "Get MCP runtime information",
      description:
        "Report this installed MCP runtime's versions, deployment mode, and deterministic registered-tool inventory fingerprint without exposing credentials or general environment values.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      runtimeInfo({
        toolNames: registeredToolNames,
        readOnly,
        deploymentMode,
        buildId,
        distributionMetadata,
      }),
  );

  tool(
    "get_gitlab_capabilities",
    {
      title: "Get GitLab capabilities",
      description:
        "Discover the connected GitLab instance, identity, token metadata, API support, permissions, licensing, and configuration evidence using read-only probes.",
      inputSchema: {
        project: project.optional(),
        detailed: z
          .boolean()
          .optional()
          .describe("Include normalized probe outcomes and ambiguity notes."),
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the short-lived capability cache and probe again."),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => getGitLabCapabilities(client, args),
  );
}
