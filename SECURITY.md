# Security policy

## Supported versions

Security fixes are provided for the latest published release. During the
pre-1.0 period, users should upgrade to the newest patch release because older
minor versions may not receive backports.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue. Create a
[confidential GitLab issue](https://gitlab.villainmindset.org/CobolJunkie/gitlab-codex-plugin/-/issues/new?issue%5Bconfidential%5D=true)
with:

- the affected version or commit;
- reproduction steps and expected impact;
- whether credentials or private GitLab data may be exposed; and
- a safe contact method for follow-up.

The maintainer will acknowledge a report within five business days, provide a
status update after triage, and coordinate disclosure after a fix is available.
Please allow 90 days for remediation before public disclosure unless an
actively exploited issue requires faster coordination.

## Security boundaries

GitLab credentials are supplied at runtime and must not be committed to the
repository or included in any GitLab MCP distribution or release artifact. Use
the narrowest GitLab scope and role that supports the intended operations.
Public HTTP deployments must use HTTPS, OAuth, an explicit host allowlist, and
the deployment controls documented in
[docs/CHATGPT_DEPLOYMENT.md](docs/CHATGPT_DEPLOYMENT.md).
