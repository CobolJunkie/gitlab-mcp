# Harness adapter contract

Harness adapters are thin distribution edges around the canonical GitLab MCP
core. They may own launch configuration, manifest rendering, package naming,
and harness-specific validation, but they must not implement GitLab behavior.

Codex, Claude Code, Cline, and Pi are peer supported distributions. An adapter
may own compatibility history unique to its harness, but no harness has
architectural authority over another or over the canonical core.

## Ownership model

Shared product metadata lives in `distribution.json`. The MCP implementation,
transports, tool contracts, safety controls, sanitisation, and GitLab client
remain under `server/src/`. Shared Agent Skills remain under `skills/`.

An adapter owns only the harness-specific information that cannot be expressed
by those shared sources. Build and release tooling may consume adapter-owned
packaging contracts. The MCP core and shared seams must never import an
adapter.

```text
distribution.json ─┐
shared Skills ─────┼─> build/release tooling ─> harness distribution
MCP bundle ────────┤
adapter contract ──┘
```

## Codex adapter

Codex owns the repository's established Codex compatibility surfaces while
remaining a peer of the other supported harness distributions.

- `adapters/codex/preload.mjs` is the runtime adapter. It reads the Codex
  manifest and publishes distribution identity through
  `shared/distribution-metadata.mjs` before the canonical MCP bundle starts.
- `adapters/codex/distribution.mjs` is the build/release contract. It owns the
  Codex artifact name, compatibility-surface paths, canonical stdio launch
  shape, and Codex-specific manifest/configuration rendering.
- `.codex-plugin/plugin.json`, `.mcp.json`, and `.app.json` remain at their
  established root paths for Codex compatibility. They are generated or
  validated from canonical metadata plus the Codex adapter contract; they are
  not MCP-core configuration.
- The canonical Skills directory and MCP bundle are referenced, not forked or
  reimplemented for Codex.

Release validation consumes the same Codex contract used by metadata
generation. It verifies the extracted manifest, app entry, adapter preload,
shared Skills, MCP launch configuration, deterministic artifact, and bundled
stdio handshake.

## Claude Code adapter

Claude Code is a native plugin consumer of the same canonical MCP bundle and
shared Agent Skills.

- `adapters/claude/distribution.mjs` owns the Claude artifact name, source and
  packaged manifest/configuration paths, native plugin manifest rendering, and
  canonical stdio launch shape.
- Generated source metadata lives under `adapters/claude/`; the materialized
  package maps it to Claude's required plugin-root layout with
  `.claude-plugin/plugin.json`, `.mcp.json`, and `skills/` at the plugin root.
- The generated MCP configuration uses `${CLAUDE_PLUGIN_ROOT}` to reference the
  bundled canonical server, so marketplace cache and session-local
  `--plugin-dir` locations remain relocatable.
- Credentials remain runtime environment configuration. No GitLab URL or token
  is generated into the plugin manifest or MCP configuration.
- `scripts/validate-claude-adapter.mjs` materializes the plugin, validates
  canonical metadata and launch configuration, compares the packaged MCP tool
  inventory with the canonical bundle, verifies runtime provenance, and proves
  the archive is byte-for-byte reproducible with a matching SHA-256 sidecar.

Claude Code needs no runtime preload or protocol bridge for this distribution.
The adapter therefore contains no GitLab implementation logic and introduces no
Claude dependency into `server/src/`.

## Cline adapter

Cline is another concrete consumer of the same adapter boundary and uses its
native stdio MCP and Agent Skills surfaces rather than a protocol bridge.

- `adapters/cline/distribution.mjs` owns the Cline artifact name, generated MCP
  settings template, package-content contract, and documented Skill locations.
- The generated MCP settings point directly at the canonical bundle and require
  an explicit absolute installation root. Credentials remain runtime
  environment configuration and are not generated into distributable metadata.
- The packaged `gitlab-cline-mcp` distribution contains the generated settings,
  canonical MCP bundle, canonical Skills, shared distribution metadata, adapter
  documentation, and license. Contributor-local `.clinerules` configuration is
  not repository product configuration and is explicitly excluded if present.
- `scripts/validate-cline-adapter.mjs` validates the materialized package,
  canonical tool inventory, Skill metadata, runtime provenance, stdio handshake,
  archive contents, byte-for-byte reproducibility, and the dedicated SHA-256
  sidecar.

## Pi adapter

Pi requires a small runtime bridge because its extension API registers tools
inside Pi rather than consuming the MCP server as a native configured tool
provider.

- `adapters/pi/distribution.mjs` owns the Pi artifact name, generated package
  manifest, package-content contract, and the runtime MCP SDK dependency copied
  from the canonical root package metadata.
- `adapters/pi/extensions/gitlab-mcp.mjs` starts the packaged canonical MCP
  bundle over stdio, connects an MCP client, discovers the complete paginated
  tool inventory, registers translated tool definitions with Pi, and closes the
  MCP client on Pi session shutdown.
- `adapters/pi/mcp-bridge.mjs` is protocol translation only. Tool names,
  descriptions, input schemas, calls, structured results, annotations, and
  metadata are preserved as Pi permits. Explicit MCP read-only annotations may
  use Pi parallel execution; everything else remains sequential.
- Unsupported MCP result content is represented as text rather than silently
  discarded. MCP error results become Pi execution errors.
- The package contains the canonical MCP bundle and canonical Skills instead of
  forking either source. GitLab API behavior, sanitisation, and mutation policy
  remain in the core.
- `scripts/validate-pi-adapter.mjs` materializes the package, validates its
  manifest and deterministic archive/checksum, launches the actual packaged Pi
  extension against the canonical stdio server, verifies the complete tool
  inventory and runtime provenance, and exercises shutdown cleanup.

The materialized Pi archive declares `@modelcontextprotocol/sdk` as a runtime
dependency. npm/Git Pi package installation resolves that dependency normally;
a directly extracted local archive must install its production dependency before
Pi loads it.

Release validation recreates and smoke-tests the Claude Code, Cline, and Pi
packages independently of the Codex archive while continuing to reuse the same
canonical core and Skills. No harness-specific behavior is introduced into
`server/src/`.

## Adding another harness

A new harness adapter should follow the same dependency direction without
copying Codex, Claude Code, Cline, or Pi details that are not required by that
harness:

1. Add `adapters/<harness>/` only for harness-specific launch, packaging, or
   protocol bridging.
2. Reuse `distribution.json`, the canonical MCP bundle, and shared Skills.
3. Keep GitLab API, tools, safety, sanitisation, and response behavior in the
   core.
4. Give build/release tooling an explicit harness-owned distribution contract
   rather than scattering harness paths through repository-wide scripts.
5. Preserve external IDs or harness-only metadata unless the canonical model
   explicitly owns those fields.
6. Add focused manifest/package/launch validation and a packaged MCP handshake
   where the harness supports one.
7. Run dependency-cruiser and the full existing CI/security/release gates.

Adapters must not import `server/` internals or another adapter. If a capability
is genuinely shared by several harnesses, expose it through an inward-facing
shared seam instead of creating adapter-to-adapter dependencies.

## Core-only concerns

OBS-01 core observability events, OBS-02 OpenTelemetry SDK/exporter integration,
and response/token optimisation are core concerns and remain outside the adapter
contract. OBS-02 keeps telemetry bootstrap and exporters in the harness-neutral
core; semantic response/token optimisation remains follow-up core work. Adding
a harness must not create a private copy of any of these concerns.
