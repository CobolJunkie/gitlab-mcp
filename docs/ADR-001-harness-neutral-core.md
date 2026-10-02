# ADR-001: Harness-neutral MCP core and adapter boundary

## Status

Accepted for GEN-01.

## Context

The GitLab MCP implementation was already largely reusable, but runtime provenance in `server/src/tools/runtime-tools.mjs` imported the Codex plugin manifest directly. That made a distribution concern part of the core and blocked a clean path to Claude Code, Cline, Pi, and other MCP harnesses.

GEN-01 requires the smallest coherent boundary without changing GitLab behavior or prematurely building adapters that do not yet exist.

## Decision

`server/src/` remains the single canonical implementation of GitLab client behavior, tools, safety controls, sanitisation, MCP contracts, and transports.

A small public seam, `shared/distribution-metadata.mjs`, carries optional `{ name, version }` distribution identity. The core can run without it, an embedding harness can pass `distributionMetadata` directly to `createGitLabMcpServer`, and launch-oriented adapters can set the same neutral metadata before startup.

The canonical `server/src/index.mjs` launcher validates the repository `distribution.json` through the shared canonical normalization contract and seeds that seam only when no harness adapter has already established distribution metadata. Bare canonical bundles and production HTTP deployments therefore report canonical distribution identity while adapter-owned launch metadata, such as the Codex preload, remains authoritative for that harness. `SERVER_VERSION` remains independently owned by the harness-neutral core.

The Codex adapter is a thin preloader under `adapters/codex/`. It owns discovery of `.codex-plugin/plugin.json`; the core never imports or discovers that manifest. The existing Codex manifest, app metadata, assets, skills, and version remain unchanged.

Dependency direction is:

```text
GitLab API <- MCP core <- shared seam <- harness adapter
```

Dependency-cruiser enforces that core/shared code cannot import adapters, adapters cannot import server internals, and adapters cannot import other adapters. Same-adapter imports remain valid so future integrations are not forced into a single file.

The canonical esbuild bundle is generated from source during build/release instead of committed. `check:bundle` dry-builds it and rejects Codex-specific implementation paths; release validation stages the generated bundle into the packaged archive and exercises the real Codex `.mcp.json` launch path.

## Consequences

- Existing Codex runtime provenance is preserved.
- Direct core embedding remains harness-neutral and still reports core version information; the canonical launcher additionally reports canonical distribution identity.
- New harnesses can integrate without duplicating GitLab behavior.
- The repository has one source of truth for the generated bundle.
- Adding a harness does not require changes to core implementation unless a genuinely shared MCP capability is missing.

## GEN-02 clarification

GEN-02 adds `distribution.json` as the canonical source for metadata genuinely
shared by distributions and uses deterministic tooling to synchronize
harness-facing manifests and configuration. This does not transfer ownership of
the harness-neutral core version to the distribution layer.

`server/src/version.mjs` remains the source of `SERVER_VERSION`. Distribution
and core versions may therefore diverge when a release changes only packaging,
manifest metadata, or an adapter. The core version is bumped independently when
the MCP core itself changes. Runtime provenance continues to expose both values
so this distinction remains observable.

## GEN-03 clarification

GEN-03 formalized Codex as the first concrete distribution-adapter contract
without moving Codex knowledge into the MCP core.
`adapters/codex/distribution.mjs` owns the Codex artifact name,
compatibility-surface paths, launch shape, and Codex-specific rendering rules.
Repository build/release tooling may consume that adapter-owned packaging
contract; `server/`, `shared/`, and other adapters may not.

The established root Codex files remain compatibility surfaces because their
locations are part of the existing distribution contract. They are generated
or validated from `distribution.json` plus the Codex adapter contract rather
than being treated as core configuration. Release validation consumes the same
contract and verifies the extracted Codex artifact before exercising its MCP
stdio launch path.

## GEN-08 clarification

Codex's earlier role as the first adapter migration does not give it product or
architectural precedence. Codex, Claude Code, Cline, and Pi are peer supported
distributions of the same canonical MCP core and shared Agent Skills. The Codex
adapter retains additional legacy compatibility surfaces only because existing
Codex installations already depend on them.

No supported adapter may own GitLab behavior, security/sanitisation policy,
shared Skills, cross-harness metadata authority, or another adapter's lifecycle.
The supported-harness registry and cross-harness release gate treat all four
harnesses as one product release set.

## GEN-01 deferred concerns

Observability belongs centrally in the core execution path rather than in
adapters. Future semantic response/token optimisation belongs after sanitisation
and before MCP presentation so every harness benefits consistently. Neither was
implemented by GEN-01.

## OBS-01 and OBS-02 follow-up

OBS-01 subsequently establishes the provider-neutral, privacy-safe core
observability event boundary described by this ADR's placement decision. OBS-02
adds the optional OpenTelemetry SDK/exporter integration on that same boundary,
including standard HTTP/Undici and process/runtime instrumentation, MCP operation
spans and metrics, and separate GenAI tool-execution telemetry. The
implementation remains core-owned; no adapter initializes exporters or owns
telemetry policy. Semantic response/token optimisation remains follow-up core
work.

## Non-goals

GEN-01 does not implement Claude Code, Cline, or Pi adapters; rename the project; change GitLab tool semantics; alter security policy; or introduce observability/token optimisation.
