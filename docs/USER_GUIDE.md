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
Label arrays follow GitLab's comma-separated REST representation. Passing
`labels: []` intentionally sends an empty label string, which is GitLab's
documented clear-all form. The MCP does not invent an escaping convention for
literal commas in label names; GitLab 18.x rejects such names at label creation.

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

`retry_pipeline` treats non-definitive mutation failures as ambiguous. GitLab
has been observed to return HTTP 409 after replacement jobs were already
created, so response loss, HTTP 408, HTTP 409, and 5xx failures do not authorize
an automatic retry. Re-read the pipeline and call `list_pipeline_jobs` with
`include_retried: true` before any further retry.

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
intent. Pipeline schedule updates can change the target branch or tag. Short
refs such as `main` are accepted; use a fully-qualified ref such as
`refs/heads/main` or `refs/tags/main` when a short name could identify both.
GitLab remains authoritative for invalid or ambiguous refs. Release deletion
preserves the associated Git tag. Tag deletion is asymmetric: GitLab also
deletes an associated Release. `delete_tag` therefore reads the exact tag
before mutation and, when that read reports a Release, requires
`acknowledge_associated_release_deletion: true` in addition to the ordinary
tag-deletion acknowledgement. GitLab does not offer an atomic
delete-if-release-state-unchanged operation for tags, so a Release association
created after the final preflight remains a residual race; ambiguous
post-deletion verification fails closed and must be reconciled before retrying.
Protected-branch and approval-rule mutations perform a read preflight and
require an explicit acknowledgement;
protected-branch changes also require an explicit unprotect rule. Schedule
variable values are redacted from results.

### Inspect deployments

GitLab supports server-side deployment filters for environment, status, and
updated/finished time ranges; its Deployments API exposes `ref` only as an
ordering field. To keep `list_deployments` ref filtering truthful, GitLab MCP
implements `ref` locally by scanning the server-filtered result to exhaustion
before applying the requested output page. The scan uses pages of 100, is bounded
to at most 100 pages, and fails closed when exhaustion cannot be established
within that bound rather than knowingly returning a partial ref-filtered result.
The scan follows GitLab's ordinary offset-pagination consistency model; it is not
snapshot-isolated, so deployments changing while the scan is in progress can
change page membership. Narrow large searches with environment, status, or
time-range filters.
`order_by: "ref"` remains available independently for GitLab-side ordering.

### Clean up environments safely

Resolve the exact environment before changing it. Use `list_environments` or
`get_environment` to confirm the project, numeric environment ID, exact name,
and current state; do not infer a target from a deployment name or URL alone.

`stop_environment` requires that numeric ID, the exact expected environment
name, and `acknowledge_environment_stop: true`. It reads the environment again
immediately before the mutation and rejects an ID/name mismatch or unsupported
state. Repeating the operation for a stopped, stopping, or already-absent target
returns a bounded no-change result. Set `force: true` only when you intentionally
want GitLab to stop the environment without executing configured `on_stop`
actions.

GitLab requires an environment to be stopped before deletion.
`delete_environment` therefore never hides a stop inside the delete call: stop
the exact target first, verify it is stopped, then supply the same numeric ID,
exact expected name, and `acknowledge_environment_deletion: true`. An
already-absent target, including a concurrent deletion after preflight, is
reported as an idempotent no-change cleanup result. Other GitLab permission,
license, or API failures are surfaced rather than treated as success.

Read-only mode exposes the environment inspection tools but omits both lifecycle
mutations.

### Project and group CI/CD variables

Use the dedicated project or group CI/CD variable tools to inspect metadata or
manage a value. Values are accepted only for create and update calls, then are
omitted from all MCP responses. Lists and reads expose only safe metadata such
as the key, type, environment scope, masking/hidden state, protection, and raw
setting. `raw: false` enables GitLab variable expansion; use
`masked_and_hidden: true` only while creating a variable because GitLab makes a
hidden value irreversible. When a key has multiple environment scopes, pass
`filter_environment_scope` for a precise read, update, or deletion.

### Project access-token lifecycle and CI credential replacement

Use `get_project_access_token_capabilities` before changing project access
tokens. `list_project_access_tokens` and `get_project_access_token` return safe
metadata only. `create_project_access_token` and `rotate_project_access_token`
omit the new token from normal text output and expose it only in the one-time
structured result of that operation; later reads cannot retrieve the value.
Treat that structured result as a secret and move it directly into its intended
secret store rather than copying it into prompts, notes, or logs.

GitLab requires a personal access token with `api` scope to create a project
access token or rotate another project access token. A project access token can
self-rotate with `token_id: "self"` when it has `api` or `self_rotate`. Capability
discovery reports only the evidence GitLab exposes and does not claim a
credential subtype that the server cannot prove; the mutation endpoint remains
authoritative.

Availability differs by offering: GitLab.com project access tokens require a
Premium or Ultimate subscription, while GitLab Self-Managed and GitLab
Dedicated support them with any license. Capability discovery returns this
availability evidence explicitly. A `404` remains `unknown` because GitLab does
not prove whether the cause is subscription tier, hidden/inaccessible project,
disabled access tokens, or endpoint/version availability.

For a project access token already consumed by a project CI/CD variable, prefer
`replace_project_access_token_ci_credential` instead of rotating the old token
in place. Direct rotation immediately invalidates the previous value and can
break consumers before their stored credential is updated. The replacement
workflow requires the exact old token ID and expected name, an existing exact
CI variable key and environment scope that are both masked and hidden, bounded
replacement scopes/access/expiry, and both destructive acknowledgements. It
then:

1. preflights the exact old token and CI/CD variable metadata;
2. creates the replacement token and keeps its one-time value server-side;
3. writes that value directly to the selected CI/CD variable while preserving
   its description, environment scope, masking, protection, raw mode, and type;
4. reads the variable again and verifies that its safe metadata did not drift;
5. revokes the exact old project access token only after verification succeeds.

The composite workflow never returns the replacement token value. If replacement
token creation cannot be confirmed, the existing CI credential remains untouched
and the operator should inspect project access-token metadata for the requested
replacement name before retrying. If GitLab returns a created token ID but omits
its one-time value, the workflow attempts to revoke that unusable replacement
before any CI write. Once the CI update is dispatched, an unconfirmed write or
failed post-write verification leaves both tokens active for reconciliation. If
the final old-token revocation fails, the CI variable remains on the replacement
and the result identifies the old token that still needs revocation.

More examples are in the [task cookbook](TASK_COOKBOOK.md).

## Understand safety and confirmations

Every tool declares whether it is read-only, mutating, or destructive.

- Reads may still reveal private repository data to the current conversation.
- Writes include issue edits, notes, branches, commits, approvals, releases,
  schedules, and external commit statuses.
- For small edits to existing UTF-8 files, `apply_repository_hunks` accepts
  exact search/replace contexts instead of whole file bodies. It preflights the
  reviewed `expected_head_sha`, can verify `expected_blob_sha` per file,
  rejects zero-match or ambiguous multi-match contexts, and submits all changed
  files in one atomic GitLab commit. Use `dry_run: true` to validate without a
  write.
- `commit_job_artifact_file` copies one bounded file from a same-instance CI job
  artifact directly into an explicit repository create/update commit. It guards
  the reviewed target branch head, rejects create collisions or update misses,
  uses `last_commit_id` for updates, and does not return artifact contents.
- `revert_commit` undoes one complete reviewed commit through GitLab's native
  server-side revert endpoint. It requires the exact expected target head,
  proves the reviewed commit is reachable from that head, performs GitLab's
  native conflict/empty-change dry-run, rechecks the target head immediately
  before mutation, and verifies the resulting commit parent
  and branch pointer afterward. GitLab's revert API does not accept a custom
  revert message or an atomic expected-head parameter; a post-write race is
  therefore reported for reconciliation rather than hidden or force-rewritten.
  Use `dry_run: true` for validation only.
- `cherry_pick_commit` replays one complete reviewed non-merge commit through
  GitLab's native cherry-pick endpoint without retransmitting file contents. It
  requires the exact expected target head, validates the source commit, runs
  GitLab's native conflict/empty-change dry-run, rechecks immediately before
  mutation, then verifies the resulting parent and branch pointer. Merge commits
  are rejected because GitLab's native API exposes no explicit mainline-parent
  selector. Use `apply_repository_hunks` for partial-file edits, and use merge
  request suggestions when the intended edit already exists as a review
  suggestion rather than as a standalone commit. Use `dry_run: true` for
  validation only.
- `delete_branch` requires a full reviewed `expected_head_sha` and
  `acknowledge_branch_deletion: true`. It reads the exact branch again
  immediately before GitLab's name-based deletion and verifies absence
  afterward. GitLab provides no atomic delete-if-head-equals operation, so a
  final race remains; a concurrently absent branch is reported as a confirmed
  no-change outcome only after an exact branch-list corroboration confirms the
  repository is still readable and the branch remains absent. Ambiguous outcomes
  are reported for reconciliation rather than claimed as success. A response-less,
  timeout, HTTP 408, or 5xx DELETE failure is treated as mutation-ambiguous even
  when postflight evidence shows the branch currently absent; callers must re-read
  before retrying. Protected and default branch restrictions remain
  GitLab-authoritative.
- `create_commit` only supports create, update, move, and chmod file actions.
  File deletion or a forced branch update requires the destructive
  `create_destructive_commit` tool, which requires a reviewed `start_sha`.
  In ordinary non-force mode, update and move actions also require the reviewed
  file `last_commit_id` so GitLab can reject stale same-file mutations after
  the branch preflight. `force=true` intentionally permits update/move without
  that file guard because it replaces history from the reviewed `start_sha`;
  delete actions always require `last_commit_id`.
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
at 100. Merge-request pipeline history follows this paginated-list contract and
returns GitLab pagination metadata so callers can request subsequent pages
explicitly. Ask for a specific page or narrower filter instead of requesting
every object. Large job logs, blobs, raw files, attachments, and artifacts have
response limits to reduce accidental disclosure and memory use.

For an existing checkout, repository edits normally use local Git because it
provides clearer diffs, tests, and history. Direct GitLab file tools are useful
when no checkout exists or when a small remote edit is explicitly requested.

For `create_file`, `update_file`, and `delete_file`, `branch` is always the
target branch. Omit `start_branch` when that target branch already exists. To
create the target branch as part of the same file mutation, set `branch` to the
new branch name and `start_branch` to its base, for example
`branch: "docs/fix"` with `start_branch: "main"`. The update and delete tools
still require the current file `last_commit_id`. Use `create_branch` first
when branch creation should be a separate, explicit operation.

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
