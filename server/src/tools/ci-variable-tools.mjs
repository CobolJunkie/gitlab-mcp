/**
 * CI/CD variable tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 *
 * SECURITY: Variable values are never exposed through MCP — only
 * metadata fields (key, type, protection flags, scope, description)
 * are returned.  The generic project/group registrar is shared so
 * both scopes are implemented in one place.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../gitlab-client.mjs";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import { project, groupIdentifier, page, perPage } from "./schemas.mjs";
import { p, g } from "./paths.mjs";
import { cleanBody } from "./responses.mjs";

// ── Response / safety helpers ──────────────────────────────────────────────

// CI/CD variable endpoints return the submitted value on both successful reads
// and mutations. Keep the allowlist deliberately narrow so a new upstream
// response field cannot accidentally disclose a secret through MCP.
function ciVariableMetadata(value, { key } = {}) {
  return cleanBody({
    key: value?.key || key,
    variable_type: value?.variable_type,
    protected: value?.protected,
    masked: value?.masked,
    hidden: value?.hidden,
    raw: value?.raw,
    environment_scope: value?.environment_scope,
    description: value?.description,
  });
}

function ciVariableListMetadata(value) {
  let variables;
  if (Array.isArray(value)) {
    variables = value;
  } else if (Array.isArray(value?.variables)) {
    variables = value.variables;
  } else {
    variables = [];
  }
  return variables.map((variable) => ciVariableMetadata(variable));
}

function ciVariableScopeQuery(environmentScope) {
  return cleanBody({
    "filter[environment_scope]": environmentScope,
  });
}

async function requireExactCiVariableScope(
  client,
  variablePath,
  key,
  environmentScope,
) {
  if (environmentScope === undefined) {
    return;
  }
  const response = await client.request(variablePath, {
    query: ciVariableScopeQuery(environmentScope),
  });
  if (response.data?.environment_scope !== environmentScope) {
    throw new Error(
      `CI/CD variable ${key} does not have the requested environment scope.`,
    );
  }
}

// ── Schemas / settings ────────────────────────────────────────────────────

const ciVariableKey = z.string().min(1).max(255).regex(/^\w+$/);
const ciVariableSettings = {
  description: z.string().max(255).optional(),
  environment_scope: z.string().min(1).max(255).optional(),
  masked: z.boolean().optional(),
  protected: z.boolean().optional(),
  raw: z
    .boolean()
    .optional()
    .describe(
      "Whether the value is literal. Set false to enable variable expansion.",
    ),
  variable_type: z.enum(["env_var", "file"]).optional(),
};
const ciVariableFilter = {
  filter_environment_scope: z.string().min(1).max(255).optional(),
};
const createCiVariableInput = {
  key: ciVariableKey,
  value: z.string(),
  ...ciVariableSettings,
  masked_and_hidden: z
    .boolean()
    .optional()
    .describe("Create a masked variable whose value is also hidden in GitLab."),
};
const updateCiVariableInput = {
  key: ciVariableKey,
  value: z.string(),
  ...ciVariableSettings,
  ...ciVariableFilter,
};
const deleteCiVariableInput = {
  key: ciVariableKey,
  ...ciVariableFilter,
};

// ── Generic registration helper ────────────────────────────────────────────

/**
 * Register CI/CD variable tools for both project and group scopes.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerCiVariableTools(tool) {
  const scopes = [
    { scope: "project", identifier: "project", path: p },
    { scope: "group", identifier: "group", path: g },
  ];

  for (const { scope, identifier, path } of scopes) {
    const titleScope = scope === "project" ? "project" : "group";
    const listName = `list_${scope}_ci_variables`;
    const getName = `get_${scope}_ci_variable`;
    const createName = `create_${scope}_ci_variable`;
    const updateName = `update_${scope}_ci_variable`;
    const deleteName = `delete_${scope}_ci_variable`;

    tool(
      listName,
      {
        title: `List ${titleScope} CI/CD variables`,
        description: `List ${titleScope} CI/CD variable metadata without exposing variable values.`,
        inputSchema: {
          [identifier]: scope === "project" ? project : groupIdentifier,
          page,
          per_page: perPage,
        },
        annotations: READ_ONLY,
      },
      async (client, args) => {
        const { [identifier]: identifierValue, ...query } = args;
        const response = await client.request(
          `${path(identifierValue)}/variables`,
          {
            query,
          },
        );
        return { ...response, data: ciVariableListMetadata(response.data) };
      },
    );

    tool(
      getName,
      {
        title: `Get ${titleScope} CI/CD variable metadata`,
        description: `Get ${titleScope} CI/CD variable metadata without exposing its value.`,
        inputSchema: {
          [identifier]: scope === "project" ? project : groupIdentifier,
          ...deleteCiVariableInput,
        },
        annotations: READ_ONLY,
      },
      async (client, args) => {
        const {
          [identifier]: identifierValue,
          key,
          filter_environment_scope,
        } = args;
        const response = await client.request(
          `${path(identifierValue)}/variables/${encodePathSegment(key)}`,
          {
            query: ciVariableScopeQuery(filter_environment_scope),
          },
        );
        return ciVariableMetadata(response.data, { key });
      },
    );

    tool(
      createName,
      {
        title: `Create ${titleScope} CI/CD variable`,
        description: `Create a ${titleScope} CI/CD variable without returning its value.`,
        inputSchema: {
          [identifier]: scope === "project" ? project : groupIdentifier,
          ...createCiVariableInput,
        },
        annotations: WRITE,
      },
      async (client, args) => {
        const { [identifier]: identifierValue, ...body } = args;
        const response = await client.request(
          `${path(identifierValue)}/variables`,
          {
            method: "POST",
            body,
          },
        );
        return ciVariableMetadata(response.data, args);
      },
    );

    tool(
      updateName,
      {
        title: `Update ${titleScope} CI/CD variable`,
        description: `Update a ${titleScope} CI/CD variable without returning its value.`,
        inputSchema: {
          [identifier]: scope === "project" ? project : groupIdentifier,
          ...updateCiVariableInput,
        },
        annotations: WRITE,
      },
      async (client, args) => {
        const {
          [identifier]: identifierValue,
          key,
          filter_environment_scope,
          ...body
        } = args;
        const variablePath = `${path(identifierValue)}/variables/${encodePathSegment(key)}`;
        await requireExactCiVariableScope(
          client,
          variablePath,
          key,
          filter_environment_scope,
        );
        const response = await client.request(variablePath, {
          method: "PUT",
          query: ciVariableScopeQuery(filter_environment_scope),
          body,
        });
        return ciVariableMetadata(response.data, { key });
      },
    );

    tool(
      deleteName,
      {
        title: `Delete ${titleScope} CI/CD variable`,
        description: `Delete a ${titleScope} CI/CD variable without returning its former value.`,
        inputSchema: {
          [identifier]: scope === "project" ? project : groupIdentifier,
          ...deleteCiVariableInput,
        },
        annotations: DESTRUCTIVE,
      },
      async (client, args) => {
        const {
          [identifier]: identifierValue,
          key,
          filter_environment_scope,
        } = args;
        const variablePath = `${path(identifierValue)}/variables/${encodePathSegment(key)}`;
        await requireExactCiVariableScope(
          client,
          variablePath,
          key,
          filter_environment_scope,
        );
        const response = await client.request(variablePath, {
          method: "DELETE",
          query: ciVariableScopeQuery(filter_environment_scope),
        });
        return ciVariableMetadata(response.data, { key });
      },
    );
  }
}
