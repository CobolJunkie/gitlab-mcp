# Dependency Policy

This document defines the architectural dependency rules enforced by dependency-cruiser.

## Architecture

```text
server/src/   harness-neutral GitLab MCP core
shared/       small stable seams usable by core and adapters
skills/       shared Agent Skills
adapters/     thin harness-specific launch/packaging integrations
scripts/      build, validation, release, and integration tooling
```

The core is the product. Adapters are distribution edges. Build and release
scripts may consume adapter-owned packaging contracts; that outward packaging
dependency must never be reversed into the MCP core or shared seams.

## Enforced rules

### No circular dependencies

Circular imports are errors throughout the analysed production graph.

### No unresolved imports

Unresolved imports are errors so packaging and refactors fail in CI rather than at runtime.

### Production cannot depend on tests

`server/src/`, `scripts/`, `skills/`, `shared/`, and `adapters/` must not import test code or dependency-boundary fixtures.

### Core cannot depend on adapters

`server/` must never import `adapters/`. Harness knowledge therefore cannot leak into GitLab implementation or MCP contracts.

### Shared code and skills cannot depend on adapters

`shared/` and `skills/` are reusable inward-facing surfaces. They cannot import harness-specific implementation.

### Adapters cannot depend on core internals

Adapters may use stable shared seams but cannot import `server/` internals. GitLab behavior stays central and adapters remain thin.

### Platform internals cannot depend on platform composition

`server/src/tools/platform-tools.mjs` is the stable platform registration boundary and composes identity/discovery/search, label lifecycle, and milestone lifecycle modules under `server/src/tools/platform/`. Those internals must not import upward through the registration façade; this keeps lifecycle safety and search validation owned below the composition seam while preserving one canonical platform entry point.

### Repository internals cannot depend on repository composition

`server/src/tools/repository-tools.mjs` is the stable registration boundary and may compose workflow modules under `server/src/tools/repository/`. Those internals must not import back into the registration layer. Sibling repository internals may still collaborate when the dependency is cohesive, such as the bounded commit-response helper used by guarded commit workflows.

### Merge-request internals cannot depend on merge-request composition

`server/src/tools/merge-request-tools.mjs` is the stable registration boundary and may compose workflow modules under `server/src/tools/merge-request/`. Lifecycle, review, collaboration, and suggestion internals must not import upward through that registration layer.

### HTTP internals cannot depend on the public facade

`server/src/http.mjs` is a compatibility facade over `server/src/http/`. Internal HTTP modules implement that public boundary and must never import back through it.

### HTTP foundations cannot depend on app/lifecycle composition

`policy.mjs`, `admission.mjs`, `auth.mjs`, and `readiness.mjs` are lower-level HTTP policy/security/dependency modules. They may be consumed by `app.mjs` and `lifecycle.mjs`, but they must not import those composition layers. This keeps request admission, authentication state, and deployment policy independently auditable.

### Adapters are isolated from one another

For every directory under `adapters/`, the configuration generates a rule that rejects imports into a different adapter while allowing imports within the same adapter. Adding a new adapter automatically adds its isolation rule.

## CI

`npm run deps:check` analyses `server/src`, `scripts`, `skills`, `shared`, and `adapters`. The blocking `dependency_boundaries` CI job runs this on merge-request and main pipelines.

Fixture tests under `test-dependency-boundaries/` prove that core-to-adapter, shared-to-adapter, cross-adapter, and the protected internal upward dependencies are rejected while permitted directions remain available.

## Extending internal dependency rules

Add an internal rule only after a stable ownership/composition boundary exists in production and a reverse dependency would represent a real architectural regression. Prefer a directional rule that names the protected seam over broad sibling-module deny-lists. Every new rule must use the shared rule factory, map equivalent production and fixture paths, include a deterministic negative fixture, and document why the direction matters. Do not add exceptions merely to make an intended violation pass; change the architecture or narrow an over-broad rule instead.

## Adding a harness adapter

1. Create `adapters/<harness>/` only when the harness needs integration code or packaging.
2. Prefer standard MCP configuration over custom adapter logic.
3. Give build/release tooling an explicit adapter-owned distribution contract instead of scattering harness paths through repository-wide scripts.
4. Use `shared/` public seams; do not import `server/` internals.
5. Never duplicate GitLab API, tool, safety, sanitisation, transport, observability, or response logic.
6. Reuse canonical Skills and the MCP bundle rather than creating harness-specific copies.
7. Add focused package/manifest/launch validation and run `npm run deps:check`, the full test suite, build checks, smoke tests, and release validation.

See `docs/ADR-001-harness-neutral-core.md` for the architecture decision and
`docs/ADAPTERS.md` for the reference adapter contract and core-only
observability/token-optimisation placement.
