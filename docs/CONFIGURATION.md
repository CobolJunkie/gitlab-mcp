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

`MCP_PUBLIC_URL` rejects embedded credentials, queries, fragments, and paths
that do not end in `/mcp`.

## Authentication and access mode

Authentication and exposure are controlled by:

- `MCP_READ_ONLY=false` by default. Setting it to `true` registers only
  read-only tools and advertises GitLab `read_api` instead of `api`.
- `ALLOW_SERVER_TOKEN_HTTP=false` by default. Setting it to `true` allows
  `GITLAB_TOKEN` in HTTP mode only for loopback private testing; shared/public
  deployments reject it.
- `MCP_TOKEN_CACHE_MAX_ENTRIES=256` bounds validated bearer identities retained
  in the 60-second TTL/LRU cache.
- `MCP_AUTH_FAILURE_LIMIT=20` bounds rejected tokens per directly connected
  address and window.
- `MCP_AUTH_FAILURE_WINDOW_MS=60000` sets that authentication-failure window.
- `MCP_AUTH_FAILURE_MAX_ENTRIES=1024` hard-bounds authentication-failure
  tracking state.

Bearer tokens are validated against the configured GitLab `/api/v4/user`
endpoint. The cache key uses a one-way token digest and does not retain the raw
token as the key.

## Request limits

Request concurrency and body size use:

- `MCP_MAX_REQUEST_BYTES=8388608`, with an allowed range of 65,536 through
  26,214,400 bytes.
- `MCP_MAX_CONCURRENT_REQUESTS=32`, which must be a positive integer.
- `MCP_MAX_CONCURRENT_REQUESTS_PER_IDENTITY=4`, which must also be a positive
  integer.

Configure the TLS reverse proxy with request, connection, and client-IP limits
that complement these application bounds. Its request-body limit must be at
least `MCP_MAX_REQUEST_BYTES`.

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

Do not set a shared `GITLAB_TOKEN` in this profile. Complete the OAuth and
reverse-proxy steps in [CHATGPT_DEPLOYMENT.md](CHATGPT_DEPLOYMENT.md).

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
