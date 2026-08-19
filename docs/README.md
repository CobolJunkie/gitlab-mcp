# GitLab MCP documentation

Choose the shortest path for what you are trying to do. GitLab MCP has one
canonical MCP core and shared Agent Skills; Codex, Claude Code, Cline, and Pi
are supported harness distributions of that same product.

## Use GitLab MCP

- [User guide](USER_GUIDE.md): installation expectations, authentication,
  first-run checks, common workflows, safe usage, and upgrades.
- [Codex adapter guide](../adapters/codex/README.md): established root
  compatibility files, preload behavior, and the Codex distribution contract.
- [Claude Code adapter guide](../adapters/claude/README.md): native plugin
  packaging, session-local loading, canonical Skills, checksums, and validation.
- [Cline adapter guide](../adapters/cline/README.md): packaged MCP installation,
  IDE/CLI configuration, Agent Skills installation, checksums, and validation.
- [Pi adapter guide](../adapters/pi/README.md): Pi package installation, MCP
  bridge behavior, canonical Skills, runtime dependency handling, and validation.
- [Task cookbook](TASK_COOKBOOK.md): ready-to-adapt prompts for projects,
  issues, merge requests, reviews, pipelines, releases, and schedules.
- [Configuration reference](CONFIGURATION.md): every supported environment
  variable and transport mode.
- [Troubleshooting](TROUBLESHOOTING.md): symptoms, causes, diagnostics, and
  recovery steps.
- [Compatibility policy](COMPATIBILITY.md): supported Node, GitLab, harness,
  artifact, versioning, upgrade, and rollback expectations.
- [Support](../SUPPORT.md), [privacy](../PRIVACY.md),
  [terms](../TERMS.md), and [security reporting](../SECURITY.md).

## Develop or operate GitLab MCP

- [Developer guide](DEVELOPER_GUIDE.md): architecture, source layout, tool
  lifecycle, security boundaries, tests, and CI.
- [Observability contract](OBSERVABILITY.md): privacy-safe core HTTP/tool event
  schema, cardinality rules, and the OpenTelemetry integration boundary.
- [Surface benchmarking](BENCHMARKING.md): canonical MCP surface auditing,
  schema-size accounting, pre-toolset baseline provenance, and drift review.
- [Harness adapter contract](ADAPTERS.md): ownership, dependency direction, the
  current Codex, Claude Code, Cline, and Pi adapters, and requirements for
  future harness distributions.
- [Generalisation audit](GENERALISATION_AUDIT.md): GEN-08 product identity,
  compatibility decisions, cross-harness audit evidence, install/use flows,
  release-candidate gate, and post-generalisation follow-up status.
- [Contributing](../CONTRIBUTING.md): branch, commit, verification, and merge
  request workflow.
- [Tool routing reference](../skills/gitlab/references/tool-routing.md): all
  registered tools grouped by workflow and mutation risk.
- [GitHub parity map](PARITY.md): the compatibility inventory used to prevent
  accidental feature regression.
- [ChatGPT deployment](CHATGPT_DEPLOYMENT.md): HTTPS, OAuth, reverse proxy,
  readiness, and connector registration.
- [Release process](RELEASING.md) and
  [publication checklist](PUBLICATION_CHECKLIST.md).
- [Changelog](../CHANGELOG.md).

## Recommended reading order

New users should read the user guide and the adapter guide matching their
harness. Self-managed operators should add the configuration and troubleshooting
references. Contributors should start with the developer and contributing
guides, then read the adapter, tool-routing, and contract references for the
workflow they are changing. Maintainers closing or extending the generalisation
milestone should also read the generalisation audit before changing product
identity or adapter boundaries.
