/**
 * Generic response-shaping and sanitization helpers shared across all
 * GitLab tool families.  Every MCP response passes through these
 * helpers to ensure consistent formatting and credential suppression.
 */

import {
  GitLabApiError,
  GitLabAuthenticationError,
} from "../gitlab-client.mjs";

export function textFor(value) {
  const text = JSON.stringify(value, null, 2);
  return text.length <= 120_000
    ? text
    : `${text.slice(0, 120_000)}\n... response truncated by MCP presentation limit`;
}

export function cleanBody(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

/**
 * Determine whether an object key looks like it names a secret, credential,
 * or authorization field that should never appear in operator-visible output.
 *
 * Five complementary patterns cover the known GitLab credential families:
 *
 *  1. **token / secret / password** — original underscore-delimited pattern
 *     that catches `access_token`, `PASSWORD`, `ssh_secret`, etc.
 *
 *  2. **camelCase secret/password** — catches `clientSecret` and similar
 *     camelCase compound names without creating false positives on
 *     metadata-only fields like `tokenType` or `tokenScope`.
 *
 *  3. **credential / credentials** — preceded by a word boundary, camelCase
 *     letter, or underscore (e.g. `credentials`, `sshCredentials`).
 *
 *  4. **key** — only when preceded by an underscore (avoids false-positives
 *     on the legitimate `key` field used for CI variable names).  Examples:
 *     `api_key`, `ssh_key`, `private_key`, `deploy_key`.
 *
 *  5. **auth / authentication / authorization** — preceded by underscore or
 *     a camelCase letter, followed by end-of-string, underscore, or a
 *     recognized compound suffix (`entication…`, `orization…`).  Standalone
 *     safe metadata (`auth_type`, `authenticated_api`) is not caught.
 */
const SECRET_FAMILY_RE = /(?:^|_)(?:token|secret|password)(?:$|_)/i;
const CAMELCASE_SECRET_RE = /(?:secret|password)/i;
const CREDENTIAL_RE = /(?:^|_|[a-z])credential(?:s)?(?:$|_|[A-Z])/i;
const KEY_RE = /(?:_)key(?:s)?(?:$|_|[A-Z])/i;
const AUTH_RE =
  /(?:[a-z_]?)auth(?:s|$|_|(?:entication(?:$|_|[A-Z]|s))|(?:orization(?:$|_|[A-Z]|s)))/i;

function isSensitiveKey(candidate) {
  return (
    SECRET_FAMILY_RE.test(candidate) ||
    CAMELCASE_SECRET_RE.test(candidate) ||
    CREDENTIAL_RE.test(candidate) ||
    KEY_RE.test(candidate) ||
    AUTH_RE.test(candidate)
  );
}

export function sanitizeOperatorData(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOperatorData(item, key));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([candidate]) =>
          !isSensitiveKey(candidate) && candidate !== "merged_yaml",
      )
      .map(([candidate, item]) => [
        candidate,
        candidate === "variables" && Array.isArray(item)
          ? item.map(({ key: variableKey, variable_type }) =>
              cleanBody({ key: variableKey, variable_type }),
            )
          : sanitizeOperatorData(item, candidate),
      ]),
  );
}

// Every MCP representation passes through this boundary. GitLab error bodies
// can echo submitted values, so failures retain only stable diagnostics above.
export function sanitizeMcpResponse(value) {
  return sanitizeOperatorData(value);
}

export function success(result) {
  const safeResult = sanitizeMcpResponse(result);
  return {
    content: [{ type: "text", text: textFor(safeResult) }],
    structuredContent: { result: safeResult },
  };
}

export function failure(error, authChallenge) {
  const result =
    error instanceof GitLabApiError
      ? {
          error: error.name,
          message: error.message,
          status: error.status,
          method: error.method,
          path: error.path,
        }
      : {
          error: error?.name || "Error",
          message: error?.message || String(error),
        };
  const safeResult = sanitizeMcpResponse(result);
  const response = {
    content: [{ type: "text", text: textFor(safeResult) }],
    structuredContent: { result: safeResult },
    isError: true,
  };
  if (error instanceof GitLabAuthenticationError && authChallenge) {
    response._meta = {
      "mcp/www_authenticate": [authChallenge],
    };
  }
  return response;
}
