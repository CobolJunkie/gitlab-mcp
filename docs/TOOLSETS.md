# Static toolsets

GitLab MCP supports server-defined static toolsets that bound the registered MCP
tool surface without changing individual tool schemas, routes, or safety
annotations. Toolset selection is implemented in the canonical server core, so
stdio, HTTP, Codex, Claude Code, Cline, and Pi use the same filtering behavior.

## Configuration

Set `MCP_TOOLSETS` in the environment that starts the MCP process. The value is
a comma-separated list of canonical toolset names. Whitespace is trimmed and
duplicate names are ignored.

For SURF-01, both an unset or blank value and either alias below preserve the
complete existing tool surface:

```text
MCP_TOOLSETS=default
MCP_TOOLSETS=all
```

`default` is intentionally an alias of `all` in this release. Do not assume it
will remain identical in a later surface-optimization issue.

Select a bounded union by naming explicit toolsets:

```text
MCP_TOOLSETS=context,repository,issues
```

`all` and `default` cannot be combined with explicit names. Unknown names,
empty comma-separated entries, and non-string programmatic configuration fail
at startup with a deterministic configuration error instead of silently
changing the exposed surface.

## Canonical toolsets

The server-controlled toolsets are:

- `context` — runtime/capability discovery, current identity, project search,
  and project context resolution;
- `platform` — broader instance, group, user, membership, and platform
  operations;
- `repository` — repository files, trees, branches, commits, diffs, and related
  repository operations;
- `issues` — issue and issue-related operations;
- `merge_requests` — merge requests, reviews, discussions, approvals, and
  related operations;
- `ci` — pipelines, jobs, artifacts, runners, statuses, and pipeline schedules;
- `governance` — protected refs and other repository governance controls;
- `releases` — tags and releases;
- `deployments` — environments and deployments;
- `variables` — CI/CD variable inspection and mutation; and
- `webhooks` — project webhook diagnostics.

Every registered tool has exactly one primary toolset. Membership is assigned
explicitly at the shared registration boundary; it is not inferred from
free-form tool names at runtime. The registration contract rejects duplicate
primary assignments, and the toolset contract tests prove that the full
canonical inventory has no orphaned tools.

## Read-only mode

`MCP_READ_ONLY=true` is applied by the shared registrar after toolset selection.
It always wins: selecting a toolset that contains write operations never makes
those write operations available in read-only mode.

For example:

```text
MCP_TOOLSETS=issues
MCP_READ_ONLY=true
```

exposes only read-only issue tools.

## Harness behavior

Codex, Claude Code, and Cline launch the canonical MCP bundle directly and
inherit `MCP_TOOLSETS` from their parent environment. Pi also launches the same
canonical bundle, but because its extension deliberately allowlists variables
forwarded to the packaged child process, `MCP_TOOLSETS` is explicitly included
in that allowlist. No adapter owns a separate toolset-membership table or
filtering implementation.

Restart the owning harness or deployment after changing `MCP_TOOLSETS` because
tool registration happens when the MCP server starts.

## Surface benchmarking

The BENCH surface audit can report every canonical toolset separately using the
same selector as runtime registration:

```text
npm run benchmark:surface
```

Candidate combinations can be measured without changing runtime defaults:

```text
node scripts/benchmark-surface.mjs --toolsets=context,repository,issues
node scripts/benchmark-surface.mjs --toolsets=issues --read-only
```

Reports include tool count, serialized schema bytes, estimated schema tokens,
and read/write/destructive distribution. The frozen pre-toolset `all` baseline
remains a separate compatibility reference and is not rewritten by candidate
toolset measurements.
