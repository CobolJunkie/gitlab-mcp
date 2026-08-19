# GitLab MCP user guide

GitLab MCP lets supported MCP harnesses inspect and operate GitLab through one
canonical typed tool surface and shared Agent Skills. Codex, Claude Code, Cline,
and Pi use supported local distributions of the same core; ChatGPT can use the
same core through a remote Streamable HTTP deployment.

GitLab MCP covers project discovery, repositories, issues, merge requests,
review discussions, pipelines, job artifacts, governance policy, tags, releases,
pipeline schedules, and related GitLab administration workflows.

## Before you begin

You need:

- access to a GitLab.com, GitLab Dedicated, or self-managed GitLab instance;
- a role that permits the GitLab actions you intend to perform;
- Node.js 22 or newer for a source build; and
- one supported harness distribution or a deployed HTTP connector.

Choose the guide matching your local harness:

- [Codex](../adapters/codex/README.md)
- [Claude Code](../adapters/claude/README.md)
- [Cline](../adapters/cline/README.md)
- [Pi](../adapters/pi/README.md)

This repository is the source package. A source installation is a developer
workflow; normal consumers should use a verified release artifact for their
harness when one is available:

1. Clone a reviewed tagged release or download the matching verified harness
   archive.
2. Verify its published checksum and, where provided, the release SBOM.
3. For a source checkout, run `npm ci`, `npm test`, and `npm run build`.
4. Follow the matching adapter guide for package loading, MCP configuration, and
   Agent Skills discovery.
5. Restart or refresh the harness and begin a new session so updated tools and
   Skills are discovered.

Do not install executable MCP packages or workflow instructions from an
unreviewed fork.

## Authenticate local stdio use

Local harnesses read GitLab configuration from the environment that launches the
MCP distribution:

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"
$env:GITLAB_TOKEN = "<token>"
```

```bash
export GITLAB_URL="https://gitlab.example.com"
export GITLAB_TOKEN="<token>"
```

`GITLAB_URL` defaults to `https://gitlab.com`. `GITLAB_PRIVATE_TOKEN` is
accepted as a compatibility alias, but `GITLAB_TOKEN` is preferred.

After installation, call `get_runtime_info` to verify the core/distribution
versions, deployment mode, read-only filtering, and registered-tool inventory
fingerprint. It does not expose credentials or arbitrary environment values.

For inspection-only use, create a token with `read_api`. Workflows that create
or modify GitLab resources require `api`. The effective result is also limited
by the token owner's GitLab role: an `api` token does not grant permissions the
user does not have. GitLab documents the exact behavior of
[`read_api` and `api`](https://docs.gitlab.com/security/tokens/access_token_scopes/).

Use a token expiration date, store it in an operating-system secret mechanism,
and rotate it after suspected exposure. Never put the token in a prompt,
repository file, screenshot, issue, or shell history.

HTTP/ChatGPT deployments use each connected user's OAuth bearer token instead
of one shared `GITLAB_TOKEN`. See [ChatGPT deployment](CHATGPT_DEPLOYMENT.md).

## Verify your first connection

Start with read-only prompts:

```text
Use GitLab to tell me which account and instance are connected.
```

```text
Check GitLab capabilities for group/project and explain unavailable features.
```

```text
List the five most recently updated open merge requests in group/project.
```

`get_gitlab_capabilities` reports evidence-based states:

- `available`: the probe succeeded;
- `permission_required`: the endpoint exists but the identity cannot use it;
- `license_required`: GitLab indicates a tier restriction;
- `not_configured`: the feature exists but is not configured;
- `unavailable`: the server explicitly does not support the feature; and
- `unknown`: available evidence is ambiguous.

Use `detailed: true` only when you need individual probe outcomes. Use
`refresh: true` after changing a token, role, license, or project setting.

## Invoke the right workflow

The general GitLab Skill is selected automatically for matching requests when
the harness supports Agent Skills. You can invoke a specialized workflow
explicitly when you want its stricter process:

- `$gitlab`: general discovery, triage, repository, issue, MR, and operational
  work;
- `$gl-address-comments`: inspect unresolved MR discussions, implement fixes,
  and optionally reply or resolve threads;
- `$gl-fix-ci`: diagnose failed MR pipelines from job state and bounded logs;
- `$gl-publish`: review local changes, create a branch, commit, push, and open
  a draft merge request.

Use the harness's normal Skill/workflow invocation mechanism. Harnesses without a
separate Skill UI can still call the canonical MCP tools through their packaged
integration.

## Common workflows

### Project and issue triage

Ask for a bounded result and identify the project:

```text
Summarize the ten highest-priority open issues in group/project, grouped by
blocked, actionable, and needs clarification.
```

GitLab MCP supports account-wide issue triage, project issues, notes, labels,
assignees, milestones, reactions, confidentiality, weights, and due dates.

### Merge request review

```text
Review merge request !42 in group/project. Summarize risk, unresolved
discussions, pipeline state, and the files that need the closest review.
```

Inline review state uses GitLab discussions rather than flat comments.
Approvals, replies, discussion resolution, and merges are separate operations.

### CI diagnosis

```text
Diagnose the failed jobs in the latest merge-request pipeline for
group/project. Explain the first actionable root cause and propose a fix.
```

Job logs and artifacts are bounded. Ask for a narrower file, line range, or job
when a result is truncated.

For operations work, create a pipeline with bounded typed inputs, inspect the
latest pipeline for a ref, retrieve test-report summaries, and follow downstream
child pipelines through bridge jobs. Variable values are omitted from the
normalized response.

### Publish local changes

```text
Use $gl-publish to review my current diff, run appropriate tests, commit it on
a focused feature branch, push, and open a draft GitLab merge request.
```

Publishing does not imply merging. Ask explicitly if you want a successful,
review-ready merge request merged after its pipeline passes.

### Releases and schedules

```text
Inspect existing tags and releases, then propose release notes for v1.2.0.
Do not create the tag or release yet.
```

```text
Create a nightly pipeline schedule on main at 02:00 UTC and add the variable
DEPLOY_ENV=staging. Show variable names, but never echo their values.
```

Tag, release, schedule, ownership, and variable mutations require explicit
intent. Tag deletion is separate from release deletion. Protected-branch and
approval-rule mutations perform a read preflight and require an explicit
acknowledgement; protected-branch changes also require an explicit unprotect
rule. Schedule variable values are redacted from results.

### Project and group CI/CD variables

Use the dedicated project or group CI/CD variable tools to inspect metadata or
manage a value. Values are accepted only for create and update calls, then are
omitted from all MCP responses. Lists and reads expose only safe metadata such
as the key, type, environment scope, masking/hidden state, protection, and raw
setting. `raw: false` enables GitLab variable expansion; use
`masked_and_hidden: true` only while creating a variable because GitLab makes a
hidden value irreversible. When a key has multiple environment scopes, pass
`filter_environment_scope` for a precise read, update, or deletion.

More examples are in the [task cookbook](TASK_COOKBOOK.md).

## Understand safety and confirmations

Every tool declares whether it is read-only, mutating, or destructive.

- Reads may still reveal private repository data to the current conversation.
- Writes include issue edits, notes, branches, commits, approvals, releases,
  schedules, and external commit statuses.
- `create_commit` only supports create, update, move, and chmod file actions.
  File deletion or a forced branch update requires the destructive
  `create_destructive_commit` tool, which requires a reviewed `start_sha` and
  requires `last_commit_id` for every delete action.
- Destructive operations include deletions, merges, pipeline cancellation,
  reaction removal, and similar irreversible or high-impact state changes.

The workflow resolves the project and object before a write. It requires clear
intent for deletion, merge, approval, discussion resolution, and CI state
changes. When wording is ambiguous, ask for a proposal or dry review first:

```text
Show exactly what you would change, but do not make any GitLab changes.
```

## Pagination, limits, and large data

Most list tools accept `page` and `per_page`; GitLab generally caps `per_page`
at 100. Ask for a specific page or narrower filter instead of requesting every
object. Large job logs, blobs, raw files, attachments, and artifacts have
response limits to reduce accidental disclosure and memory use.

For an existing checkout, repository edits normally use local Git because it
provides clearer diffs, tests, and history. Direct GitLab file tools are useful
when no checkout exists or when a small remote edit is explicitly requested.

## Upgrade or remove

Read [CHANGELOG.md](../CHANGELOG.md) and
[COMPATIBILITY.md](COMPATIBILITY.md) before upgrading. Install the new verified
artifact using the adapter guide for your harness, restart or refresh that
harness, and begin a new session so updated tools and Skills are loaded.

For rollback, reinstall the previous verified tagged harness archive and restart
the MCP process. Remove the integration using the harness's normal
package/plugin/MCP-management flow. Removing a local distribution does not
revoke GitLab tokens; revoke unused credentials separately in GitLab.

Existing Codex installations retain the established root manifest,
configuration, preload, and `gitlab-codex-plugin` artifact compatibility during
GEN-08. Users of Claude Code, Cline, and Pi should use their own adapter guides
rather than copying Codex paths.

## Getting help

Start with [troubleshooting](TROUBLESHOOTING.md). For reproducible defects or
feature requests, follow [SUPPORT.md](../SUPPORT.md). Report vulnerabilities
through the confidential process in [SECURITY.md](../SECURITY.md).
