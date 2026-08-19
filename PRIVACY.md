# Privacy policy

Last updated: 2026-08-16

GitLab MCP is open-source software that runs in the environment selected by its
operator. The maintainer does not operate a hosted service and does not receive
GitLab credentials, repository content, prompts, or tool results through GitLab
MCP.

The canonical MCP server sends requests only to the configured GitLab instance
and, in HTTP mode, to the OAuth endpoints advertised by that instance. Local
stdio mode stores no telemetry. The included HTTP server keeps short-lived,
bounded in-memory authentication and rate-limit state; it does not persist
tokens or request payloads. Operators control any infrastructure logs and must
configure them not to record authorization headers or private content.

GitLab, the selected local harness (such as Codex, Claude Code, Cline, or Pi),
ChatGPT for HTTP connector use, reverse proxies, and deployment providers may
process data under their own policies. Operators are responsible for selecting
appropriate GitLab permissions, retention settings, deployment regions, and
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
[GitLab issue](https://github.com/example-org/gitlab-mcp/-/issues).
Security-sensitive matters must follow [SECURITY.md](SECURITY.md).
