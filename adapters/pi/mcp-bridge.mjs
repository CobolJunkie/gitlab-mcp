const DEFAULT_MAX_TOOL_PAGES = 64;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requireTool(tool) {
  requireObject(tool, "MCP tool");
  if (typeof tool.name !== "string" || !tool.name.trim()) {
    throw new TypeError("MCP tool name must be a non-empty string.");
  }
  requireObject(tool.inputSchema, `MCP tool ${tool.name} inputSchema`);
  return tool;
}

function errorMessage(toolName, result) {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const structured =
    result.structuredContent === undefined
      ? ""
      : (JSON.stringify(result.structuredContent) ?? "");
  const detail = text || structured || "MCP tool returned an error result.";
  return `MCP tool ${toolName} failed: ${detail}`;
}

function fallbackContent(block) {
  return {
    type: "text",
    text: `[MCP ${block?.type ?? "unknown"} content]\n${JSON.stringify(block)}`,
  };
}

function appendUniqueTools(toolInputs, names, tools) {
  if (!Array.isArray(toolInputs)) {
    throw new TypeError("MCP tools/list result must contain a tools array.");
  }

  for (const toolInput of toolInputs) {
    const tool = requireTool(toolInput);
    if (names.has(tool.name)) {
      throw new Error(`MCP tools/list returned duplicate tool ${tool.name}.`);
    }
    names.add(tool.name);
    tools.push(tool);
  }
}

export function translateMcpContent(content, structuredContent) {
  if (content !== undefined && !Array.isArray(content)) {
    throw new TypeError(
      "MCP tool result content must be an array when present.",
    );
  }

  const translated = (content ?? []).map((block) => {
    if (block?.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    return fallbackContent(block);
  });

  if (translated.length === 0 && structuredContent !== undefined) {
    translated.push({
      type: "text",
      text: JSON.stringify(structuredContent),
    });
  }
  return translated;
}

export function createPiToolDefinition(toolInput, client) {
  const tool = requireTool(toolInput);
  if (!client || typeof client.callTool !== "function") {
    throw new TypeError("MCP client must provide callTool().");
  }

  return {
    name: tool.name,
    label:
      typeof tool.title === "string" && tool.title.trim()
        ? tool.title
        : tool.name,
    description:
      typeof tool.description === "string" ? tool.description : "MCP tool",
    parameters: structuredClone(tool.inputSchema),
    executionMode:
      tool.annotations?.readOnlyHint === true ? "parallel" : "sequential",
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Pi MCP tool call was aborted before dispatch.");
      }

      const result = await client.callTool(
        {
          name: tool.name,
          arguments: params,
        },
        undefined,
        signal ? { signal } : undefined,
      );
      requireObject(result, `MCP tool ${tool.name} result`);
      if (result.isError) {
        throw new Error(errorMessage(tool.name, result));
      }

      return {
        content: translateMcpContent(result.content, result.structuredContent),
        details: {
          mcp: {
            annotations: tool.annotations ?? null,
            structuredContent: result.structuredContent ?? null,
            meta: result._meta ?? null,
          },
        },
      };
    },
  };
}

export async function listAllMcpTools(
  client,
  { maxPages = DEFAULT_MAX_TOOL_PAGES } = {},
) {
  if (!client || typeof client.listTools !== "function") {
    throw new TypeError("MCP client must provide listTools().");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new TypeError("MCP tool page limit must be a positive integer.");
  }

  const tools = [];
  const names = new Set();
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.listTools(
      cursor === undefined ? undefined : { cursor },
    );
    requireObject(result, "MCP tools/list result");
    appendUniqueTools(result.tools, names, tools);

    if (result.nextCursor === undefined) {
      return tools;
    }
    if (typeof result.nextCursor !== "string") {
      throw new TypeError("MCP tools/list nextCursor must be a string.");
    }
    cursor = result.nextCursor;
  }

  throw new Error(`MCP tools/list exceeded the ${maxPages}-page safety limit.`);
}

export async function registerMcpTools(pi, client, options) {
  if (!pi || typeof pi.registerTool !== "function") {
    throw new TypeError("Pi extension API must provide registerTool().");
  }

  const tools = await listAllMcpTools(client, options);
  for (const tool of tools) {
    pi.registerTool(createPiToolDefinition(tool, client));
  }
  return tools;
}
