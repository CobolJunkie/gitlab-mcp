/**
 * Project webhook diagnostic tools for the GitLab MCP server.
 *
 * Provides read-only inspection of project webhook configuration and recent
 * delivery events so operators can diagnose failed integrations without
 * leaving the MCP workflow.
 *
 * SECURITY:
 * - Webhook secret tokens and custom-header secrets are never exposed.
 * - Request body headers are redacted for any key matching the project-wide
 *   secret-family patterns plus the explicit `token` header used by
 *   GitLab webhook signatures.
 * - Response body *contents* are never included in default output.
 *   Only metadata (presence flag and byte-length) is returned so that
 *   opaque receiver-controlled response bodies cannot leak credentials,
 *   diagnostics, tokens, or internal URLs.
 * - The `data` field (full delivery payload) is omitted by default.
 * - Mutation tools (test, resend, create, update, delete) are explicitly
 *   excluded from this module and reserved for a future acknowledged
 *   mutation family.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../gitlab-client.mjs";
import { READ_ONLY } from "./annotations.mjs";
import { project, page, perPage } from "./schemas.mjs";
import { p } from "./paths.mjs";

// ── Response / safety helpers ──────────────────────────────────────────────

/**
 * Header keys that always hold secrets and must be redacted from
 * webhook request/response output.
 */
const SECRET_HEADER_KEYS = new Set([
  "token",
  "x-gitlab-token",
  "authorization",
]);

/**
 * Test whether a header key should be redacted because it likely
 * carries a secret value (e.g. `X-Gitlab-Token`, `Authorization`,
 * `X-Custom-Secret`, `X-Auth-Token`).
 */
export function isSecretHeader(key) {
  const lower = key.toLowerCase();
  if (SECRET_HEADER_KEYS.has(lower)) {
    return true;
  }
  // Catch any header whose name contains "secret" (case-insensitive).
  if (lower.includes("secret")) {
    return true;
  }
  // Catch any header whose name contains "auth" (Authorization, Auth-Token,
  // X-Auth-Token, Proxy-Authentication, etc.)
  if (lower.includes("auth")) {
    return true;
  }
  return false;
}

/**
 * Redact sensitive headers from a headers object.
 * Returns a new object with secret values replaced by `[REDACTED]`.
 *
 * @param {Record<string,unknown>} headers - The headers object.
 * @param {boolean} [blanket=false] - When true, redact ALL values
 *   unconditionally (useful for operator-configured custom headers
 *   where every value may carry a credential).
 */
export function redactHeaders(headers, blanket = false) {
  if (!headers || typeof headers !== "object") {
    return headers;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      blanket || isSecretHeader(key) ? "[REDACTED]" : value,
    ]),
  );
}

/**
 * Build safe webhook metadata from a GitLab webhook response object.
 *
 * Strips the `token` field (webhook secret) and any custom-header
 * secrets that may appear under `custom_headers`.  Only non-sensitive
 * configuration metadata is returned.
 */
export function webhookMetadata(hook) {
  if (!hook || typeof hook !== "object") {
    return hook;
  }

  // Custom headers are operator-configured and may carry arbitrary
  // credential values (X-Api-Key, X-Webhook-Key, vendor-specific
  // names, etc.).  Blanket-redact every value while retaining keys
  // so operators can see which headers exist without disclosing
  // any secret content.
  const safeCustomHeaders = hook.custom_headers
    ? redactHeaders(hook.custom_headers, true)
    : undefined;

  return {
    id: hook.id,
    url: hook.url,
    description: hook.description,
    created_at: hook.created_at,
    push_events: hook.push_events,
    push_events_branch_filter: hook.push_events_branch_filter,
    issues_events: hook.issues_events,
    confidential_issues_events: hook.confidential_issues_events,
    merge_requests_events: hook.merge_requests_events,
    tag_push_events: hook.tag_push_events,
    note_events: hook.note_events,
    confidential_note_events: hook.confidential_note_events,
    job_events: hook.job_events,
    pipeline_events: hook.pipeline_events,
    wiki_page_events: hook.wiki_page_events,
    deployment_events: hook.deployment_events,
    releases_events: hook.releases_events,
    subgroup_events: hook.subgroup_events,
    member_events: hook.member_events,
    custom_events: hook.custom_events,
    enable_ssl_verification: hook.enable_ssl_verification,
    ...(safeCustomHeaders && Object.keys(safeCustomHeaders).length > 0
      ? { custom_headers: safeCustomHeaders }
      : {}),
  };
}

/**
 * Build safe webhook event/delivery metadata from a GitLab webhook
 * event response object.
 *
 * Field names match the documented GitLab Project Webhooks API:
 * https://docs.gitlab.com/api/project_webhooks/
 *
 * **Confidentiality contract (default output):**
 * - `response_body` *contents* are never exposed.  Only a boolean
 *   presence flag and an optional byte-length are returned so that
 *   opaque receiver-controlled response bodies cannot leak credentials,
 *   diagnostics, tokens, or internal URLs.
 * - `request_data` and `data` payloads are always omitted.
 * - Sanitizes request_headers and response_headers.
 */
export function webhookEventMetadata(event) {
  if (!event || typeof event !== "object") {
    return event;
  }

  const safeRequestHeaders = redactHeaders(event.request_headers);

  // Response headers may contain server-internal values (e.g.
  // X-Powered-By, X-Pd-Status).  Redact any that match secret
  // patterns; the rest are safe diagnostic metadata.
  const safeResponseHeaders = redactHeaders(event.response_headers);

  // ── Response-body confidentiality ────────────────────────────────
  // Never expose opaque receiver-controlled body *contents*.
  // Retain only safe metadata: whether a body existed and its
  // approximate size so operators can gauge the response without
  // learning its secrets.
  const hasBody =
    event.response_body !== undefined && event.response_body !== null;
  const bodyLength =
    hasBody && typeof event.response_body === "string"
      ? event.response_body.length
      : undefined;

  return {
    id: event.id,
    url: event.url,
    trigger: event.trigger,
    request_headers: safeRequestHeaders,
    response_headers:
      safeResponseHeaders && Object.keys(safeResponseHeaders).length > 0
        ? safeResponseHeaders
        : undefined,
    response_body_present: hasBody,
    ...(hasBody && bodyLength !== undefined
      ? { response_body_length: bodyLength }
      : {}),
    response_status: event.response_status,
    execution_duration: event.execution_duration,
    // Intentionally omitted:
    // - `response_body` — opaque receiver-controlled content; may
    //   contain credentials, diagnostic dumps, tokens, internal URLs,
    //   or other sensitive values that structural field-name
    //   sanitization cannot reliably detect.
    // - `request_data` — full webhook request body which may embed
    //   secrets, PII, or large payloads.
    // - `data` — legacy alias for request_data in some GitLab versions;
    //   same security rationale.
  };
}

// ── Tool registration ──────────────────────────────────────────────────────

/**
 * Register project webhook diagnostic tools.
 *
 * Read-only inspection tools only.  Mutation tools (test, resend,
 * create, update, delete) are deliberately excluded and reserved for
 * a future separately acknowledged mutation family.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerWebhookTools(tool) {
  tool(
    "list_project_webhooks",
    {
      title: "List project webhooks",
      description:
        "List project webhook configurations. Secret tokens and secret custom headers are never exposed.",
      inputSchema: {
        project,
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      const response = await client.request(`${p(projectValue)}/hooks`, {
        query,
      });
      const hooks = Array.isArray(response.data)
        ? response.data.map(webhookMetadata)
        : [];
      return { ...response, data: hooks };
    },
  );

  tool(
    "get_project_webhook",
    {
      title: "Get project webhook",
      description:
        "Get one project webhook configuration by ID. Secret tokens and secret custom headers are never exposed.",
      inputSchema: {
        project,
        webhook_id: z
          .number()
          .int()
          .positive()
          .describe("Project-scoped webhook ID."),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, webhook_id } = args;
      const response = await client.request(
        `${p(projectValue)}/hooks/${encodePathSegment(String(webhook_id))}`,
      );
      return webhookMetadata(response.data);
    },
  );

  tool(
    "list_project_webhook_events",
    {
      title: "List project webhook delivery events",
      description:
        "List recent delivery events for a specific project webhook. Response body contents are never exposed; only presence and size metadata are returned. Header secrets are redacted.",
      inputSchema: {
        project,
        webhook_id: z
          .number()
          .int()
          .positive()
          .describe("Project-scoped webhook ID whose events are listed."),
        status: z
          .union([
            z.number().int(),
            z.enum(["successful", "client_failure", "server_failure"]),
          ])
          .optional()
          .describe(
            "Filter by HTTP status code or status category (successful, client_failure, server_failure).",
          ),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, webhook_id, ...query } = args;
      const response = await client.request(
        `${p(projectValue)}/hooks/${encodePathSegment(String(webhook_id))}/events`,
        { query },
      );
      const events = Array.isArray(response.data)
        ? response.data.map(webhookEventMetadata)
        : [];
      return { ...response, data: events };
    },
  );

  tool(
    "get_project_webhook_event",
    {
      title: "Get project webhook delivery event",
      description:
        "Get one webhook delivery event by ID. Searches through GitLab's documented event-list endpoint (events from the past 7 days only). Inspects at most 10 pages (1,000 events). Not a direct event lookup — the event must appear in the paginated list. Response body contents are never exposed; only presence and size metadata are returned. Header secrets are redacted.",
      inputSchema: {
        project,
        webhook_id: z
          .number()
          .int()
          .positive()
          .describe("Project-scoped webhook ID."),
        event_id: z
          .number()
          .int()
          .positive()
          .describe("Project-scoped webhook event ID."),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, webhook_id, event_id } = args;
      const hookPath = `${p(projectValue)}/hooks/${encodePathSegment(String(webhook_id))}/events`;

      // Bounded search through the documented event-list endpoint.
      // Max 10 pages × per_page 100 = 1 000 events inspected.
      const MAX_PAGES = 10;
      const PER_PAGE = 100;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await client.request(hookPath, {
          query: { page, per_page: PER_PAGE },
        });

        const events = Array.isArray(response.data) ? response.data : [];
        for (const event of events) {
          if (event && event.id === event_id) {
            return webhookEventMetadata(event);
          }
        }

        // Stop when GitLab indicates no further results.
        if (events.length < PER_PAGE) {
          break;
        }
      }

      throw new Error(
        `Webhook event ${event_id} not found for webhook ${webhook_id} after exhausting the bounded search (max ${MAX_PAGES} pages).`,
      );
    },
  );
}
