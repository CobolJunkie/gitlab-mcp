# Compatibility policy

## Product and distribution identity

The product is **GitLab MCP**. The canonical MCP server and shared Agent Skills
are the product center; Codex, Claude Code, Cline, and Pi are supported harness
distributions around that center.

`distribution.json` keeps the neutral `gitlab` distribution/MCP identifier. It
is a stable machine-facing identifier, not a Codex product name. The supported
release artifact names remain harness-specific so users can tell which package
to install.

The existing repository slug `gitlab-codex-plugin`, Codex artifact
`gitlab-codex-plugin`, and root Codex `.codex-plugin/plugin.json`, `.mcp.json`,
and `.app.json` paths remain supported compatibility surfaces. GEN-08 does not
rename or deprecate them. Their continued existence does not make Codex the
architecture core, and other harnesses must not depend on those paths.

The repository root npm package is private build/development metadata and is not
a supported published harness artifact. Public compatibility commitments apply
to the harness artifacts and documented configuration/tool contracts rather
than that internal package name.

See [GENERALISATION_AUDIT.md](GENERALISATION_AUDIT.md) for the focused GEN-08
audit and migration rationale.

## Supported runtime

- Node.js 22 or newer; CI validates the core on Node.js 22 and Node.js 24.
- GitLab.com, GitLab Dedicated, and supported self-managed GitLab instances
  exposing REST API v4.

When a Node.js release line reaches end-of-life, the next minor release drops
support for it. Users should upgrade before the upstream EOL date.

The core repository, issue, merge-request, and CI operations target stable
GitLab REST APIs. Newer features such as pipeline inputs can require a newer
GitLab release. Use `get_gitlab_capabilities` with a project to distinguish
available, permission-gated, licensed, unconfigured, unsupported, and unknown
outcomes. Ambiguous responses are never treated as proof of support.

## Harness compatibility matrix

All supported harnesses consume the same canonical `distribution.json`, MCP
bundle, and Agent Skills. Harness adapters own only the packaging, launch, or
protocol details required by their client.

| Harness     | Artifact                 | MCP              | Skills    | CI host validation                                   |
| ----------- | ------------------------ | ---------------- | --------- | ---------------------------------------------------- |
| Codex       | `gitlab-codex-plugin`    | config + preload | canonical | package/config/preload/protocol; no Codex CLI binary |
| Claude Code | `gitlab-claude-code-mcp` | plugin config    | canonical | package/protocol; no Claude Code binary              |
| Cline       | `gitlab-cline-mcp`       | settings         | canonical | package/settings/protocol; no Cline binary           |
| Pi          | `gitlab-pi-mcp`          | bridge           | canonical | Pi `0.84.2` runtime and standalone binary            |

Codex keeps the established root `.mcp.json` and preload launch path. Its
focused `npm run validate:codex` check reuses the deterministic Codex release
package validator: it rebuilds the canonical bundle, proves archive and SBOM
reproducibility, verifies the published checksum, extracts and smokes the
package, and then validates repository-side canonical metadata, launch
configuration, tool inventory, runtime provenance, and the shared Skills
location. Repository CI does not launch a Codex CLI binary; this is
package/config/preload/protocol-level validation. The final cross-harness gate
independently verifies the exact tracked release tree plus the canonical
generated MCP bundle and shared Skills digests. The root Codex paths are
Codex-owned compatibility surfaces and are not a generic installation contract
for other harnesses.

Claude Code uses its native plugin `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`.
`npm run validate:claude` materializes the plugin and validates metadata,
package contents, the stdio handshake, tool inventory, shared Skills, and the
deterministic archive/checksum. Repository CI does not require the Claude Code
binary; the official strict plugin validator remains an additional client-side
check when available.

Cline uses a generated MCP settings template plus the canonical Skills.
`npm run validate:cline` validates package contents, settings, Skills, the stdio
handshake, tool inventory, and the deterministic archive/checksum. Repository CI
does not require a Cline binary; this is package/settings/protocol-level
validation. The template requires the user to replace its explicit absolute
installation-root placeholder.

Pi uses a thin extension/bridge around the canonical MCP server and declares the
canonical Skills in its package. `npm run validate:pi` covers package metadata,
bridge lifecycle, complete tool inventory, deterministic archive/checksum, and
shutdown cleanup. The dedicated CI adapter job additionally loads the packaged
extension through pinned Pi runtime version `0.84.2` and verifies the matching
standalone Pi binary. Tag pipelines rerun that strict compatibility job for the
exact tagged commit. Permanent publication is additionally serialized behind a
tag-only `release_gate` with normal stage ordering; the gate waits for every
earlier tag job and rejects a tagged SHA that is not contained in the default
branch. `release_artifacts` then depends on that gate and protected disposable
integration. A directly extracted local Pi package must install its declared
production MCP SDK dependency before Pi loads it.

CI keeps the core Node/security/test matrix singular. After the canonical bundle
is built, a dedicated `adapter` stage runs the four focused validators without
repeating SonarQube, SAST, dependency audit, coverage, or the Node compatibility
matrix per harness.

`npm run release:validate` then builds every supported archive and runs a final
cross-harness gate. That gate rejects a release unless all four archives are
present exactly once, their published SHA-256 checksums match, their packaged
`distribution.json` matches the canonical source, and their MCP bundle and
Skills digests match the canonical bundle and Skills tree byte-for-byte. It
writes `$RELEASE_OUTPUT_DIR/cross-harness-manifest.json` (default
`release/cross-harness-manifest.json`) plus a matching SHA-256 sidecar. The
manifest records compressed archive size and unpacked package size for each
harness as a regression baseline; size is reported, not used as an arbitrary
hard limit.

`RELEASE_OUTPUT_DIR` may be overridden only with a relative, dedicated untracked
directory physically inside the repository. Release tooling rejects tracked
source destinations and paths that traverse symbolic links. Clean-checkout
validation ignores only that validated output directory, so nested overrides
such as `artifacts/release` remain usable without hiding unrelated working-tree
changes.

## Versioning

The project follows Semantic Versioning. Before 1.0, minor releases may contain
intentional interface changes; patch releases remain backward-compatible.
After 1.0, removing or incompatibly changing a tool name, required argument,
result contract, environment variable, supported deployment mode, or documented
harness compatibility surface requires a major release.

`distribution.json` owns the shared base distribution version. Harness metadata
must match that base version; Codex may append validated `+codex.*` build
metadata without creating an independent distribution version. The MCP core
runtime version remains independently owned by `server/src/version.mjs`.

### Tool result-contract migrations

`list_merge_request_pipelines` now follows the repository-wide paginated-list
result contract and returns `{ data, pagination }` instead of the historical
bare pipeline array. The optional `page` and `per_page` inputs are additive,
with `per_page` bounded to 1 through 100.

Consumers that treated the tool result itself as an array must migrate to
`result.data`. Callers can use `result.pagination.nextPage` and related
metadata when additional pages are available. Because the successful result
shape changes, this fix is an intentional pre-1.0 interface change and must ship
in a minor release rather than a patch release.

The migration was already present in the published v0.1.1 tag before the
release metadata/changelog split was reconciled. v0.2.0 is therefore the first
semantically minor release line that formally carries this migration. Users
already on v0.1.1 have the paginated result shape; users upgrading from v0.1.0
or older must apply the `result.data` migration described above.

GEN-08 prepares a stable multi-harness release candidate but does not invent or
publish a tag from the feature branch. The final release version is selected and
tagged only through the normal reviewed release process after the exact commit
is on a green `main`.

## Upgrade and rollback

Read [CHANGELOG.md](../CHANGELOG.md), rebuild or install the new harness
package, and restart the MCP process. Validate stdio with the appropriate
`validate:<harness>` command or `npm run smoke`; validate a public deployment
with `npm run check:mcp-deployment -- <public-mcp-url>`.

Existing Codex users retain the established root manifest/configuration and
artifact name during GEN-08. Users of another harness should follow that
harness's adapter guide rather than copying Codex paths.

For rollback, reinstall the previous tagged archive, verify its checksum, and
restart the MCP process. Configuration is environment-based and requires no
data migration. Revoke or rotate credentials if a rollback follows a suspected
security incident.
