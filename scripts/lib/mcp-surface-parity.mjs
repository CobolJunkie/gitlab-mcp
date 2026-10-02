import { createHash } from "node:crypto";

import { canonicalJson, listCanonicalTools } from "./surface-audit.mjs";

export const DEFAULT_SURFACE_PARITY_MAX_RESPONSE_BYTES = 2_000_000;
export const DEFAULT_SURFACE_PARITY_MAX_REPORTED_NAMES = 25;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableStringCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireToolDefinition(tool) {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("MCP tools/list entries must be objects.");
  }
  if (typeof tool.name !== "string" || !tool.name.trim()) {
    throw new TypeError("MCP tools/list entries must have non-empty names.");
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
    throw new TypeError(`MCP tool ${tool.name} is missing inputSchema.`);
  }

  const annotations = tool.annotations;
  for (const annotation of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ]) {
    if (typeof annotations?.[annotation] !== "boolean") {
      throw new TypeError(
        `MCP tool ${tool.name} is missing boolean annotation ${annotation}.`,
      );
    }
  }

  return {
    name: tool.name,
    ...(typeof tool.title === "string" ? { title: tool.title } : {}),
    ...(typeof tool.description === "string"
      ? { description: tool.description }
      : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema && typeof tool.outputSchema === "object"
      ? { outputSchema: tool.outputSchema }
      : {}),
    annotations: {
      readOnlyHint: annotations.readOnlyHint,
      destructiveHint: annotations.destructiveHint,
      idempotentHint: annotations.idempotentHint,
      openWorldHint: annotations.openWorldHint,
    },
  };
}

export function summarizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) {
    throw new TypeError("MCP tools/list result must contain a tools array.");
  }

  const definitions = tools
    .map(requireToolDefinition)
    .sort((left, right) => stableStringCompare(left.name, right.name));
  const byName = new Map();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(
        `MCP tools/list returned duplicate tool ${definition.name}.`,
      );
    }
    byName.set(definition.name, {
      definition,
      fingerprint: sha256(canonicalJson(definition)),
    });
  }

  return {
    count: definitions.length,
    fingerprint: sha256(canonicalJson(definitions)),
    byName,
  };
}

function boundedNames(names, maxReportedNames) {
  return [...names]
    .sort(stableStringCompare)
    .slice(0, maxReportedNames)
    .map((name) => (name.length <= 128 ? name : `${name.slice(0, 125)}...`));
}

export function compareToolSurfaces(
  canonicalTools,
  remoteTools,
  { maxReportedNames = DEFAULT_SURFACE_PARITY_MAX_REPORTED_NAMES } = {},
) {
  if (
    !Number.isSafeInteger(maxReportedNames) ||
    maxReportedNames < 1 ||
    maxReportedNames > 100
  ) {
    throw new TypeError(
      "maxReportedNames must be an integer from 1 through 100.",
    );
  }

  const canonical = summarizeToolDefinitions(canonicalTools);
  const remote = summarizeToolDefinitions(remoteTools);
  const canonicalNames = new Set(canonical.byName.keys());
  const remoteNames = new Set(remote.byName.keys());

  const missing = [...canonicalNames].filter((name) => !remoteNames.has(name));
  const extra = [...remoteNames].filter((name) => !canonicalNames.has(name));
  const stale = [...canonicalNames].filter((name) => {
    const remoteEntry = remote.byName.get(name);
    return (
      remoteEntry &&
      remoteEntry.fingerprint !== canonical.byName.get(name).fingerprint
    );
  });

  return {
    status:
      missing.length === 0 && extra.length === 0 && stale.length === 0
        ? "match"
        : "drift",
    canonical: {
      count: canonical.count,
      fingerprint: canonical.fingerprint,
    },
    remote: {
      count: remote.count,
      fingerprint: remote.fingerprint,
    },
    missingTools: {
      count: missing.length,
      names: boundedNames(missing, maxReportedNames),
    },
    extraTools: {
      count: extra.length,
      names: boundedNames(extra, maxReportedNames),
    },
    staleTools: {
      count: stale.length,
      names: boundedNames(stale, maxReportedNames),
    },
  };
}

async function boundedJson(response, maxResponseBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new Error(
      `Remote MCP response exceeds the ${maxResponseBytes}-byte safety limit.`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxResponseBytes) {
    throw new Error(
      `Remote MCP response exceeds the ${maxResponseBytes}-byte safety limit.`,
    );
  }

  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Remote MCP returned invalid JSON.");
  }
}

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function parseMcpEndpoint(endpoint, allowInsecureHttp) {
  let resource;
  try {
    resource = new URL(endpoint);
  } catch {
    throw new TypeError("Remote MCP endpoint must be a valid URL.");
  }
  if (
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash
  ) {
    throw new TypeError(
      "Remote MCP endpoint must not contain credentials, a query, or a fragment.",
    );
  }
  if (resource.protocol !== "https:" && !allowInsecureHttp) {
    throw new TypeError(
      "Remote MCP endpoint must use HTTPS unless allowInsecureHttp is explicitly enabled.",
    );
  }
  if (!stripTrailingSlashes(resource.pathname).endsWith("/mcp")) {
    throw new TypeError("Remote MCP endpoint path must end in /mcp.");
  }
  return resource;
}

async function fetchToolPage({
  resource,
  headers,
  page,
  cursor,
  fetchImpl,
  maxResponseBytes,
}) {
  const response = await fetchImpl(resource, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: page,
      method: "tools/list",
      params: cursor === undefined ? {} : { cursor },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await boundedJson(response, maxResponseBytes);
  if (!response.ok) {
    throw new Error(
      `Remote MCP tools/list failed with HTTP ${response.status}.`,
    );
  }
  if (payload?.error) {
    throw new Error("Remote MCP tools/list returned a JSON-RPC error.");
  }
  if (!Array.isArray(payload?.result?.tools)) {
    throw new TypeError(
      "Remote MCP tools/list response is missing result.tools.",
    );
  }

  const nextCursor = payload.result.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length === 0)
  ) {
    throw new TypeError(
      "Remote MCP tools/list returned an invalid nextCursor.",
    );
  }

  return { tools: payload.result.tools, nextCursor };
}

export async function fetchRemoteToolSurface(
  endpoint,
  {
    token,
    allowInsecureHttp = false,
    fetchImpl = fetch,
    maxResponseBytes = DEFAULT_SURFACE_PARITY_MAX_RESPONSE_BYTES,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 65_536 ||
    maxResponseBytes > 8_388_608
  ) {
    throw new TypeError(
      "maxResponseBytes must be an integer from 65536 through 8388608.",
    );
  }

  const resource = parseMcpEndpoint(endpoint, allowInsecureHttp);
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (typeof token === "string" && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }

  const tools = [];
  let cursor;
  for (let page = 1; page <= 10; page += 1) {
    const result = await fetchToolPage({
      resource,
      headers,
      page,
      cursor,
      fetchImpl,
      maxResponseBytes,
    });
    tools.push(...result.tools);
    if (tools.length > 1_000) {
      throw new Error(
        "Remote MCP tools/list exceeded the 1000-tool safety limit.",
      );
    }
    if (result.nextCursor === undefined || result.nextCursor === null) {
      return tools;
    }
    cursor = result.nextCursor;
  }

  throw new Error("Remote MCP tools/list exceeded the 10-page safety limit.");
}

export async function checkRemoteSurfaceParity({
  endpoint,
  token,
  readOnly = false,
  allowInsecureHttp = false,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_SURFACE_PARITY_MAX_RESPONSE_BYTES,
  maxReportedNames = DEFAULT_SURFACE_PARITY_MAX_REPORTED_NAMES,
} = {}) {
  const canonicalTools = await listCanonicalTools({
    readOnly,
    excludedToolNames: new Set(),
  });
  const remoteTools = await fetchRemoteToolSurface(endpoint, {
    token,
    allowInsecureHttp,
    fetchImpl,
    maxResponseBytes,
  });
  return compareToolSurfaces(canonicalTools, remoteTools, {
    maxReportedNames,
  });
}
