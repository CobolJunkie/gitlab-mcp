# Observability contract

GitLab MCP keeps observability in the harness-neutral server core so Codex,
Claude Code, Cline, Pi, and future adapters inherit one implementation and one
privacy policy.

OBS-01 defines a provider-neutral completion-event contract. It does **not**
initialize an OpenTelemetry SDK, exporter, collector, or vendor backend. That
separation keeps telemetry delivery a deployment concern and lets the core event
shape be reviewed for confidentiality and cardinality before it is mapped to
traces and metrics.

## Versioned event schema

Every core event carries `schemaVersion: 1` and a fixed `event` category.
Observers are best-effort: synchronous exceptions and rejected promises are
ignored so telemetry failure cannot change MCP behavior.

Embedding callers inject `observabilityObserver` through `createGitLabMcpServer`
for tool events or `createHttpApp` for HTTP plus per-request tool events. The
HTTP app forwards the same observer into each per-request MCP server. OBS-01 CLI
startup does not install an exporter; deployment-time SDK/exporter wiring
belongs to OBS-02.

### HTTP request completion

`event: "http_request"` contains only:

- `requestId`: the server-generated correlation identifier, reduced to
  `"unknown"` if it is not a bounded safe identifier;
- `method`: `GET`, `POST`, `DELETE`, `PUT`, `PATCH`, `HEAD`, `OPTIONS`, or
  `OTHER`;
- `route`: `mcp`, `health`, `readiness`, `oauth_metadata`, or `unmatched`;
- `status`: an HTTP status from 100 through 599, otherwise `0`;
- `outcome`: `success` for 1xx-3xx responses, `error` for 4xx-5xx responses, or
  `unknown` when status metadata is invalid;
- `durationMs`: non-negative elapsed milliseconds rounded to two decimals.

Raw URL paths are deliberately not part of the event. Known case and
single-trailing-slash route variants accepted by the HTTP router reduce to the
same fixed route category. An unmatched path is reported as `unmatched`, so path
segments, query strings, credentials, and other user-controlled URL data cannot
become telemetry dimensions.

The existing HTTP `requestObserver` compatibility callback remains supported.
It receives the same bounded metadata with the historical `path` field mapped
to a fixed canonical path such as `/mcp`, `/health`, `/ready`, or
`<unmatched>`.

### MCP tool completion

`event: "mcp_tool_call"` contains only:

- `tool`: the registered MCP tool name, reduced to `"unknown"` if it is not a
  bounded safe identifier;
- `readOnly`: the tool's registered `readOnlyHint` classification;
- `deploymentMode`: `embedded`, `http`, `stdio`, or `unknown`;
- `outcome`: `success` or `error`;
- `durationMs`: non-negative elapsed milliseconds rounded to two decimals;
- `errorType` on failures: a small allowlist of built-in or GitLab client error
  class names, falling back to `Error`.

Tool execution is observed once in the shared registrar. Tool arguments,
results, GitLab payloads, project/group identifiers, usernames, URLs, headers,
tokens, error messages, and stacks are never passed to the event constructor.
Adapters must not add parallel tool telemetry.

## Privacy and cardinality rules

Observation fields are an explicit allowlist. New fields require the same
security review as a model-facing response field, plus a cardinality review for
future metrics use. In particular:

- never attach request or response bodies;
- never attach MCP tool arguments or results;
- never attach authentication material or GitLab headers;
- never attach arbitrary URLs, paths, project/group names, usernames, issue/MR
  titles, commit messages, or error messages/stacks;
- prefer fixed categories over free-form strings;
- keep tool names tied to the registered inventory rather than user input.

## OpenTelemetry follow-up

OBS-02 should map this stable core contract to optional OpenTelemetry traces and
metrics, including deployment-time SDK/exporter configuration and graceful
shutdown. The mapping should keep high-cardinality request IDs on traces only,
use bounded categorical dimensions for metrics, and preserve the allowlist
above. OpenTelemetry log export is not part of OBS-01.

Semantic response projection/token reduction remains a separate core concern
and must not be coupled to observability or implemented in adapters.
