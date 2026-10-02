# Observability contract

GitLab MCP keeps observability in the harness-neutral server core so Codex,
Claude Code, Cline, Pi, and future adapters inherit one implementation and one
privacy policy.

OBS-01 defines the provider-neutral completion-event contract. OBS-02 maps that
contract to an optional OpenTelemetry runtime without changing MCP responses or
GitLab API behavior. Adapters do not initialize or implement telemetry.

## Versioned core event schema

Every core event carries `schemaVersion: 2` and a fixed `event` category.
Schema v2 adds bounded custom metric events to the embedding observer surface;
schema v1 exposed only HTTP-request and MCP-tool completion events. Embedding
consumers should reject or explicitly handle schema versions they do not support.
Observers are best-effort: synchronous exceptions and rejected promises are
ignored so telemetry failure cannot change MCP behavior.

Embedding callers inject `observabilityObserver` through `createGitLabMcpServer`
for tool and custom metric events or `createHttpApp` for HTTP, custom metric, and
per-request tool events. The standard CLI deployment installs the OBS-02 observer
plus active MCP-operation and tool-execution tracing scopes before loading the
stdio or HTTP server implementation.

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

### Custom metric measurement

`event: "metric"` is the embedding-facing representation of one measurement
accepted by the machine-readable GitLab MCP Metric Contract v1. It contains only:

- `metric`: one contract-declared `gitlab_mcp.*` instrument name;
- `value`: one finite numeric measurement value that is valid for the declared
  instrument type;
- `attributes`: only contract-declared attributes after required-attribute,
  closed-enum, registered-identifier, privacy, and cardinality validation.

The event is emitted only after the same sanitizer and process-local cardinality
boundary used by the OpenTelemetry metric recorder accepts the measurement, so
arbitrary fields or excess identifier series cannot enter the embedding observer
through the metric path. Exact identifier dimensions such as tool names must be
registered by a server-controlled boundary before they are preserved; otherwise
they collapse to the fixed `unknown` sentinel. The OTel recorder revalidates the
bounded measurement before recording the instrument series. Metric classification
metadata is itself contract-validated: Metric Contract v1 accepts only the
reviewed `non-sensitive` privacy classification and `experimental` stability
status.

Tool-call error-category metrics do not infer caller validation failures from
generic JavaScript exception classes. `TypeError`, `RangeError`, `SyntaxError`,
and other ordinary runtime exceptions default to `internal`; a known validation
boundary must supply the bounded `validation` observability-category hint
explicitly.

## OpenTelemetry runtime

OpenTelemetry is disabled unless `MCP_OTEL_ENABLED=true`. Enabling the flag is
not sufficient by itself: both trace and metric OTLP endpoints must resolve.
This prevents the SDK from silently falling back to an implicit local exporter
when a deployment has not intentionally configured telemetry.

Configure either one base endpoint:

```text
MCP_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com
```

which resolves to `/v1/traces` and `/v1/metrics`, or configure both signal
endpoints explicitly:

```text
MCP_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel-collector.example.com/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otel-collector.example.com/v1/metrics
```

The pinned HTTP/protobuf exporters retain their standard transport configuration
for headers, compression, CA certificates, and mTLS client certificates/keys.
General `OTEL_EXPORTER_OTLP_*` settings can be overridden by their
`OTEL_EXPORTER_OTLP_TRACES_*` or `OTEL_EXPORTER_OTLP_METRICS_*` equivalents.
Metrics additionally honor the standard temporality preference and default
histogram aggregation variables. Product-owned endpoint resolution and bounded
export timeouts remain authoritative where OBS-02 supplies them programmatically.
The Pi adapter forwards this reviewed exporter subset to its packaged MCP child
instead of forwarding arbitrary `OTEL_*` environment state.

If telemetry is disabled, the enable flag is absent, or either required signal
endpoint is missing, the runtime does not construct exporters and does not add
telemetry network activity.

OpenTelemetry log export is intentionally disabled even when standard OTel log
export environment variables are present. OBS-02 owns only the reviewed trace
and metric signals, so log records cannot bypass the centralized privacy policy.

OBS-02 exports with `service.name=gitlab-mcp` and enables these centralized
standard instrumentations:

- OpenTelemetry HTTP instrumentation for Node HTTP server/client telemetry;
- OpenTelemetry Undici instrumentation for Node `fetch`/GitLab client tracing;
- host metrics restricted to process CPU and memory groups;
- Node runtime metrics for event-loop and V8/runtime behavior.

The OBS-02 SDK installs a traceparent-only text-map propagator. Incoming and
outgoing distributed trace correlation therefore carries only the W3C
`traceparent` header; `tracestate` and baggage are neither extracted into the
runtime context nor injected into GitLab or other instrumented HTTP requests.
This deliberately narrows the default NodeSDK propagation surface so arbitrary
vendor/user-controlled propagation values cannot bypass the telemetry allowlist.

The core measures `mcp.server.operation.duration` around every registered inbound
MCP request and notification. Request operations begin at transport delivery and
normally finish only after the corresponding response has been written by the
transport. If the client cancels an outstanding request before response sending
begins, the pinned MCP SDK suppresses that response; OBS-02 finishes the operation
at the accepted cancellation and records the fixed `cancelled` error category.
A cancellation received after response sending has begun leaves completion to
the response-send path. Notifications finish when their handler completes because
JSON-RPC notifications have no response. When the MCP protocol revision is
available, the operation span and duration metric include `mcp.protocol.version`.
The value is accepted only when it appears in the pinned MCP SDK's
supported-version list. Initialize operations use the revision actually
negotiated by the transport by completion; subsequent connection-scoped
operations inherit that negotiated revision, while stateless HTTP operations can
obtain it from the SDK-provided `MCP-Protocol-Version` request header. Unsupported
or malformed revision values are omitted rather than becoming telemetry
dimensions.

`tools/call` operations additionally carry bounded GenAI tool attributes and
record `gen_ai.execute_tool.duration` from the OBS-01 tool event. Requested tool
names are validated against the registered inventory before entering telemetry,
collapsing unknown names to a fixed sentinel. JSON-RPC response codes are limited
to reviewed protocol categories before entering spans or metrics; unrecognized
error codes collapse to the fixed `other_error` sentinel. Other MCP methods do
not copy request parameters into telemetry. Only a bounded W3C `traceparent`
value is accepted from MCP `params._meta`; `tracestate` and arbitrary baggage are
deliberately not propagated under the OBS-02 privacy policy. The
semantic-convention snapshot is isolated in
`server/src/opentelemetry-semconv.mjs` because the MCP and GenAI conventions
remain development status and may evolve.

The intended trace hierarchy for tool-backed GitLab work is:

```text
MCP tools/call
└─ execute_tool
   └─ GitLab HTTP/fetch client request
```

The outer SERVER span covers the complete inbound MCP request through transport
response send, or through an accepted cancellation when no response is emitted.
Non-tool requests and notifications receive their own MCP SERVER spans without
GenAI tool attributes. The inner INTERNAL span exists only for registered tool
execution. This keeps standardized MCP operation latency distinct from tool
execution latency.

HTTP request telemetry comes from the standard HTTP instrumentation rather than
a duplicate custom metric stream. The provider-neutral OBS-01 HTTP event remains
available to embedding callers but is intentionally not remapped into a second
OpenTelemetry HTTP metric.

### Runtime bounds

The following deployment controls are bounded and fall back to their defaults
when an invalid value is supplied:

- `MCP_OTEL_SHUTDOWN_TIMEOUT_MS`: default `5000`; accepted range
  `100`-`120000` ms.
- `MCP_OTEL_EXPORT_TIMEOUT_MS`: default `10000`; accepted range
  `100`-`120000` ms.
- `MCP_OTEL_METRIC_EXPORT_INTERVAL_MS`: default `60000`; accepted range
  `1000`-`900000` ms.

The configured export timeout remains the timeout supplied to each OTLP
exporter. The periodic metrics reader separately caps its per-cycle timeout at
the configured metric export interval, because the OpenTelemetry JS metrics SDK
requires the reader timeout to be no greater than its interval. Therefore every
value in the documented ranges remains a valid telemetry configuration, even
when the metric interval is shorter than the exporter timeout.

Telemetry bootstrap, exporter, instrumentation, and shutdown failures are
fail-open with respect to MCP behavior. Shutdown waits only for the configured
bounded telemetry window.

## Privacy and cardinality rules

Observation fields are an explicit allowlist. New fields require the same
security review as a model-facing response field, plus a cardinality review for
metrics use. In particular, telemetry must never export:

- MCP tool arguments or results;
- request or response bodies;
- authentication material, tokens, token hashes, or GitLab headers;
- usernames, user IDs, project/group paths or IDs;
- branches, tags, commit SHAs, issue/MR/pipeline/job IDs;
- raw GitLab URL paths or query strings;
- CI variable names or values;
- job logs or artifact content;
- arbitrary error messages or stacks.

Standard HTTP/Undici spans pass through a fail-closed projection immediately
before trace export. Only reviewed low-cardinality protocol and core attributes
are retained: bounded MCP/GenAI operation and tool names, the bounded MCP
protocol revision, bounded error/status categories, HTTP method/status, URL
scheme, network transport/protocol metadata, and retry count. All other span and
event attributes are dropped, including server/client addresses, URL/path/query
values, original HTTP methods, captured headers, user-agent values, and future
semantic-convention attributes until they receive an explicit
privacy/cardinality review. HTTP span names are rebuilt from the bounded method
rather than preserving instrumentation-derived route text; MCP/tool span names
are rebuilt from their already-bounded core attributes. Unknown span names
collapse to `operation`.

Trace-state data is also excluded at the export boundary. The span context,
parent context, and link contexts retain only trace ID, span ID, trace flags, and
remote-parent state; `tracestate` is never forwarded to the exporter. This is a
second boundary behind the traceparent-only propagator rather than relying on
propagation configuration alone.

Standard OpenTelemetry HTTP metrics remain owned by the pinned instrumentation
instead of being duplicated or rewritten by product code. In server mode their
request dimensions are bounded method/scheme plus protocol, status, and error
semantics emitted by the instrumentation; in client mode `server.address` and
`server.port` identify the configured GitLab destination as required by the
standard HTTP client metric contract. They do not contain GitLab request paths,
query strings, tool arguments, or response bodies.

High-cardinality request IDs are used only inside the transport correlation map
and are never copied into span attributes or metric dimensions. Adapters must not
add parallel telemetry or bypass the centralized export policy.

Semantic response projection/token reduction remains a separate core concern
and must not be coupled to observability or implemented in adapters.
