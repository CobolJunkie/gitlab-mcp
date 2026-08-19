# Changelog

All notable changes are documented here. This project follows Semantic
Versioning and keeps an Unreleased section until a tag is published.

## Unreleased

### Added

- Added a deterministic BENCH-01 canonical surface audit and frozen pre-toolset
  baseline for the full and read-only MCP surfaces, including schema-byte/token
  estimates, safety classifications, stable registration-family summaries,
  per-tool diagnostics, fingerprints, and provenance-separated external
  reference measurements.
- Added a privacy-safe, provider-neutral core observability contract for bounded
  HTTP and MCP tool completion events. Tool telemetry is emitted once from the
  shared registrar so every harness inherits the same event/privacy behavior,
  while OpenTelemetry SDK/exporter wiring remains a separate follow-up.
- Added a Pi package distribution with a thin MCP client extension that reuses
  the canonical MCP bundle and shared Skills, preserves MCP tool contracts as
  Pi permits, performs lifecycle cleanup, and ships deterministic package
  artifacts with focused CI validation and installation guidance.
- Added a native Claude Code plugin distribution that reuses the canonical MCP
  core and shared Skills, with generated plugin/MCP metadata, relocatable
  `${CLAUDE_PLUGIN_ROOT}` launch configuration, deterministic packaged artifacts,
  checksums, focused CI validation, and installation guidance.
- Added a dedicated Cline MCP + Agent Skills distribution that reuses the
  canonical MCP core and shared Skills, with deterministic packaged artifacts,
  checksums, focused CI validation, and Cline IDE/CLI installation guidance.
- Added a GEN-08 generalisation audit that records the supported four-harness
  baseline, compatibility seams, architecture-boundary evidence, install/use
  flows, release-candidate gate, and deferred post-generalisation concerns.

### Changed

- Introduced a harness-neutral MCP core boundary with thin harness adapters and
  harness-neutral distribution metadata. Generic stdio/HTTP startup now keeps
  neutral core provenance, while Codex launch configuration explicitly loads
  its adapter metadata. The GitLab API client now identifies as
  `gitlab-mcp/<core-version>`, and release artifacts generate the canonical MCP
  bundle instead of committing it as source.
- Added `distribution.json` as the canonical build-time source for shared
  distribution identity, base version, description, license, MCP bundle path,
  and Skills location. Deterministic generation/check tooling now blocks drift
  across generated metadata and the Codex manifest/configuration, validates the
  referenced Skills directory, and preserves independent MCP core version
  ownership.
- Formalized Codex as the first concrete harness adapter. Codex-specific
  artifact naming, compatibility paths, launch configuration, and manifest
  rendering now live in `adapters/codex/distribution.mjs`; generation and
  release validation consume that same contract while preserving the
  established root Codex files, shared Skills, and canonical MCP bundle.
- Completed the product generalisation to **GitLab MCP**. Codex, Claude Code,
  Cline, and Pi are now documented and released as peer supported distributions
  of one canonical GitLab MCP core and Agent Skills set rather than as secondary
  integrations around a Codex-only product.
- Preserved the neutral `gitlab` MCP/distribution identifier, established root
  Codex configuration paths, `gitlab-codex-plugin` Codex artifact, and existing
  repository slug as compatibility surfaces. Existing Codex users therefore do
  not require a configuration-path migration for GEN-08.
- Aligned README, documentation index, configuration, compatibility, developer,
  publication, and release guidance with the multi-harness product model while
  reserving OpenTelemetry SDK/exporter integration and semantic response/token
  optimisation for centralized core follow-up work.

## 0.1.1

### Added

- Read-only environment and deployment inspection tools: `list_environments`,
  `get_environment`, `list_deployments`, `get_deployment`, and
  `get_deployment_approval_status`.
- Protected-tag governance tools: `list_protected_tags`,
  `get_protected_tag`, `protect_tag`, and `unprotect_tag`.
- Read-only project webhook diagnostic tools: `list_project_webhooks`,
  `get_project_webhook`, `list_project_webhook_events`, and
  `get_project_webhook_event`. Secret tokens and custom-header secrets are
  never exposed; delivery response bodies are bounded.
- Merge-request suggestion application tools: `apply_merge_request_suggestion`
  and `batch_apply_merge_request_suggestions`.
- Disposable-project MCP integration suite gated on release publication.
- Bounded sanitized integration-report artifact with per-capability tracking.

### Changed

- Hardened HTTP authentication rate limiting: per-token failure isolation
  avoids proxy-wide lockout behind shared reverse proxies.
- Bounded slow MCP request body reads with explicit per-chunk read deadlines;
  timed-out requests return HTTP 408 and release concurrency slots.
- Tightened readiness probe to enforce an exact 4 096-byte ceiling on
  upstream responses.
- GitLab PAT tokens (`glpat-`) now authenticate via `PRIVATE-TOKEN` header;
  OAuth tokens continue to use `Bearer`.
- Single-source `meta` object provides consistent request metadata across all
  `GitLabApiError` construction paths.
- Fixed webhook event API routes to use documented GitLab
  `GET /projects/:id/hooks/:hook_id/events` endpoint with bounded pagination.
- Raised minimum supported Node.js runtime to 22; Node.js 20 is end-of-life
  and no longer receives upstream security fixes. CI now tests against
  `node:22-alpine` and `node:24-alpine`.

## 0.1.0

### Added

- GitLab-native runner, CI lint, governance, tag, release, and pipeline
  schedule operations.
- Project capability discovery and bounded/redacted operator responses.
- Release-readiness policies, marketplace artwork, deterministic source
  archives, checksums, and CycloneDX SBOM generation.
- A user guide, task cookbook, configuration and troubleshooting references,
  developer architecture guide, and automated documentation-link validation.
- Pipeline creation and diagnosis (latest-by-ref, test reports, and bridge
  traversal), release/tag lifecycle operations, release asset-link CRUD, and
  guarded protected-branch and approval-rule mutations.
- A credential-gated disposable-project MCP integration suite that covers
  representative reads, issue lifecycle, branch creation, safe and destructive
  commit flows, optional merge-request discussions, pagination, capability
  discovery, pipeline/job lookup, optional artifact retrieval, and cleanup.
- Extracted release-archive validation that creates a CycloneDX SBOM and
  SHA256SUMS, then launches the bundled stdio server without `node_modules`.

### Changed

- Expanded the MCP surface to 120 explicitly classified and route-tested tools.
- Split commit mutation by risk: `create_commit` now supports only
  non-destructive file actions, while destructive deletes and forced updates
  require `create_destructive_commit` with concurrency-safety fields.
- Hardened HTTP authentication, concurrency, response limits, readiness, and
  deployment validation; startup failures now surface through a readiness
  promise and shutdown drains with a bounded timeout.
- Restricted the insecure GitLab HTTP override to non-production
  local/private-development hosts and added a regression check for the
  presentation truncation marker.
