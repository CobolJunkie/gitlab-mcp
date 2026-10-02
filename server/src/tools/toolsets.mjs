export const GITLAB_TOOLSETS = Object.freeze([
  "context",
  "platform",
  "repository",
  "issues",
  "merge_requests",
  "ci",
  "governance",
  "releases",
  "deployments",
  "variables",
  "webhooks",
]);

const TOOLSET_NAMES = new Set(GITLAB_TOOLSETS);
const CONTEXT_PLATFORM_TOOLS = new Set([
  "get_current_user",
  "search_projects",
  "get_project",
]);

function configuredNames(value) {
  if (value === undefined || value === null) {
    return ["default"];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string") {
        throw new TypeError("GitLab MCP toolset entries must be strings.");
      }
      return entry.trim();
    });
  }
  if (typeof value !== "string") {
    throw new TypeError(
      "GitLab MCP toolsets must be configured as a comma-separated string or string array.",
    );
  }
  if (value.trim() === "") {
    return ["default"];
  }
  return value.split(",").map((entry) => entry.trim());
}

export function resolveToolsetSelection(value) {
  const names = configuredNames(value);
  if (names.length === 0) {
    throw new Error("GitLab MCP toolset selection must not be empty.");
  }
  if (names.includes("")) {
    throw new Error("GitLab MCP toolset selection contains an empty name.");
  }

  const uniqueNames = [...new Set(names)];
  const aliases = uniqueNames.filter(
    (name) => name === "all" || name === "default",
  );
  if (aliases.length > 0) {
    if (uniqueNames.length !== 1) {
      throw new Error(
        "GitLab MCP toolset aliases 'all' and 'default' cannot be combined with explicit toolsets.",
      );
    }
    return Object.freeze({
      mode: "all",
      toolsets: GITLAB_TOOLSETS,
    });
  }

  const unknown = uniqueNames.filter((name) => !TOOLSET_NAMES.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown GitLab MCP toolset${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Valid toolsets: ${GITLAB_TOOLSETS.join(", ")}.`,
    );
  }

  const selected = GITLAB_TOOLSETS.filter((name) => uniqueNames.includes(name));
  return Object.freeze({
    mode: "explicit",
    toolsets: Object.freeze(selected),
  });
}

export function toolsetSelected(selection, primaryToolset) {
  if (!selection || !Array.isArray(selection.toolsets)) {
    throw new TypeError("A resolved GitLab MCP toolset selection is required.");
  }
  if (!TOOLSET_NAMES.has(primaryToolset)) {
    throw new Error(`Unknown primary GitLab MCP toolset: ${primaryToolset}.`);
  }
  return (
    selection.mode === "all" || selection.toolsets.includes(primaryToolset)
  );
}

export function platformPrimaryToolset(toolName) {
  return CONTEXT_PLATFORM_TOOLS.has(toolName) ? "context" : "platform";
}

export function createToolsetRegistrationRouter({
  tool,
  selection,
  assignments = new Map(),
}) {
  if (typeof tool !== "function") {
    throw new TypeError("A GitLab MCP tool registrar is required.");
  }
  const resolvedSelection = selection || resolveToolsetSelection();

  const registrar = (primaryToolset) => {
    if (!TOOLSET_NAMES.has(primaryToolset)) {
      throw new Error(`Unknown primary GitLab MCP toolset: ${primaryToolset}.`);
    }
    return (name, config, handler) => {
      if (assignments.has(name)) {
        throw new Error(
          `GitLab MCP tool ${name} has multiple primary toolsets.`,
        );
      }
      assignments.set(name, primaryToolset);
      if (!toolsetSelected(resolvedSelection, primaryToolset)) {
        return;
      }
      return tool(name, config, handler);
    };
  };

  const platformRegistrar = (name, config, handler) =>
    registrar(platformPrimaryToolset(name))(name, config, handler);

  return {
    assignments,
    platformRegistrar,
    registrar,
    selection: resolvedSelection,
  };
}

export function frozenToolsetAssignments(assignments) {
  if (!(assignments instanceof Map)) {
    throw new TypeError("GitLab MCP toolset assignments must be a Map.");
  }
  return Object.freeze(
    Object.fromEntries(
      [...assignments.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}
