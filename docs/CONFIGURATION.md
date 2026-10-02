# Configuration reference

GitLab MCP supports local stdio and remote Streamable HTTP transports. The
canonical server uses the same GitLab/runtime environment variables in every
supported harness; adapters add only harness-specific launch or packaging
configuration. Values are read when the MCP process starts, so restart the
owning harness or deployment after changing configuration.

## Local stdio

The canonical GitLab settings are:

- `GITLAB_URL` defaults to `https://gitlab.com` and identifies the GitLab
  instance root. Self-managed URL prefixes are preserved.
- `GITLAB_ALLOW_INSECURE_HTTP=false` by default. Setting it to `true` allows an
  HTTP GitLab URL only outside production and only for a recognized
  local/private development host.
- `GITLAB_TOKEN` is the preferred personal, project, group, or compatible
  access token.
- `GITLAB_PRIVATE_TOKEN` is a compatibility alias used only when
  `GITLAB_TOKEN` is absent.

Codex uses the established root `.mcp.json`, which launches Node through the
Codex preload and then the canonical bundle named by `distribution.json`'s
`mcp.bundle` field, rooted at `${PLUGIN_ROOT}`, with `--stdio`. Claude Code,
Cline, and Pi use their adapter-owned launch/package contracts instead. All four
ultimately start or bridge to the same canonical MCP bundle and consume the same
GitLab environment variables.

Stdio requires a token. Keep it in the parent process environment or a secret
manager, never in distributable MCP configuration.

`GITLAB_URL` must use HTTPS by default and rejects embedded credentials, query
strings, and fragments. For a loopback or private development GitLab instance
that cannot use TLS, set `GITLAB_ALLOW_INSECURE_HTTP=true` explicitly. The
override accepts loopback and private-network IPs, single-label hosts, and
hostnames ending in `.localhost`, `.local`, `.internal`, or `.home.arpa`. It is
rejected when `NODE_ENV=production` and for public hostnames.

## HTTP listener and public URL

The HTTP listener uses these settings:

- `MCP_HOST` defaults to `127.0.0.1`. Binding to `0.0.0.0` or `::` requires
  `MCP_ALLOWED_HOSTS`.
- `PORT` defaults to `3000` and is the preferred listener-port variable.
- `MCP_PORT` is the port fallback when `PORT` is absent and also defaults to
  `3000`.
- `MCP_PUBLIC_URL` is derived for local development but is required when
  `NODE_ENV=production`. Production requires an HTTPS URL ending in `/mcp`.
- `MCP_ALLOWED_HOSTS` is a comma-separated host allowlist and is required for
  wildcard bind addresses.
- `MCP_SHUTDOWN_TIMEOUT_MS` defaults to `30000` and accepts 1 through 300,000
  milliseconds for graceful HTTP draining.
- `MCP_ALLOW_INSECURE_PUBLIC_URL=false` by default. It can permit an HTTP MCP
  URL only for loopback local development and is rejected in production or on
  public listeners.
- `MCP_BUILD_ID` is optional. It is shown only when it is a 7–64-character
  hexadecimal commit/build ID; arbitrary values are suppressed.
- `NODE_ENV=production` requires an explicit valid `MCP_PUBLIC_URL`.

The canonical Docker image preserves the same listener precedence:
`PORT` wins when set, otherwise `MCP_PORT` is used, and if neither is set
the runtime and container health check both use port `3000`.

`MCP_PUBLIC_URL` rejects embedded credentials, queries, and fragments, including
explicitly empty `?` or `#` delimiters. Percent-encoded `%3F` and `%23` path
data remain path data. The runtime strips trailing slashes, maps a bare origin
to `/mcp`, and then requires
the resulting pathname to end in `/mcp`. The stricter deployment variable
`MCP_DEPLOY_PUBLIC_URL` may use an explicit port or reverse-proxy subpath, but
its pathname must already end in `/mcp`; a trailing slash after `/mcp` is
rejected before deployment.

## Authentication and access mode

Authentication and exposure are controlled by:

- `MCP_READ_ONLY=false` by default. Setting it to `true` registers only
  read-only tools and advertises GitLab `read_api` instead of `api`.
- `ALLOW_SERVER_TOKEN_HTTP=false` by default. Setting it to `true` allows
  `GITLAB_TOKEN` in HTTP mode only for loopback private testing; shared/public
  deployments reject it.
- `MCP_TOKEN_CACHE_MAX_ENTRIES=256` bounds validated bearer identities retained
  in the 60-second TTL/LRU cache.
- `MCP_AUTH_FAILURE_LIMIT=20` bounds repeated GitLab `401` invalid-credential
  rejections for one bearer token digest within the failure window (allowed
  range 1 through 100,000).
- `MCP_AUTH_FAILURE_WINDOW_MS=60000` sets that per-token rejection window
  (allowed range 1 through 86,400,000 ms).
- `MCP_AUTH_FAILURE_MAX_ENTRIES=1024` hard-bounds per-token failure-tracking
  state.
- `MCP_AUTH_VALIDATION_LIMIT=40` caps total uncached GitLab token-validation
  attempts across the process within the validation window (allowed range 1
  through 100,000). Cached valid identities bypass this upstream-validation
  budget.
- `MCP_AUTH_VALIDATION_WINDOW_MS=60000` sets that process-wide uncached
  validation window (allowed range 1 through 86,400,000 ms).

Bearer tokens are validated against the configured GitLab `/api/v4/user`
endpoint. GitLab `401` responses are treated as invalid credentials and feed
the per-token failure limiter. GitLab `403` responses are returned as
`insufficient_scope` without incrementing invalid-credential state. GitLab
`429`, `5xx`, network, timeout, and other non-authoritative validation
failures return a sanitized `503 temporarily_unavailable` response and do not
increment that per-token state. All uncached validation attempts still consume
the independent process-wide validation budget.

Cache and failure keys use a one-way token digest and do not retain the raw
token as the key. The per-token failure limiter and process-wide
uncached-validation budget are independent of request concurrency limits.

## Request limits

Request concurrency and body size use:

- `MCP_MAX_REQUEST_BYTES=8388608`, with an allowed range of 65,536 through
  26,214,400 bytes.
- `MCP_MAX_CONCURRENT_REQUESTS=32`, which must be a positive integer.
- `MCP_MAX_CONCURRENT_REQUESTS_PER_IDENTITY=4`, which must also be a positive
  integer.
- `MCP_REQUEST_BODY_READ_TIMEOUT_MS=30000` sets the absolute wall-clock limit
  for reading one request body (allowed range 1,000 through 120,000 ms). New
  chunks do not reset this deadline.

Configure the TLS reverse proxy with request, connection, and client-IP limits
that complement these application bounds. The application authentication
limiters do not consume forwarded client-address headers, so any client-IP
policy belongs at a trusted proxy. Its request-body limit must be at least
`MCP_MAX_REQUEST_BYTES`. If the application is expected to return its sanitized
`408` response, configure the proxy body-read timeout longer than the
application deadline with enough margin to avoid a timeout race. The
application deadline still bounds admission if the proxy permits a slower
upload.

## HTTP endpoints

The service exposes:

- `POST /mcp`, authenticated with a bearer token, for stateless Streamable HTTP
  MCP requests.
- `GET /.well-known/oauth-protected-resource`, unauthenticated, for OAuth
  protected-resource metadata.
- `GET /.well-known/oauth-protected-resource/mcp`, unauthenticated, as the
  path-specific metadata alias.
- `GET /health`, unauthenticated, for topology-free process liveness.
- `GET /ready`, unauthenticated, for dependency readiness; it returns `503`
  while dependencies are unavailable.

Every response includes `X-Request-Id`. The built-in observer reports method,
path, status, duration, and request ID without bearer tokens or payloads.

## Optional OpenTelemetry

OpenTelemetry is disabled by default in both stdio and HTTP deployments. Enable
it only when an operator intends to export telemetry to an explicitly selected
OTLP collector:

- `MCP_OTEL_ENABLED=true` enables OBS-02 only when both trace and metric
  endpoints resolve.
- `OTEL_EXPORTER_OTLP_ENDPOINT` supplies a shared HTTP(S) base endpoint. GitLab
  MCP appends `/v1/traces` and `/v1/metrics` for the two signals.
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` overrides the trace endpoint when set.
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` overrides the metric endpoint when set.
  A signal-specific endpoint takes precedence over the shared base endpoint for
  that signal, so one signal may use an override while the other falls back to
  the base endpoint.
- `MCP_OTEL_SHUTDOWN_TIMEOUT_MS` defaults to `5000` and accepts 100 through
  120,000 milliseconds.
- `MCP_OTEL_EXPORT_TIMEOUT_MS` defaults to `10000` and accepts 100 through
  120,000 milliseconds.
- `MCP_OTEL_METRIC_EXPORT_INTERVAL_MS` defaults to `60000` and accepts 1,000
  through 900,000 milliseconds.

The pinned HTTP/protobuf exporters also honor the reviewed standard OTLP
transport settings for headers, compression, CA certificates, and mTLS client
certificates/keys, using the general `OTEL_EXPORTER_OTLP_*` variable or the
corresponding `OTEL_EXPORTER_OTLP_TRACES_*` / `OTEL_EXPORTER_OTLP_METRICS_*`
override. The metrics exporter also honors
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` and
`OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION`. Pi forwards this
same reviewed subset to its packaged MCP child; it does not forward arbitrary
`OTEL_*` variables.

OTLP endpoints must use HTTP or HTTPS and must not contain embedded URL
credentials. When telemetry is disabled or either required signal endpoint is
missing, GitLab MCP does not construct telemetry exporters or add telemetry
network activity. See [OBSERVABILITY.md](OBSERVABILITY.md) for the exported
signals, trace/metric semantics, privacy allowlist, and fail-open behavior.

## Recommended profiles

### Local read/write stdio

Set these variables in the environment that launches Codex, Claude Code, Cline,
or the Pi package:

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"
$env:GITLAB_TOKEN = "<api-token>"
```

Follow the matching adapter guide for the harness-specific package or MCP launch
configuration.

### Local read-only HTTP testing

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"
$env:MCP_READ_ONLY = "true"
$env:MCP_PUBLIC_URL = "http://127.0.0.1:3000/mcp"
$env:MCP_ALLOW_INSECURE_PUBLIC_URL = "true"
npm.cmd run start:http
```

### Shared production HTTP

```text
NODE_ENV=production
GITLAB_URL=https://gitlab.example.com
MCP_HOST=0.0.0.0
PORT=3000
MCP_PUBLIC_URL=https://mcp.example.com/mcp
MCP_ALLOWED_HOSTS=mcp.example.com
```

Do not set a shared `GITLAB_TOKEN` or `GITLAB_PRIVATE_TOKEN` in this profile.
Repository-driven production deployment uses the protected,
`production`-environment-scoped `MCP_DEPLOY_VALIDATION_TOKEN` control-plane
secret for authenticated parity and runtime checks; that secret is transferred
ephemerally and is not copied into
the public runtime container. Complete the OAuth and reverse-proxy steps in
[CHATGPT_DEPLOYMENT.md](CHATGPT_DEPLOYMENT.md).

## Disposable integration suite

The disposable integration suite (`npm run test:integration:disposable`)
exercises MCP GitLab tools against a dedicated throwaway fixture project. It is
the stronger integration layer compared with the read-only
`npm run test:integration` smoke test.

### Fixture project requirements

The disposable project must:

- be a separate GitLab project used only for integration testing;
- have a default branch with a readable file;
- expose a readable fixture path, defaulting to `README.md`;
- allow temporary merge-request creation when optional MR coverage is enabled;
  and
- provide a known small artifact job ID when optional artifact retrieval is
  enabled.

### Protected CI variables

All disposable-integration variables must be **protected** project or group
CI/CD variables. They are available only in trusted contexts that can receive
protected variables.

Required release-gating variables are:

- `GITLAB_INTEGRATION_PROJECT`: dedicated disposable project path or ID.
- `GITLAB_INTEGRATION_DISPOSABLE_TOKEN`: API token reserved for the disposable
  mutation suite.
- `GITLAB_INTEGRATION_DISPOSABLE=true`: explicit guard preventing accidental
  mutation of an ordinary project.

Optional variables are:

- `GITLAB_INTEGRATION_READ_PATH`: readable fixture path; defaults to
  `README.md`.
- `GITLAB_INTEGRATION_ENABLE_MR=true`: enables merge-request and discussion
  coverage when the fixture permits it.
- `GITLAB_INTEGRATION_ARTIFACT_JOB_ID`: known small artifact job ID for bounded
  artifact retrieval.
- `GITLAB_INTEGRATION_TARGET_BRANCH`: target ref; otherwise the project default
  branch is used.

`GITLAB_INTEGRATION_TOKEN` belongs to the separate read-only
`npm run test:integration` smoke suite; it is not a substitute for the
protected disposable token used by release gating.

Protected variables must never be exposed to ordinary or fork merge-request
pipelines. The disposable integration job is deliberately excluded from MR
pipelines.

### Scheduling

Configure a protected scheduled pipeline for recurring validation:

1. Navigate to **CI/CD → Schedules** in the GitLab project.
2. Create a schedule targeting `main` or the default branch.
3. Choose an appropriate interval, such as daily or weekly.
4. Ensure the target ref and pipeline context can receive the protected
   integration variables.

### Trusted pipeline contexts

The `integration_disposable` job is intended for:

- scheduled pipelines (`schedule`) for recurring validation;
- trusted manual/web pipelines (`web`) for ad-hoc runs; and
- tag pushes (`push` with `CI_COMMIT_TAG`) for release-candidate gating.

It is never triggered by merge-request events.

### CI release-gate behavior

Release artifact publication (`release_artifacts`) depends on
`integration_disposable`.

When disposable integration variables are configured, the suite runs on the
tag push and must succeed before release artifacts can be published. When the
required variables are missing, the tag job is still materialized and fails
closed with an explicit prerequisite diagnostic. Publication therefore cannot
bypass the protected integration gate.

Project maintainers must configure the disposable fixture variables before tag
releases can succeed.

### Merge-request pipeline behavior

Merge-request pipelines do **not** run the disposable integration suite. This
is deliberate: the protected fixture token must never be exposed to untrusted
merge-request code.

MR pipelines continue to run the normal syntax, lint, dependency, unit,
coverage, security, build, smoke, adapter, and release-candidate validation
jobs.

### Capability-aware results

The disposable suite records each capability as:

- `passed` when it executed successfully;
- `skipped` when optional fixture configuration was intentionally absent;
- `failed` when an executed contract assertion failed; or
- `unsupported` when the target GitLab instance does not expose the requested
  capability, for example because it is tier-gated.

If optional MR or artifact configuration is explicitly supplied, that
capability becomes required and its failure fails the suite. If the optional
configuration is absent, the capability is recorded as skipped rather than
silently omitted.

### Sanitized report artifact

The suite writes bounded JSON to `integration/integration-report.json`. The
report includes schema/run identifiers, the source commit when available,
timestamps, overall status, per-capability results, cleanup outcomes, and
coverage flags.

It never includes access tokens, CI variable values, request/response payloads,
or private project data. Error messages redact bearer tokens, GitLab PAT
patterns, and long hexadecimal strings. The report is bounded to 64 KB and
marks oversized output as truncated.

### Cleanup and recovery

Resources created by the disposable suite are cleaned up in a `finally` block.
Cleanup outcomes are recorded in the report. A cleanup failure is visible but
does not overwrite an otherwise successful contract-validation result.

If cleanup leaves resources behind:

1. Close merge requests matching `Draft: disposable MCP integration *`.
2. Close issues matching `Disposable MCP integration *`.
3. Delete branches matching `mcp/integration-*`.
4. Use the report run ID to identify the exact orphaned resources.

### Local execution

For an explicitly dedicated local fixture:

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"
$env:GITLAB_INTEGRATION_PROJECT = "group/disposable-fixture"
$env:GITLAB_INTEGRATION_DISPOSABLE_TOKEN = "<api-token>"
$env:GITLAB_INTEGRATION_DISPOSABLE = "true"
npm.cmd run test:integration:disposable
```

The suite skips with a clear message when required variables are absent and
fails on contract regressions when they are supplied. A sanitized
`integration/integration-report.json` is written on completion.
