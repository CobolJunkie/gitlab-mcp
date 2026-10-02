/**
 * Generic response-shaping and sanitization helpers shared across all
 * GitLab tool families.  Every MCP response passes through these
 * helpers to ensure consistent formatting and credential suppression.
 */

import {
  GitLabApiError,
  GitLabAuthenticationError,
} from "../gitlab-client.mjs";
import { observeMetric } from "../observability.mjs";

const PRESENTATION_LIMIT = 120_000;

export const ONE_TIME_TOKEN_RESULT = Object.freeze({
  kind: "one_time_secret",
  field: "token",
});

function serializedResult(value) {
  return JSON.stringify(value, null, 2);
}

export function textFor(value) {
  const text = serializedResult(value);
  return text.length <= PRESENTATION_LIMIT
    ? text
    : `${text.slice(0, PRESENTATION_LIMIT)}\n... response truncated by MCP presentation limit`;
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

function oneTimeStructuredResult(value, safeValue, resultPolicy) {
  if (resultPolicy === undefined) {
    return safeValue;
  }
  if (
    resultPolicy?.kind !== ONE_TIME_TOKEN_RESULT.kind ||
    resultPolicy?.field !== ONE_TIME_TOKEN_RESULT.field
  ) {
    throw new TypeError("Unsupported MCP result policy.");
  }
  const token = value?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError(
      "One-time token results must contain a non-empty string token.",
    );
  }
  return { ...safeValue, token };
}

function observePresentation(safeResult, { observer, tool, outcome }) {
  if (typeof observer !== "function" || !tool) {
    return;
  }
  const text = serializedResult(safeResult);
  observeMetric({
    observer,
    metric: "gitlab_mcp.tool.result.size",
    value: Buffer.byteLength(text, "utf8"),
    attributes: { tool, outcome },
  });
  if (text.length > PRESENTATION_LIMIT) {
    observeMetric({
      observer,
      metric: "gitlab_mcp.tool.presentation.truncations",
      attributes: { tool, outcome },
    });
  }
}

export function success(result, options = {}) {
  const textResult = sanitizeMcpResponse(result);
  const structuredResult = oneTimeStructuredResult(
    result,
    textResult,
    options.resultPolicy,
  );
  // Keep observability on the sanitized representation only. The one-time
  // secret-bearing object never enters metrics, traces, or presentation logs.
  observePresentation(textResult, { ...options, outcome: "success" });
  return {
    content: [{ type: "text", text: textFor(textResult) }],
    structuredContent: { result: structuredResult },
  };
}

function safeErrorProperty(error, property, fallback) {
  try {
    return error?.[property] || fallback;
  } catch {
    return fallback;
  }
}

function safeErrorMessage(error) {
  try {
    if (error?.message) {
      return error.message;
    }
  } catch {
    // Preserve the legacy String(error) fallback without trusting accessors.
  }
  try {
    return String(error);
  } catch {
    return "Unknown error.";
  }
}

export function failure(error, authChallenge, options = {}) {
  const result =
    error instanceof GitLabApiError
      ? {
          error: safeErrorProperty(error, "name", "GitLabApiError"),
          message: safeErrorProperty(
            error,
            "message",
            "GitLab API request failed.",
          ),
          status: safeErrorProperty(error, "status"),
          method: safeErrorProperty(error, "method"),
          path: safeErrorProperty(error, "path"),
        }
      : {
          error: safeErrorProperty(error, "name", "Error"),
          message: safeErrorMessage(error),
        };
  const safeResult = sanitizeMcpResponse(result);
  observePresentation(safeResult, { ...options, outcome: "error" });
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
