import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createGitLabMcpServer } from "../../server/src/server.mjs";
import {
  GITLAB_TOOLSETS,
  resolveToolsetSelection,
} from "../../server/src/tools/toolsets.mjs";
import { estimateTokens, serializedBytes } from "./surface-audit.mjs";

function stableStringCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function safety(tool) {
  const annotations = tool.annotations;
  if (
    typeof annotations?.readOnlyHint !== "boolean" ||
    typeof annotations.destructiveHint !== "boolean"
  ) {
    throw new TypeError(
      `Tool ${tool.name} has incomplete MCP-visible safety annotations.`,
    );
  }
  return {
    access: annotations.readOnlyHint ? "read" : "write",
    destructive: annotations.destructiveHint,
  };
}

async function listConfiguredTools({ toolsets, readOnly }) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    toolsets,
    readOnly,
    clientFactory: () => {
      throw new Error("Toolset surface auditing must not call GitLab.");
    },
  });
  const client = new Client({
    name: "toolset-surface-audit",
    version: "1.0.0",
  });

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function summarizeTools(tools, { selection, readOnly }) {
  const entries = [...tools]
    .sort((left, right) => stableStringCompare(left.name, right.name))
    .map((definition) => {
      const classification = safety(definition);
      const schemaBytes = serializedBytes(definition);
      return {
        name: definition.name,
        ...classification,
        schemaBytes,
        estimatedSchemaTokens: estimateTokens(schemaBytes),
        definition,
      };
    });
  const definitions = entries.map((entry) => entry.definition);
  const serializedSchemaBytes = serializedBytes(definitions);

  return {
    selection: {
      mode: selection.mode,
      toolsets: [...selection.toolsets],
    },
    readOnly,
    toolCount: entries.length,
    readToolCount: entries.filter((entry) => entry.access === "read").length,
    writeToolCount: entries.filter((entry) => entry.access === "write").length,
    destructiveToolCount: entries.filter((entry) => entry.destructive).length,
    serializedSchemaBytes,
    sumToolSchemaBytes: entries.reduce(
      (total, entry) => total + entry.schemaBytes,
      0,
    ),
    estimatedSchemaTokens: estimateTokens(serializedSchemaBytes),
    tools: entries.map(
      ({ name, access, destructive, schemaBytes, estimatedSchemaTokens }) => ({
        name,
        access,
        destructive,
        schemaBytes,
        estimatedSchemaTokens,
      }),
    ),
  };
}

export async function auditToolsetSurface(toolsets, { readOnly = false } = {}) {
  const selection = resolveToolsetSelection(toolsets);
  const tools = await listConfiguredTools({ toolsets, readOnly });
  return summarizeTools(tools, { selection, readOnly });
}

export async function auditCanonicalToolsetSurfaces({ readOnly = false } = {}) {
  const entries = await Promise.all(
    GITLAB_TOOLSETS.map(async (toolset) => [
      toolset,
      await auditToolsetSurface(toolset, { readOnly }),
    ]),
  );
  return Object.fromEntries(entries);
}
