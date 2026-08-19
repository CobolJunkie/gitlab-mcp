# Generalisation audit

This document records the GEN-08 milestone-closing audit for GitLab MCP. It is
an evidence map for the supported multi-harness baseline rather than a new
architecture layer.

## Product identity decision

The product is **GitLab MCP**: one harness-neutral GitLab MCP core plus shared
Agent Skills, distributed through supported harness adapters.

Machine-facing and compatibility identifiers remain deliberately distinct from
the user-facing product name:

- `distribution.json` keeps the neutral `gitlab` distribution/MCP identifier.
- Codex keeps the established `gitlab-codex-plugin` artifact and root
  `.codex-plugin/plugin.json`, `.mcp.json`, and `.app.json` compatibility paths.
- Claude Code uses the `gitlab-claude-code-mcp` artifact.
- Cline uses the `gitlab-cline-mcp` artifact.
- Pi uses the `gitlab-pi-mcp` artifact.

The repository slug `gitlab-codex-plugin` is retained as a compatibility URL and
clone path. Renaming it in GEN-08 would invalidate existing links, clones,
manifest URLs, CI references, and external integrations without improving the
runtime architecture.

The root npm package is private build/development metadata, not a supported
published harness artifact, so it does not define the public product identity.

The Codex names above are compatibility surfaces owned by the Codex adapter,
not repository-wide architecture. GEN-08 does not deprecate them. Any future
removal or incompatible rename must follow normal compatibility policy and be
announced as a breaking migration rather than silently changing existing Codex
installations.

## Supported baseline

GEN-08 supports exactly four local harness distributions:

- **Codex** uses `adapters/codex/distribution.mjs`, publishes the
  `gitlab-codex-plugin` artifact, and launches through configuration plus the
  thin Codex preload.
- **Claude Code** uses `adapters/claude/distribution.mjs`, publishes
  `gitlab-claude-code-mcp`, and uses native plugin MCP configuration.
- **Cline** uses `adapters/cline/distribution.mjs`, publishes
  `gitlab-cline-mcp`, and uses native stdio MCP settings.
- **Pi** uses `adapters/pi/distribution.mjs`, publishes `gitlab-pi-mcp`, and
  uses a thin MCP client/extension bridge.

All four consume the same canonical MCP bundle, `distribution.json`, and
repository-level `skills/` tree.

## Focused architecture audit

### Duplicated GitLab implementation

**Result: no adapter-owned GitLab API implementation found.**

`GitLabClient`, request routing, safety classification, sanitisation, response
shaping, and tool implementations remain under `server/src/`. Adapters package,
launch, or bridge MCP behavior only. Pi's bridge is protocol translation: it
starts the packaged canonical server, discovers MCP tools, forwards calls,
translates supported result shapes, and handles lifecycle cleanup.

### Core or shared code depending on adapters

**Result: rejected by policy.**

Dependency-cruiser forbids `server/` and shared seams from importing
`adapters/`. Executable violation fixtures in `test-dependency-boundaries/`
protect the rule from accidental weakening.

### Adapters depending on core internals

**Result: rejected by policy.**

Adapters communicate through standard MCP/package boundaries or the small
shared distribution seam rather than importing `server/` implementation
internals.

### Cross-adapter coupling

**Result: rejected by policy.**

Isolation rules are generated per adapter and regression fixtures cover
cross-adapter imports. One adapter cannot use another as an implementation
shortcut.

### Metadata and version drift

**Result: centrally checked.**

`distribution.json`, `npm run adapters:generate`, `npm run adapters:check`,
`npm run check:versions`, and focused adapter validators enforce the shared base
distribution version and generated metadata. Codex may keep validated
`+codex.*` build metadata without creating an independent base version.

`SERVER_VERSION` remains independently owned by the harness-neutral MCP core in
`server/src/version.mjs` and is changed only when core runtime behavior changes.
GEN-08 itself does not require a core-version bump.

### Shared Agent Skills drift

**Result: centrally checked.**

Every supported package includes the canonical repository `skills/` tree. The
cross-harness release validator compares Skills digests so a copied, stale, or
missing harness-specific Skill set fails before publication.

### Security and sanitisation divergence

**Result: no harness fork.**

GitLab request authentication, token handling, read-only filtering, tool safety
contracts, response sanitisation, error shaping, and size/time bounds execute in
the canonical MCP server for every harness. Adapters do not own parallel
security policy.

### Release-package omissions

**Result: fail closed.**

The supported-harness registry contains Codex, Claude Code, Cline, and Pi
exactly once. `npm run release:validate` builds the complete candidate set and
the final cross-harness gate rejects missing, duplicated, reordered, stale, or
internally drifting archives. It checks archive checksums, packaged canonical
metadata, MCP bundle digest, and Skills digest.

### Documentation drift

**Result: addressed by GEN-08.**

README, documentation index, user guide, task cookbook, configuration,
troubleshooting, compatibility, adapter, developer, publication, release,
policy, and support documentation identify GitLab MCP as the product and link
the four supported harness flows. Codex-specific names are retained only when
describing Codex compatibility or historical architecture decisions.

## Installation and use flows

A source checkout uses Node.js 22 or newer:

```text
npm ci
npm run build
```

Then follow the matching harness flow:

- **Codex:** keep the established root Codex manifest/configuration and preload;
  validate with `npm run validate:codex`.
- **Claude Code:** use the materialized native plugin package described in
  `adapters/claude/README.md`; validate with `npm run validate:claude`.
- **Cline:** use the materialized MCP + Agent Skills package and generated
  settings described in `adapters/cline/README.md`; validate with
  `npm run validate:cline`.
- **Pi:** install the materialized Pi package described in
  `adapters/pi/README.md`; a directly extracted archive first installs declared
  production dependencies with `npm install --omit=dev`; validate with
  `npm run validate:pi`.

The complete release candidate is produced and verified with:

```text
npm run release:validate
```

That command validates every supported harness and then enforces the exact
cross-harness artifact set.

Publication still follows `docs/RELEASING.md` and requires a reviewed commit on
green `main`, an explicit semantic-version tag, the protected tag pipeline,
disposable integration, release gate, downloaded checksum verification, and
manual harness dogfooding. GEN-08 does not publish a release or invent a tag
from the feature branch.

## Compatibility and migration

Existing Codex users do not need to move configuration paths for GEN-08. The
root Codex files, `gitlab` MCP/plugin identifier, preload, and
`gitlab-codex-plugin` artifact remain valid. The migration is conceptual and
documentary: GitLab MCP is now the product identity, while Codex is one
supported distribution beside Claude Code, Cline, and Pi.

Users should follow the adapter guide matching their harness instead of treating
root Codex files as a generic cross-harness installation contract.

## Post-generalisation follow-up status

GEN-08 deliberately did **not** implement observability or semantic response
projection/token reduction. OBS-01 now establishes the centralized,
provider-neutral core observability event boundary. OpenTelemetry SDK/exporter
integration and semantic response projection/token reduction remain follow-up
core concerns so every harness continues to inherit one security, sanitisation,
and presentation path.

They must not be implemented as private adapter behavior.

## Release-candidate gate

A GEN-08 candidate is ready for publication work only when the merge-request
pipeline and the subsequent exact `main` pipeline are green and the normal
publication checklist can be completed.

The automated candidate gate includes:

- syntax, ESLint, unused-variable/import checks, and Prettier formatting;
- dependency-cruiser architecture boundaries;
- Node.js compatibility tests and threshold-enforced coverage;
- dependency audit, SonarQube, SAST, and secret detection where configured;
- clean canonical bundle build and bundle-neutrality checks;
- stdio/HTTP and Docker smoke tests;
- focused Codex, Claude Code, Cline, and Pi package/handshake validation;
- deterministic artifact and SBOM/checksum validation; and
- the exact four-harness release-set check with canonical bundle and Skills
  digest parity.

Tag-only publication still adds the protected disposable integration job,
default-branch ancestry release gate, strict Pi runtime validation, and
permanent release artifacts. Those publication actions are intentionally not
performed by the GEN-08 feature branch.
