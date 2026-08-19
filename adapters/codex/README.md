# Codex adapter

Codex keeps the repository's established `.codex-plugin/plugin.json`,
`.app.json`, assets, and shared Skills as compatibility surfaces.

`preload.mjs` is the runtime adapter. It reads the Codex manifest and publishes
its existing `name` and `version` through the harness-neutral
`shared/distribution-metadata.mjs` seam before the canonical MCP bundle starts.

`distribution.mjs` is the Codex build/release contract. It owns the artifact
name, compatibility-surface paths, canonical stdio launch shape, and
Codex-specific rendering rules consumed by metadata generation and release
validation. Root Codex files therefore remain compatible without becoming
repository-wide architecture.

The adapter does not import `server/` code and contains no GitLab behavior.
`.mcp.json` wires the preloader to the generated canonical bundle, while the
Skills directory remains the shared canonical source.

See `docs/ADAPTERS.md` for the adapter contract new harness integrations should
follow.
