# GitLab MCP release process

GitLab MCP releases are created from an annotated semantic-version tag whose
commit is already contained in a green `main`. The GitLab project must keep its
"Pipelines must succeed" merge policy enabled, and the publication checklist
requires the exact release commit's default-branch pipeline to be successful.
The tag pipeline additionally enforces default-branch ancestry before permanent
artifacts can be created.

A release is one GitLab MCP product release with four supported harness
artifacts: Codex, Claude Code, Cline, and Pi. None of those harnesses is a
separate implementation or privileged core. `distribution.json`, the canonical
MCP bundle, and shared Agent Skills define their common release baseline.

The first stable multi-harness candidate follows this same process. A feature or
merge-request branch may prove release readiness with `npm run
release:validate`, but it must not invent a release tag or be treated as
published. Choose the final semantic version only after the reviewed candidate
is on a green `main` and the normal publication checklist is ready to run.

Disposable-integration credentials are protected CI variables. The release-tag
pattern used by the project (normally `v*`) must therefore be configured as a
protected tag in GitLab so release tag pipelines can receive those credentials.
The disposable-integration job is deliberately materialized on every tag; if
its protected prerequisites are unavailable, it fails closed with an explicit
diagnostic rather than allowing publication or invalidating the pipeline DAG.

`distribution.json` owns the base distribution version used by package metadata
and harness manifests. A harness may append build metadata such as Codex's
`+codex...` suffix without creating a separate base release version. The neutral
`gitlab` identifier remains stable across all harnesses.

The harness-neutral MCP core is versioned independently in
`server/src/version.mjs`. A distribution-only, documentation-only, or
adapter-only release does not require a core-version bump; update
`SERVER_VERSION` only when the core runtime itself changes.

The Codex artifact name `gitlab-codex-plugin` and established root Codex files
are intentional compatibility surfaces. They are not the product name and are
not renamed as part of GEN-08. See
[GENERALISATION_AUDIT.md](GENERALISATION_AUDIT.md) and
[COMPATIBILITY.md](COMPATIBILITY.md) before changing any of these identifiers.

1. Complete [PUBLICATION_CHECKLIST.md](PUBLICATION_CHECKLIST.md).
2. Update `CHANGELOG.md`, set the intended base distribution version in
   `distribution.json`, and run `npm run adapters:generate`. If the MCP core
   itself changed, independently update `server/src/version.mjs` as part of the
   same reviewed release work.
3. Review the generated Codex/Claude Code/Cline/Pi metadata changes, then from a
   clean checkout run all local verification commands documented in
   `CONTRIBUTING.md`, including `npm run adapters:check`,
   `npm run validate:harnesses`, and `npm run release:validate`.
4. Run `npm run test:integration:disposable` against a dedicated disposable
   GitLab project. It intentionally skips unless its explicit environment
   variables are supplied; do not substitute a production project.
5. Merge through a successful merge-request pipeline. Keep the GitLab project
   policy that requires successful pipelines before merge enabled, then verify
   the exact resulting release commit's `main` pipeline is successful before
   tagging it. The pipeline keeps the core verification matrix singular and
   runs Codex, Claude Code, Cline, and Pi in the separate focused `adapter`
   stage after the canonical build.
6. Confirm the release tag pattern (normally `v*`) is configured as protected
   in GitLab, then create and push an annotated tag exactly matching the
   canonical distribution version as `v<distribution.version>` (for example
   `v0.1.1-rc.1`). Release validation rejects lightweight tags, mismatched
   versions, and tags that do not point to the commit being validated. If a tag
   cannot receive the protected disposable-integration variables, its
   `integration_disposable` job fails explicitly and publication remains
   blocked.
7. Wait for the tag pipeline. The strict Pi adapter job is rerun for the exact
   tag with the pinned Pi runtime and standalone binary. A tag-only
   `release_gate` deliberately has no `needs`, so normal GitLab stage ordering
   prevents it from succeeding until every earlier job present in the tag
   pipeline has succeeded. The gate also fetches the default branch and rejects
   a tagged commit that is not contained in it. Permanent artifact publication
   then depends on that gate plus the protected disposable-integration job,
   which is guaranteed to exist on tag pipelines and fails closed if its
   protected prerequisites are unavailable. Release validation produces:
   - `gitlab-codex-plugin-<tag>.tar.gz`, the Codex compatibility distribution
     containing the generated canonical bundle plus the tagged distribution
     sources;
   - a CycloneDX JSON SBOM;
   - `SHA256SUMS` covering the Codex archive and SBOM;
   - `gitlab-claude-code-mcp-<tag>.tar.gz` plus its matching
     `gitlab-claude-code-mcp-<tag>.tar.gz.sha256` sidecar, containing the native
     Claude plugin manifest/configuration, canonical bundle, and canonical
     Skills;
   - `gitlab-cline-mcp-<tag>.tar.gz` plus its matching
     `gitlab-cline-mcp-<tag>.tar.gz.sha256` sidecar, containing the validated
     Cline MCP configuration, canonical bundle, and canonical Skills;
   - `gitlab-pi-mcp-<tag>.tar.gz` plus its matching
     `gitlab-pi-mcp-<tag>.tar.gz.sha256` sidecar, containing the Pi extension,
     generic MCP bridge, canonical bundle, canonical Skills, and package
     metadata; and
   - `cross-harness-manifest.json` plus
     `cross-harness-manifest.json.sha256`, recording the canonical bundle and
     Skills digests plus each harness archive checksum, compressed byte size,
     and unpacked package byte size.
8. Verify `SHA256SUMS`, each harness archive `.sha256` sidecar, and the
   cross-harness manifest sidecar after downloading the artifacts. Confirm the
   manifest contains exactly Codex, Claude Code, Cline, and Pi and that the
   recorded canonical bundle and Skills digests are shared by all four.
9. Smoke-test the extracted Codex, Claude Code, and Cline distributions
   directly. For an extracted local Pi archive, run `npm install --omit=dev`
   inside the package before loading it so its declared MCP SDK runtime
   dependency is present.
10. Install or session-load the candidate distributions in Codex, Claude Code,
    Cline, and Pi; confirm each packaged MCP server and canonical Skills surface
    is usable; and dogfood all four against this repository.
11. Recheck the GEN-08 identity contract: user-facing product copy says GitLab
    MCP, all four harnesses are peers, and Codex compatibility paths remain
    intact. Core observability must remain centralized and privacy-safe;
    OpenTelemetry SDK/exporter integration and semantic response/token
    optimisation must remain core follow-up work rather than being introduced
    in an adapter during release cleanup.
12. Create the GitLab release from the final approved tag, attach or link all
    verified Codex, Claude Code, Cline, and Pi artifacts, checksums, the
    cross-harness manifest, and the SBOM, and copy the matching changelog
    section into the release notes.

The final Codex archive remains deterministic even though the canonical MCP
bundle is generated and ignored in source control. The focused Codex validator
and release flow share the same package validation path: it creates a temporary
Git index and object database from `HEAD`, adds the generated bundle to that
temporary tree, creates a synthetic commit with a fixed timestamp, and uses
`git archive` as the final packager. It generates the archive twice and requires
the SHA-256 digest to match byte-for-byte before publishing artifacts. The
repository and working tree are not modified by this staging process.

The Claude Code, Cline, and Pi archives are independently materialized from
their validated adapter contracts, canonical bundle, canonical Skills,
distribution metadata, documentation, and license. Their temporary Git state is
isolated from ambient Git configuration, each archive is created twice to prove
byte-for-byte reproducibility, and each dedicated SHA-256 sidecar covers the
exact package published by CI.

The final cross-harness gate extracts every expected archive into an isolated
temporary directory. It verifies the archive checksum, canonical metadata,
canonical bundle digest, and canonical Skills-tree digest independently for all
four harnesses. It also records compressed and unpacked byte sizes in the
cross-harness manifest. Missing, duplicated, reordered, stale, or internally
drifting harness releases therefore fail before release artifacts can be
published.

`RELEASE_OUTPUT_DIR` defaults to `release` and may be overridden with another
relative, dedicated untracked directory inside the repository. Release tooling
rejects tracked destinations and symbolic-link traversal before destructive
cleanup or writes. Clean-checkout validation excludes only that validated output
directory, so a nested override such as `artifacts/release` does not make
unrelated source changes invisible.

Record the source commit SHA, runner image, product identity/compatibility notes,
and any harness-specific migration implications in the release notes. For
GEN-08, existing Codex users retain the established artifact/configuration paths;
the migration is from Codex-centric product wording to the GitLab MCP
multi-harness model. The project does not publish a container image; if that
changes, the release must add an immutable image digest and container
SBOM/provenance.

`npm run release:validate` requires a clean checkout outside the validated
release output directory, first rejects canonical metadata/resource drift
through `adapters:check`, builds the ignored canonical bundle without changing
tracked files, proves deterministic Codex, Claude Code, Cline, and Pi archive
creation, creates the Codex SBOM/checksums plus the harness-specific checksum
sidecars, runs each focused harness validator, and then enforces the complete
four-harness release set through the cross-harness manifest gate. The Pi
validator additionally loads the materialized extension, registers the
canonical MCP tool inventory, executes a representative runtime tool, and
verifies shutdown cleanup; the CI adapter job adds the strict pinned-runtime and
standalone-client compatibility checks required again on release tags.

If any release validation step fails, do not publish or manually repair the
artifacts. Fix the source or release tooling, rerun the complete validation, and
publish only the newly generated set.
