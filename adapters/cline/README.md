# Cline adapter

The Cline distribution is a thin MCP + Agent Skills adapter over the canonical
GitLab MCP core. It does not contain GitLab API, tool, safety, sanitisation, or
response logic.

Cline natively supports local stdio MCP servers and Agent Skills, so this adapter
deliberately does not use the Cline SDK or implement a protocol bridge.

## Prerequisites

- Node.js 22 or newer
- Cline in VS Code, or Cline CLI 3.0.27 or newer for the documented
  `mcp install` and `skill` manager commands
- `GITLAB_URL` and `GITLAB_TOKEN` available to the environment that launches
  Cline

If you are using the packaged `gitlab-cline-mcp` artifact, the canonical MCP
bundle is already included and no repository build is required. If you are
installing from a source checkout instead, run `npm ci` and `npm run build` first
so `server/dist/gitlab-mcp.cjs` exists.

## MCP configuration

`cline_mcp_settings.template.json` is generated from `distribution.json`. Replace
`<ABSOLUTE_GITLAB_MCP_ROOT>` with the absolute path to the root that contains
this installation before using the entry in Cline.

### From the packaged artifact

CI and release validation publish both an inspectable `gitlab-cline-mcp/`
directory and a reproducible `gitlab-cline-mcp-<label>.tar.gz` archive with a
matching `.sha256` sidecar. The label is the release tag for tagged builds and
`validation` for ordinary validation builds.

Extract the archive to a stable location. The extracted package already contains
`server/dist/gitlab-mcp.cjs`, so point `<ABSOLUTE_GITLAB_MCP_ROOT>` at the
extracted package root. No npm install or build step is required for normal
artifact consumption. Verify the downloaded archive against its sidecar before
installation; on systems with `sha256sum`, run:

```text
sha256sum -c gitlab-cline-mcp-<label>.tar.gz.sha256
```

For example, an artifact extracted to `C:/tools/gitlab-cline-mcp` uses:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": [
        "C:/tools/gitlab-cline-mcp/server/dist/gitlab-mcp.cjs",
        "--stdio"
      ]
    }
  }
}
```

### From a source checkout

Run:

```text
npm ci
npm run build
```

Then point `<ABSOLUTE_GITLAB_MCP_ROOT>` at the repository root. For example:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["C:/path/to/gitlab-mcp/server/dist/gitlab-mcp.cjs", "--stdio"]
    }
  }
}
```

Use an absolute path. On Windows, prefer forward slashes as shown above; if you
use backslashes in JSON, escape each one as `\\`. Cline does not provide a
portable workspace-root substitution that this distribution can safely rely on
for a globally configured MCP server.

### Cline CLI

Run Cline's supported MCP manager in a TTY:

```text
cline mcp
```

To prefill the add-server wizard for the packaged artifact, use Cline's supported
`mcp install` command (`mcp add` is an alias):

```text
cline mcp install gitlab -- node "C:/tools/gitlab-cline-mcp/server/dist/gitlab-mcp.cjs" --stdio
```

The install command still opens Cline's interactive wizard, so it requires a TTY.
Use the same canonical `node` command and bundle arguments from the generated
settings template for other installation roots.

For manual CLI configuration, current Cline releases use
`~/.cline/data/settings/cline_mcp_settings.json` by default, while
`CLINE_MCP_SETTINGS_PATH` can select a deliberate alternate settings file. This
distribution intentionally does not rely on project `.cline/mcp.json`, whose
discovery and support have varied across Cline surfaces and versions. Prefer
`cline mcp` when practical, and keep credentials out of version control.

### Cline IDE

Open Cline's MCP configuration UI, choose **Configure MCP Servers**, and merge
the generated `gitlab` entry into the existing `mcpServers` object. Prefer the
Cline UI over hard-coding a VS Code storage path because the physical settings
location differs between IDE installations and portable setups.

The template intentionally contains no token. Cline's MCP child process normally
inherits the environment of the Cline process, so set `GITLAB_URL` and
`GITLAB_TOKEN` before starting Cline. If your environment isolation requires
explicit MCP `env` values, add them locally and never commit credentials.

## Agent Skills

The canonical Skills remain under the repository-level `skills/` directory. They
are not forked into `adapters/cline/`.

Cline discovers project Skills under `.cline/skills/` and global Skills under
`~/.cline/skills/`. In Cline versions where Skills remains feature-gated, enable
**Settings → Features → Enable Skills**. Discovered Skills are enabled by default
unless individually disabled. If Skill discovery does not refresh after
installation, reload the Cline session.

Current Cline CLI releases also provide a dedicated Skill manager. Run it in a
TTY and follow the interactive install/manage flow when it fits the source you
are using:

```text
cline skill
```

The manual copy route below remains the deterministic offline path for the
packaged artifact and works for both CLI and IDE consumers.

Copy the canonical skill directories from the package or source checkout into the
desired Cline location.

Project installation example:

```powershell
New-Item -ItemType Directory -Force .cline\skills | Out-Null
Copy-Item -Recurse -Force "C:\path\to\gitlab-mcp\skills\*" .cline\skills\
```

Global installation example:

```powershell
New-Item -ItemType Directory -Force "$HOME\.cline\skills" | Out-Null
Copy-Item -Recurse -Force "C:\path\to\gitlab-mcp\skills\*" "$HOME\.cline\skills\"
```

The distributable `gitlab-cline-mcp` package contains the complete canonical
Skills tree. Adapter validation parses standards-compliant YAML frontmatter,
checks the required Agent Skills `name` and `description` constraints, and
validates the standard optional `license`, `compatibility`, `metadata`, and
`allowed-tools` field types and limits while supporting multiline YAML values.

## Contributor-local Cline rules

Contributor-specific Cline rules are local workspace configuration rather than
repository product configuration. The repository does not ship a root
`.clinerules` file, and the distributable Cline adapter must not depend on or
package contributor-local rules. Package validation defensively rejects
`.clinerules` from the Cline artifact if one is present in a working checkout.

## Validation

Repository contributors can validate the generated distribution with:

```text
npm run adapters:check
npm run build
npm run validate:cline
```

`validate:cline` materializes `release/gitlab-cline-mcp/` from the adapter
contract, canonical bundle, and canonical Skills. It validates the packaged
metadata and settings, verifies that contributor-only rules are excluded,
compares the packaged MCP tool inventory with the canonical bundle, checks
runtime provenance, creates the Cline tarball twice to prove byte-for-byte
reproducibility, verifies its contents, and writes the archive's SHA-256 sidecar.
CI publishes the validated directory, archive, and checksum as the focused Cline
adapter artifacts rather than duplicating the full core test/security matrix.
