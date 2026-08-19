# Claude Code adapter

The Claude Code distribution is a thin native plugin around the canonical GitLab
MCP core and shared Agent Skills. It contains no GitLab API, tool, safety,
sanitisation, transport, or response implementation.

Claude Code natively supports plugin-bundled MCP servers and `skills/`, so this
adapter does not use the Agent SDK and does not implement an MCP bridge.

## Prerequisites

- Node.js 22 or newer available to the process that launches Claude Code
- a current Claude Code release with plugin, MCP, and Agent Skills support
- `GITLAB_URL` and `GITLAB_TOKEN` available to the environment that launches
  Claude Code

The packaged `gitlab-claude-code-mcp` artifact already contains the canonical MCP
bundle and Skills. Normal artifact consumers do not run `npm install` or build
the repository.

## Plugin layout

The materialized distribution uses Claude Code's native plugin-root layout:

```text
gitlab-claude-code-mcp/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── skills/
├── server/
│   └── dist/
│       └── gitlab-mcp.cjs
├── distribution.json
├── README.md
└── LICENSE
```

`.claude-plugin/plugin.json` and `.mcp.json` are generated from
`distribution.json`. The manifest points at `./.mcp.json`; the canonical Skills
stay in Claude Code's default root-level `skills/` location and are discovered
automatically. The MCP configuration launches:

```text
node ${CLAUDE_PLUGIN_ROOT}/server/dist/gitlab-mcp.cjs --stdio
```

`${CLAUDE_PLUGIN_ROOT}` is supplied by Claude Code and resolves to the current
plugin installation directory, including marketplace cache locations. The
adapter therefore does not require an installation-root placeholder or an
absolute path in committed configuration.

Credentials are intentionally absent from the generated plugin files. The MCP
child process inherits the environment that launches Claude Code; keep
`GITLAB_URL` and `GITLAB_TOKEN` out of plugin metadata and version control.

## Use the packaged artifact

CI and release validation publish an inspectable
`release/gitlab-claude-code-mcp/` directory plus a reproducible
`gitlab-claude-code-mcp-<label>.tar.gz` archive and matching `.sha256` sidecar.
For tagged builds the label is the release tag; ordinary validation uses
`validation`.

Before extracting a downloaded archive, verify it against its checksum sidecar
where `sha256sum` is available:

```text
sha256sum -c gitlab-claude-code-mcp-<label>.tar.gz.sha256
```

After verification, extract the archive to a stable location. Its root directory
is `gitlab-claude-code-mcp-<label>/`; you can keep that name or rename the
extracted directory.

For a session-local load, start Claude Code with the extracted plugin directory:

```text
claude --plugin-dir /absolute/path/to/gitlab-claude-code-mcp-<label>
```

On Windows, quote paths that contain spaces. `--plugin-dir` loads the plugin for
that Claude Code session; persistent marketplace installation is handled by the
normal Claude Code plugin/marketplace workflow rather than by repository-specific
configuration.

Do not point `--plugin-dir` at `adapters/claude/` in a source checkout. That
directory owns generated adapter metadata, not a complete plugin package. Use the
materialized distribution created by `npm run validate:claude`.

## Use from a source checkout

From a clean source checkout:

```text
npm ci
npm run build
npm run validate:claude
```

The validator creates `release/gitlab-claude-code-mcp/`. Load that directory
with `claude --plugin-dir` as shown above.

Set credentials before starting Claude Code. PowerShell example:

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"
$env:GITLAB_TOKEN = "<token>"
claude --plugin-dir "C:\path\to\release\gitlab-claude-code-mcp"
```

Use the narrowest GitLab token scopes that cover the operations you intend to
perform.

## Agent Skills

The canonical Skills remain in the repository-level `skills/` tree. They are
copied into the plugin root unchanged when the Claude distribution is
materialized.

Claude Code automatically discovers plugin Skills under `skills/<name>/SKILL.md`.
There is no Claude-specific fork of the Skill content, and no adapter-to-adapter
dependency is involved.

## Validation

Repository contributors should run:

```text
npm run adapters:check
npm run build
npm run validate:claude
```

`validate:claude`:

- materializes the native plugin-root package from the Claude adapter contract,
  canonical bundle, shared Skills, distribution metadata, documentation, and
  license;
- validates the generated plugin manifest and MCP configuration against the
  canonical distribution;
- verifies the package does not contain repository adapter-source paths;
- starts both the canonical and packaged stdio servers and requires identical
  MCP tool inventories;
- checks packaged runtime provenance and `get_runtime_info`;
- creates the Claude archive twice and requires byte-for-byte reproducibility;
- verifies the archive exactly matches the validated materialized package; and
- writes a dedicated SHA-256 sidecar for the archive.

If Claude Code is installed locally, the official strict plugin validator is an
additional useful compatibility check:

```text
claude plugin validate release/gitlab-claude-code-mcp --strict
```

CI deliberately keeps the repository validator independent of the Claude Code
binary so the package smoke remains deterministic and does not require an LLM
login or a second harness runtime dependency. The native manifest/MCP layout is
kept small so official validation can be run directly when desired.
