# Harness adapters

The GitLab MCP server in `server/src/` is the canonical product core. Harness integrations live under `adapters/` and may supply packaging or launch-time distribution metadata, but they must not duplicate GitLab API, tool, safety, sanitisation, transport, or response logic.

Dependency direction is inward:

```text
harness adapter -> shared public seam -> MCP core
```

Rules enforced by dependency-cruiser:

- core and shared code never import an adapter;
- adapters never import `server/` internals;
- one adapter never imports another adapter;
- imports within one adapter are allowed.

## Canonical distribution metadata

`distribution.json` is the build-time source of truth for fields shared by every
distribution: the neutral distribution name, distribution base version,
description, license, canonical MCP bundle path, and shared Skills directory.
The bundle path is intentionally constrained to one `.cjs` file directly under
`server/dist/`; build, CI artifacts, smoke tests, Docker packaging, and release
validation all treat that directory as the generated bundle boundary while the
canonical metadata owns the filename.

Run `npm run adapters:generate` after changing shared distribution metadata.
The generator synchronizes the package metadata and package-lock root version,
then delegates harness-owned files to their adapter contracts. The Codex adapter
preserves harness-specific or externally assigned fields such as `+codex.*`
version build metadata, author/interface metadata, unrelated MCP server
properties such as environment variables, and the app ID. It canonicalizes the
Codex MCP server identity, command, preload, bundle argument, stdio launch shape,
and app identity key. The Cline adapter generates a path-explicit MCP settings
template from the same canonical bundle identity. The Claude Code adapter
generates its native `.claude-plugin/plugin.json` and `.mcp.json`, using
`${CLAUDE_PLUGIN_ROOT}` so packaged paths remain relocatable. The Pi adapter
generates a Pi package manifest whose runtime MCP SDK version follows the root
package and packages a thin stdio bridge. Cline, Claude Code, and Pi all reuse
the shared Skills under the canonical `skills/` tree. Tests consume or validate
generated metadata; test source files are never generator outputs.

`SERVER_VERSION` remains owned independently by the harness-neutral MCP core in
`server/src/version.mjs`. A distribution-only release therefore does not imply a
core-version bump; update the core version only when the core runtime itself
changes.

`npm run adapters:check` is a non-mutating drift and resource check used by CI
and release validation. It rejects generated metadata drift and requires the
canonical Skills path to resolve to an existing directory inside the repository.
Harness-specific schemas should extend the generator only for fields that are
genuinely shared; do not force harness-only metadata into `distribution.json`.

## Current adapters

- `codex/` preserves the existing Codex plugin compatibility surfaces while reusing the canonical core and Skills.
- `claude/` packages the canonical MCP bundle and shared Skills as a native Claude Code plugin with relocatable `${CLAUDE_PLUGIN_ROOT}` launch configuration.
- `cline/` uses Cline's native stdio MCP and Agent Skills surfaces. Its repository contributor `.clinerules` remains separate from distributable product configuration.
- `pi/` packages the canonical bundle and shared Skills with a generic MCP client extension that translates MCP tool discovery/calls into Pi tool registrations without reimplementing GitLab behavior.

All supported adapters are peers at the product boundary. Compatibility history
may differ between them, but no adapter owns or outranks the canonical MCP core,
shared Agent Skills, security policy, or GitLab behavior.

To add another harness, create `adapters/<harness>/` and keep it thin. Prefer standard MCP configuration directly; add adapter code only where the harness needs packaging or launch-time bridging.
