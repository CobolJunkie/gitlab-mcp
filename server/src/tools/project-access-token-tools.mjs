import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../gitlab-client.mjs";
import {
  DESTRUCTIVE,
  IDEMPOTENT_DESTRUCTIVE,
  READ_ONLY,
  WRITE,
} from "./annotations.mjs";
import { p } from "./paths.mjs";
import { cleanBody, ONE_TIME_TOKEN_RESULT } from "./responses.mjs";
import { page, perPage, project } from "./schemas.mjs";

const PROJECT_ACCESS_TOKEN_SCOPES = Object.freeze([
  "api",
  "read_api",
  "read_repository",
  "write_repository",
  "read_registry",
  "write_registry",
  "self_rotate",
  "create_runner",
  "manage_runner",
  "ai_features",
  "k8s_proxy",
]);

const projectAccessTokenScope = z.enum(PROJECT_ACCESS_TOKEN_SCOPES);
const accessLevel = z.union([
  z.literal(10),
  z.literal(15),
  z.literal(20),
  z.literal(25),
  z.literal(30),
  z.literal(40),
  z.literal(50),
]);
const tokenId = z.number().int().positive();
const tokenName = z.string().min(1).max(255);
const expirationDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Expiration date must be a real calendar date.")
  .describe("Expiration date in YYYY-MM-DD format.");
const scopes = z
  .array(projectAccessTokenScope)
  .min(1)
  .max(PROJECT_ACCESS_TOKEN_SCOPES.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "Project access token scopes must be unique.",
  });
const ciVariableKey = z.string().min(1).max(255).regex(/^\w+$/);
const environmentScope = z.string().min(1).max(255);
const PROJECT_ACCESS_TOKEN_AVAILABILITY = Object.freeze({
  gitlabCom: "Premium or Ultimate subscription required.",
  selfManaged: "Available with any license.",
  dedicated: "Available with any license.",
});

function isNotFound(error) {
  return error instanceof GitLabApiError && error.status === 404;
}

function hasHttpStatus(error) {
  return Number.isFinite(Number(error?.status ?? error?.result?.status));
}

function projectAccessTokenMetadata(value) {
  return cleanBody({
    id: value?.id,
    user_id: value?.user_id,
    name: value?.name,
    description: value?.description,
    scopes: Array.isArray(value?.scopes) ? value.scopes : undefined,
    created_at: value?.created_at,
    expires_at: value?.expires_at,
    active: value?.active,
    revoked: value?.revoked,
    access_level: value?.access_level,
    last_used_at: value?.last_used_at,
    last_used_ips: Array.isArray(value?.last_used_ips)
      ? value.last_used_ips
      : undefined,
  });
}

function projectAccessTokenListMetadata(value) {
  let tokens = [];
  if (Array.isArray(value)) {
    tokens = value;
  } else if (Array.isArray(value?.access_tokens)) {
    tokens = value.access_tokens;
  }
  return tokens.map(projectAccessTokenMetadata);
}

function capabilityFailure(error, fallback) {
  const status = Number(error?.status || error?.result?.status);
  if (status === 401) {
    return {
      state: "unavailable",
      reason: `${fallback} GitLab returned 401 Unauthorized.`,
      httpStatus: 401,
    };
  }
  if (status === 403) {
    return {
      state: "permission_required",
      reason:
        "The connected identity lacks permission for this project access-token operation.",
      httpStatus: 403,
    };
  }
  if (status === 404) {
    return {
      state: "unknown",
      reason:
        "GitLab did not expose the project access-token endpoint. On GitLab.com, project access tokens require Premium or Ultimate; GitLab Self-Managed and Dedicated support them with any license. A 404 does not distinguish a tier restriction from a hidden, inaccessible, disabled, or unsupported endpoint.",
      httpStatus: 404,
    };
  }
  return {
    state: "unknown",
    reason:
      "GitLab did not provide conclusive project access-token capability evidence.",
    ...(Number.isFinite(status) ? { httpStatus: status } : {}),
  };
}

async function creationCredentialEvidence(client) {
  try {
    const response = await client.request("/personal_access_tokens/self");
    const tokenScopes = Array.isArray(response.data?.scopes)
      ? response.data.scopes
      : [];
    if (!tokenScopes.includes("api")) {
      return {
        state: "permission_required",
        reason:
          "Creating or rotating another project access token requires an access token with api scope and GitLab requires that credential to be a personal access token.",
      };
    }
    return {
      state: "unknown",
      reason:
        "GitLab accepted the credential on the access-token self endpoint and it has api scope, but that endpoint does not prove the token subtype. The project access-token mutation endpoint remains authoritative about the personal-token requirement.",
      apiScope: true,
    };
  } catch (error) {
    return capabilityFailure(
      error,
      "Creating or rotating another project access token requires a personal access token with api scope; the connected credential was not accepted by GitLab's access-token self endpoint.",
    );
  }
}

function oneTimeTokenResult(response, operation) {
  const token = response?.data?.token;
  const metadata = projectAccessTokenMetadata(response?.data);
  if (typeof token !== "string" || token.length === 0) {
    const id = metadata.id === undefined ? "unknown" : metadata.id;
    throw new Error(
      `GitLab ${operation} project access token ID ${id} but did not return its one-time value. Revoke that token before retrying.`,
    );
  }
  return { ...metadata, token };
}

async function preflightProjectAccessToken(client, projectValue, id) {
  const path = `${p(projectValue)}/access_tokens/${id}`;
  try {
    const metadata = projectAccessTokenMetadata(
      (await client.request(path)).data,
    );
    if (metadata.id !== id) {
      throw new Error(
        "Project access-token preflight returned an unexpected token ID.",
      );
    }
    return { path, metadata };
  } catch (error) {
    if (isNotFound(error)) return { path, metadata: null };
    throw error;
  }
}

function requireTokenName(metadata, expectedName, context) {
  if (metadata?.name !== expectedName) {
    throw new Error(
      `${context} token name does not match the expected project access-token name.`,
    );
  }
}

async function revokeKnownProjectAccessToken(client, projectValue, metadata) {
  const path = `${p(projectValue)}/access_tokens/${metadata.id}`;
  if (metadata.revoked === true || metadata.active === false) {
    return {
      ...metadata,
      active: false,
      revoked: true,
      outcome: "already_inactive",
      changed: false,
    };
  }
  try {
    await client.request(path, { method: "DELETE" });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const current = await preflightProjectAccessToken(
      client,
      projectValue,
      metadata.id,
    );
    if (
      current.metadata === null ||
      current.metadata.revoked === true ||
      current.metadata.active === false
    ) {
      return {
        ...metadata,
        active: false,
        revoked: true,
        outcome: "already_inactive_after_preflight",
        changed: false,
      };
    }
    throw error;
  }
  return {
    ...metadata,
    active: false,
    revoked: true,
    outcome: "revoked",
    changed: true,
  };
}

function ciVariableScopeQuery(scope) {
  return { "filter[environment_scope]": scope };
}

function projectCiVariableMetadata(value) {
  return cleanBody({
    key: value?.key,
    variable_type: value?.variable_type,
    protected: value?.protected,
    masked: value?.masked,
    hidden: value?.hidden,
    raw: value?.raw,
    environment_scope: value?.environment_scope,
    description: value?.description,
  });
}

async function readProjectCiVariable(
  client,
  projectValue,
  key,
  environmentScope,
) {
  const path = `${p(projectValue)}/variables/${encodePathSegment(key)}`;
  const response = await client.request(path, {
    query: ciVariableScopeQuery(environmentScope),
  });
  const metadata = projectCiVariableMetadata(response.data);
  if (metadata.key !== key) {
    throw new Error("CI/CD variable preflight returned an unexpected key.");
  }
  if (metadata.environment_scope !== environmentScope) {
    throw new Error(
      `CI/CD variable ${key} does not have the requested environment scope.`,
    );
  }
  return { path, metadata };
}

function requireSecretCiVariable(metadata) {
  if (metadata.masked !== true || metadata.hidden !== true) {
    throw new Error(
      "Project access-token credential replacement requires an existing masked and hidden CI/CD variable.",
    );
  }
}

function requireUnchangedCiVariableMetadata(before, after) {
  for (const field of [
    "key",
    "variable_type",
    "protected",
    "masked",
    "hidden",
    "raw",
    "environment_scope",
    "description",
  ]) {
    if (!Object.is(before[field], after[field])) {
      throw new Error(
        `CI/CD variable metadata changed unexpectedly for field ${field}.`,
      );
    }
  }
}

async function revokeReplacementAfterFailure(client, projectValue, metadata) {
  if (!Number.isSafeInteger(metadata?.id) || metadata.id <= 0) return false;
  try {
    await client.request(`${p(projectValue)}/access_tokens/${metadata.id}`, {
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
}

/** Register project access-token lifecycle tools. */
export function registerProjectAccessTokenTools(tool) {
  tool(
    "get_project_access_token_capabilities",
    {
      title: "Get project access-token capabilities",
      description:
        "Probe project access-token metadata access and report bounded credential evidence for create/rotate operations without claiming a token subtype GitLab has not proven.",
      inputSchema: { project },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      let metadata;
      try {
        await client.request(`${p(args.project)}/access_tokens`, {
          query: { per_page: 1 },
        });
        metadata = {
          state: "available",
          reason:
            "GitLab returned project access-token metadata for this project.",
        };
      } catch (error) {
        metadata = capabilityFailure(
          error,
          "The connected credential cannot read project access-token metadata.",
        );
      }
      return {
        availability: PROJECT_ACCESS_TOKEN_AVAILABILITY,
        metadata,
        createOrRotateOthers: await creationCredentialEvidence(client),
      };
    },
  );

  tool(
    "list_project_access_tokens",
    {
      title: "List project access tokens",
      description:
        "List project access-token metadata without exposing token values.",
      inputSchema: {
        project,
        state: z.enum(["active", "inactive"]).optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      const response = await client.request(
        `${p(projectValue)}/access_tokens`,
        {
          query,
        },
      );
      return {
        ...response,
        data: projectAccessTokenListMetadata(response.data),
      };
    },
  );

  tool(
    "get_project_access_token",
    {
      title: "Get project access token",
      description:
        "Get metadata for one project access token without exposing its value.",
      inputSchema: { project, token_id: tokenId },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { metadata } = await preflightProjectAccessToken(
        client,
        args.project,
        args.token_id,
      );
      if (metadata === null) {
        throw new GitLabApiError("GitLab API returned 404 Not Found.", {
          status: 404,
          method: "GET",
          path: `${p(args.project)}/access_tokens/${args.token_id}`,
        });
      }
      return metadata;
    },
  );

  tool(
    "create_project_access_token",
    {
      title: "Create project access token",
      description:
        "Create a project access token. GitLab authoritatively requires a personal access token for this endpoint. The new token value is returned exactly once in structured output and omitted from normal text output and later reads.",
      inputSchema: {
        project,
        name: tokenName,
        description: z.string().max(255).optional(),
        scopes,
        access_level: accessLevel.optional(),
        expires_at: expirationDate,
      },
      annotations: WRITE,
      resultPolicy: ONE_TIME_TOKEN_RESULT,
    },
    async (client, args) => {
      const { project: projectValue, ...body } = args;
      let response;
      try {
        response = await client.request(`${p(projectValue)}/access_tokens`, {
          method: "POST",
          body,
        });
      } catch (error) {
        if (hasHttpStatus(error)) throw error;
        throw new Error(
          `Project access-token creation could not be confirmed for requested name ${body.name}. The token may have been created; inspect project access-token metadata for that name before retrying.`,
          { cause: error },
        );
      }
      return oneTimeTokenResult(response, "created");
    },
  );

  tool(
    "rotate_project_access_token",
    {
      title: "Rotate project access token",
      description:
        "Rotate a project access token, immediately revoking its previous value. Numeric token IDs require an exact expected name preflight; token_id=self follows GitLab self-rotation rules. GitLab authoritatively enforces the credential requirements. The new value is returned exactly once in structured output.",
      inputSchema: {
        project,
        token_id: z.union([tokenId, z.literal("self")]),
        expected_token_name: tokenName
          .optional()
          .describe(
            "Required when token_id is numeric; must exactly match GitLab metadata before rotation.",
          ),
        expires_at: expirationDate.optional(),
        acknowledge_token_rotation: z.literal(true),
      },
      annotations: DESTRUCTIVE,
      resultPolicy: ONE_TIME_TOKEN_RESULT,
    },
    async (client, args) => {
      if (args.token_id !== "self") {
        if (args.expected_token_name === undefined) {
          throw new Error(
            "Rotating a numeric project access-token ID requires expected_token_name.",
          );
        }
        const { metadata } = await preflightProjectAccessToken(
          client,
          args.project,
          args.token_id,
        );
        if (
          metadata === null ||
          metadata.revoked === true ||
          metadata.active === false
        ) {
          throw new Error(
            `Project access token ${args.token_id} is not active and cannot be rotated as another token.`,
          );
        }
        requireTokenName(metadata, args.expected_token_name, "Rotation target");
      }
      const body = cleanBody({ expires_at: args.expires_at });
      let response;
      try {
        response = await client.request(
          `${p(args.project)}/access_tokens/${args.token_id}/rotate`,
          { method: "POST", body },
        );
      } catch (error) {
        if (hasHttpStatus(error)) throw error;
        const target =
          args.token_id === "self"
            ? "the authenticating project access token"
            : `project access token ID ${args.token_id}`;
        throw new Error(
          `Project access-token rotation could not be confirmed for ${target}. The previous token value may already be invalid; inspect project access-token metadata with an independently authorized credential before retrying.`,
          { cause: error },
        );
      }
      return oneTimeTokenResult(response, "rotated");
    },
  );

  tool(
    "revoke_project_access_token",
    {
      title: "Revoke project access token",
      description:
        "Revoke one explicitly identified project access token after exact ID/name metadata preflight. Missing or already-inactive targets return bounded idempotent no-change results. Requires explicit destructive acknowledgement.",
      inputSchema: {
        project,
        token_id: tokenId,
        expected_token_name: tokenName,
        acknowledge_token_revocation: z.literal(true),
      },
      annotations: IDEMPOTENT_DESTRUCTIVE,
    },
    async (client, args) => {
      const { metadata } = await preflightProjectAccessToken(
        client,
        args.project,
        args.token_id,
      );
      if (metadata === null) {
        return {
          id: args.token_id,
          active: false,
          revoked: true,
          outcome: "already_absent",
          changed: false,
        };
      }
      requireTokenName(metadata, args.expected_token_name, "Revocation target");
      return revokeKnownProjectAccessToken(client, args.project, metadata);
    },
  );

  tool(
    "replace_project_access_token_ci_credential",
    {
      title: "Replace a project access token used by project CI",
      description:
        "Create a replacement project access token, write its one-time value directly into an exact masked+hidden project CI/CD variable without exposing it through MCP output, verify unchanged variable metadata, then revoke the exact old token. If the CI write cannot be confirmed or post-write verification fails, both tokens remain active so the consumer can be reconciled safely.",
      inputSchema: {
        project,
        old_token_id: tokenId,
        expected_old_token_name: tokenName,
        replacement_name: tokenName,
        replacement_description: z.string().max(255).optional(),
        replacement_scopes: scopes,
        replacement_access_level: accessLevel.optional(),
        replacement_expires_at: expirationDate,
        ci_project: project,
        ci_variable_key: ciVariableKey,
        ci_variable_environment_scope: environmentScope,
        acknowledge_credential_replacement: z.literal(true),
        acknowledge_old_token_revocation: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const { metadata: oldToken } = await preflightProjectAccessToken(
        client,
        args.project,
        args.old_token_id,
      );
      if (
        oldToken === null ||
        oldToken.revoked === true ||
        oldToken.active === false
      ) {
        throw new Error(
          `Old project access token ${args.old_token_id} must exist and be active before replacement.`,
        );
      }
      requireTokenName(
        oldToken,
        args.expected_old_token_name,
        "Credential replacement target",
      );

      const variableBefore = await readProjectCiVariable(
        client,
        args.ci_project,
        args.ci_variable_key,
        args.ci_variable_environment_scope,
      );
      requireSecretCiVariable(variableBefore.metadata);

      const creationBody = cleanBody({
        name: args.replacement_name,
        description: args.replacement_description,
        scopes: args.replacement_scopes,
        access_level: args.replacement_access_level,
        expires_at: args.replacement_expires_at,
      });
      let createdResponse;
      try {
        createdResponse = await client.request(
          `${p(args.project)}/access_tokens`,
          { method: "POST", body: creationBody },
        );
      } catch (error) {
        throw new Error(
          `Replacement project access-token creation could not be confirmed for requested name ${args.replacement_name}. The existing CI credential and old token ID ${oldToken.id} are unchanged; inspect project access-token metadata for that replacement name before retrying.`,
          { cause: error },
        );
      }
      const replacement = projectAccessTokenMetadata(createdResponse.data);
      const replacementValue = createdResponse.data?.token;
      if (
        typeof replacementValue !== "string" ||
        replacementValue.length === 0
      ) {
        const rolledBack = await revokeReplacementAfterFailure(
          client,
          args.project,
          replacement,
        );
        const replacementId = replacement.id ?? "unknown";
        throw new Error(
          `GitLab created replacement project access token ID ${replacementId} but did not return its one-time value; replacement cleanup ${rolledBack ? "succeeded" : "could not be confirmed"}.`,
        );
      }

      try {
        await client.request(variableBefore.path, {
          method: "PUT",
          query: ciVariableScopeQuery(args.ci_variable_environment_scope),
          body: { value: replacementValue },
        });
      } catch (error) {
        throw new Error(
          `CI credential replacement could not confirm whether the new value was accepted for replacement project access token ID ${replacement.id ?? "unknown"}. The replacement and old token ID ${oldToken.id} remain active; verify the CI variable before revoking either token.`,
          { cause: error },
        );
      }

      let variableAfter;
      try {
        variableAfter = await readProjectCiVariable(
          client,
          args.ci_project,
          args.ci_variable_key,
          args.ci_variable_environment_scope,
        );
        requireUnchangedCiVariableMetadata(
          variableBefore.metadata,
          variableAfter.metadata,
        );
      } catch (error) {
        throw new Error(
          `CI variable update was accepted for replacement project access token ID ${replacement.id ?? "unknown"}, but post-write verification failed. The replacement and old token ID ${oldToken.id} remain active; verify the CI variable before revoking either token.`,
          { cause: error },
        );
      }

      let revokedOld;
      try {
        revokedOld = await revokeKnownProjectAccessToken(
          client,
          args.project,
          oldToken,
        );
      } catch (error) {
        throw new Error(
          `CI variable ${args.ci_variable_key} now references replacement project access token ID ${replacement.id ?? "unknown"}, but old token ID ${oldToken.id} could not be revoked. Revoke the old token before considering the rotation complete.`,
          { cause: error },
        );
      }

      return {
        outcome: "replaced_and_revoked",
        replacement_token: replacement,
        ci_variable: variableAfter.metadata,
        old_token: revokedOld,
      };
    },
  );
}
