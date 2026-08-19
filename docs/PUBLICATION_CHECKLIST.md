# GitLab MCP publication checklist

## Product identity and generalisation

- [ ] User-facing project and documentation identity is **GitLab MCP**, not a
      Codex-only plugin identity.
- [ ] Codex, Claude Code, Cline, and Pi are presented as peer supported
      distributions of the same canonical MCP core and Agent Skills.
- [ ] The neutral `gitlab` MCP/distribution identifier remains version and
      metadata compatible across the four supported harnesses.
- [ ] Existing Codex root `.codex-plugin/plugin.json`, `.mcp.json`, `.app.json`,
      preload, and `gitlab-codex-plugin` artifact compatibility remain intact or
      any future intentional breaking migration is explicitly documented.
- [ ] [GENERALISATION_AUDIT.md](GENERALISATION_AUDIT.md) matches the release and
      no audit finding has regressed into duplicated GitLab logic, cross-adapter
      coupling, metadata drift, or divergent Skills/security behavior.
- [ ] Core observability remains centralized and privacy-safe; OpenTelemetry
      SDK/exporter integration and semantic response/token optimisation remain
      follow-up core work rather than harness-specific release additions.

## Code and security

- [ ] The release commit is on `main` and its pipeline is successful.
- [ ] The GitLab project still requires successful pipelines before merge.
- [ ] The release tag pattern (normally `v*`) is protected in GitLab so the
      protected disposable-integration variables are available to tag pipelines.
- [ ] The tag pipeline's `integration_disposable` job passed against the
      dedicated disposable project.
- [ ] The tag pipeline's stage-ordered `release_gate` passed, proving the tagged
      SHA is contained in the default branch after all earlier tag jobs passed.
- [ ] Tests, coverage, lint, unused-variable/import checks, dependency-cruiser,
      formatting, metadata drift/version checks, dependency audit, bundle
      integrity, build, and Docker/bundle smoke tests pass.
- [ ] The manual/scheduled disposable-project MCP integration suite passed with
      `GITLAB_INTEGRATION_DISPOSABLE=true`; its project was not production.
- [ ] SAST, secret detection, and SonarQube jobs are present and successful when
      supported by the GitLab instance and runner.
- [ ] If an analyzer is allowed to fail by instance policy, a human reviewed its
      report and recorded the outcome before publication.
- [ ] No credentials, private fixtures, customer data, or generated secrets are
      included.
- [ ] Security-sensitive changes received focused review.

## Compatibility and deployment

- [ ] Canonical distribution metadata, root build metadata, Codex manifest,
      Claude Code plugin, Cline distribution, and Pi package metadata versions
      agree wherever they share the base distribution version.
- [ ] The focused `adapter` CI stage validates Codex, Claude Code, Cline, and Pi
      without duplicating the full core Node/security matrix per harness.
- [ ] Node, GitLab, and harness compatibility notes match the release.
- [ ] Codex, Claude Code, Cline, and Pi install/load, upgrade, and rollback have
      been exercised using the documented adapter-specific flows.
- [ ] The Codex adapter starts through its established `.mcp.json` and preload,
      reports the expected runtime provenance, and exposes the canonical tool
      inventory and Skills.
- [ ] The packaged Claude Code plugin starts through its native `.mcp.json`,
      resolves `${CLAUDE_PLUGIN_ROOT}`, and exposes the canonical Skills.
- [ ] The packaged Cline MCP server starts without a user-side `npm install`, and
      the canonical Skills are discoverable from the documented Cline locations.
- [ ] The packaged Pi extension registers the canonical MCP tool inventory,
      exposes the canonical Skills, preserves conservative mutation execution
      semantics, and closes its MCP client on session shutdown.
- [ ] A directly extracted Pi archive was tested after installing its declared
      production dependency with `npm install --omit=dev`.
- [ ] Public HTTPS `/mcp`, OAuth discovery, refresh, and scopes pass
      `check:gitlab-oauth` and `check:mcp-deployment`.
- [ ] Read-only and write-enabled deployments expose the intended scopes and
      tool surfaces.

## Documentation and marketplace policy

- [ ] Codex plugin validation passes with every referenced asset present.
- [ ] Display copy, starter prompts, logos, brand color, and gallery images are
      final and accurate for the intended marketplace surface.
- [ ] README, documentation index, user, configuration, troubleshooting,
      compatibility, Codex adapter, Claude Code adapter, Cline adapter, Pi
      adapter, developer, generalisation-audit, observability, and release
      documentation match the release and all local documentation links pass CI.
- [ ] Website, privacy, terms, support, and security-reporting links are public
      and developer controlled.
- [ ] Branding and trademark usage is reviewed for the intended marketplace.
- [ ] A marketplace submission identifies the technical app ID and public
      OAuth-enabled MCP endpoint without embedding secrets.

## Artifacts and release

- [ ] `npm run release:validate` succeeds for the exact release candidate before
      tagging and produces the complete four-harness candidate set.
- [ ] The tag pipeline produces the Codex archive, CycloneDX SBOM,
      `SHA256SUMS`, the Claude Code, Cline, and Pi archives with matching
      `.sha256` sidecars, and `cross-harness-manifest.json` with its own SHA-256
      sidecar.
- [ ] Permanent release artifacts were created only after `release_gate` and the
      protected disposable-integration dependency both succeeded.
- [ ] `SHA256SUMS`, all three non-Codex harness archive sidecars, and the
      cross-harness manifest sidecar verify after downloading artifacts from
      GitLab.
- [ ] The cross-harness manifest contains exactly Codex, Claude Code, Cline, and
      Pi; all four report the canonical bundle and Skills digests; compressed
      and unpacked package byte sizes are recorded for regression visibility.
- [ ] The extracted Codex archive passes the bundled stdio smoke test without
      user-side `npm install` and `.mcp.json` resolves the bundled server.
- [ ] The extracted Claude Code archive passes packaged MCP startup/tool/runtime
      validation, contains the native plugin manifest and canonical Skills, and
      requires no user-side npm build or install.
- [ ] The extracted Cline archive passes packaged MCP startup/tool/runtime
      validation, contains the canonical Skills, and requires no user-side npm
      build or install.
- [ ] The Pi archive passes package/tool/runtime/shutdown validation, contains
      the extension, generic MCP bridge, canonical Skills, and canonical bundle,
      and declares the expected MCP SDK runtime dependency.
- [ ] The GitLab release attaches or links the verified Codex, Claude Code,
      Cline, and Pi archives, checksums, cross-harness manifest, and SBOM.
- [ ] Release notes include the tag, commit SHA, GitLab MCP identity change,
      Codex compatibility/migration implications, security notes, harness
      checksums, size baseline, rollback guidance, and deferred post-GEN-08 work.
