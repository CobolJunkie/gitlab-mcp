# Privacy policy

Last updated: 2026-09-10

GitLab MCP is open-source software that runs in the environment selected by its
operator. The maintainer does not operate a hosted service and does not receive
GitLab credentials, repository content, prompts, tool results, or OpenTelemetry
exports through GitLab MCP.

The canonical MCP server sends requests to the configured GitLab instance and,
in HTTP mode, to the OAuth endpoints advertised by that instance. OpenTelemetry
is disabled by default. When an operator explicitly sets `MCP_OTEL_ENABLED=true`
and configures both trace and metric OTLP endpoints, stdio and HTTP deployments
may also send privacy-filtered traces and metrics to that operator-selected OTLP
collector. If telemetry is disabled or either required signal endpoint is
missing, GitLab MCP does not construct telemetry exporters or add telemetry
network activity. The telemetry allowlist and excluded data classes are
documented in [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

The included HTTP server keeps short-lived, bounded in-memory authentication and
rate-limit state; it does not persist tokens or request payloads. Operators
control any infrastructure logs and telemetry collectors and must configure them
with retention and access controls appropriate for their environment.

GitLab, the selected local harness (such as Codex, Claude Code, Cline, or Pi),
ChatGPT for HTTP connector use, reverse proxies, OpenTelemetry collectors, and
deployment providers may process data under their own policies when selected by
the operator. Operators are responsible for selecting appropriate GitLab
permissions, telemetry destinations, retention settings, deployment regions, and
access controls.

## CI pipeline visibility

This project's source code is publicly visible. CI pipeline logs and artifacts
are **not** intended to be public. The GitLab project setting `public_jobs`
should be `false` so that job traces remain accessible only to project members.

CI scripts redact private infrastructure addresses (RFC-1918 IPs, internal
hostnames) from tool output as a defence-in-depth measure, but the primary
control is restricting unauthenticated access to job logs.

Operators who fork this repository should ensure `public_jobs` is set to
`false` in their GitLab project settings to prevent CI traces from exposing
internal service topology.

Privacy questions may be filed as a
[GitLab issue](https://gitlab.villainmindset.org/CobolJunkie/gitlab-codex-plugin/-/issues).
Security-sensitive matters must follow [SECURITY.md](SECURITY.md).
