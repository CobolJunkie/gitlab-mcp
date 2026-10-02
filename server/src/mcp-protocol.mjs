import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(SUPPORTED_PROTOCOL_VERSIONS);

export function boundedMcpProtocolVersion(value) {
  return typeof value === "string" && SUPPORTED_MCP_PROTOCOL_VERSIONS.has(value)
    ? value
    : undefined;
}
