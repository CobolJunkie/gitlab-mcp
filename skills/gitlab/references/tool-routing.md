# GitLab MCP Tool Routing

The bundled MCP server exposes stable tools grouped by workflow.

## Identity and projects

- `get_runtime_info` for installed core/distribution versions, deployment mode, and registered-tool inventory fingerprint
- `get_gitlab_capabilities` for instance, version, identity, token-scope, and
  feature-availability evidence; use `detailed` only when probe ambiguity
  matters
- `get_current_user`
- `list_groups`, `get_group`, `list_group_projects`
- `list_group_members`, `get_group_member`
- `search_gitlab` for global, group, or project search. Its contract validates location/scope combinations and scope-specific filters before dispatch. Premium/Ultimate-only search capabilities (`fields=["title"]`, explicit `search_type=advanced|zoekt`, and instance/group code/wiki/commit/note scopes that basic search cannot serve) trigger a read-only `/metadata` preflight and fail closed unless Enterprise Edition capability is proven; this proves only an eligible installation, not the active subscription, so upstream license/backend configuration can still reject or fail to honor an unavailable paid-search capability. `order_by`/`sort` are accepted only for issues, work items, and merge requests because GitLab 18.11 silently ignores them for other verified scopes, and `sort` requires `order_by=created_at` because standalone sort is also ignored; `include_archived` is limited to instance/group project-backed scopes and is rejected for users/snippet titles; advanced-search `num_context_lines=0` is rejected on affected GitLab 18.11.0-18.11.3 and 19.0.0 releases because upstream returns extra context instead of honoring zero
- `list_global_issues` for account-wide recent issue triage
- `search_projects`
- `get_project`
- `list_project_members`, `get_project_member`
- `list_project_labels`, `get_project_label`, `create_project_label`,
  `update_project_label`, `delete_project_label`
- `list_group_labels`, `get_group_label`, `create_group_label`,
  `update_group_label`, `delete_group_label`
- milestone discovery via `search_gitlab` with `scope: "milestones"`; do not pass the issue/work-item/MR-only `state` filter (inspect the returned milestone state instead). Lifecycle mutations use `create_project_milestone`, `update_project_milestone`,
  `delete_project_milestone`, `create_group_milestone`,
  `update_group_milestone`, and `delete_group_milestone`

## Repository and commits

- `list_repository_tree`
- `search_code`
- `get_blob`, `get_file`
- `fetch_gitlab_file_url` for same-instance blob, raw, or API file URLs
- `download_gitlab_attachment`
- `create_file`, `update_file`, `delete_file`: `branch` is the target
  branch. Omit `start_branch` for an existing target; supply `start_branch`
  as the base when GitLab should create the target branch as part of the file
  mutation. `update_file` and `delete_file` still require the current file
  `last_commit_id`.
- `list_branches`, `create_branch`
- `delete_branch` for exact reviewed branch cleanup; it requires a full
  `expected_head_sha` and explicit `acknowledge_branch_deletion: true`,
  rechecks immediately before GitLab's name-based delete, and verifies absence
  afterward. GitLab exposes no atomic conditional branch deletion, so ambiguous
  outcomes fail closed for reconciliation.
- `list_commits`, `get_commit`, `list_commit_diffs`, `compare_refs`
- `revert_commit` to undo one complete reviewed commit through GitLab's native
  revert endpoint. It guards the reviewed target head, proves the commit is in
  that reviewed history, runs GitLab's native dry-run, rechecks immediately
  before mutation, and verifies the resulting
  parent and branch pointer. Use its `dry_run` mode when only validation is
  wanted
- `cherry_pick_commit` to replay one reviewed non-merge commit through GitLab's
  native cherry-pick endpoint. It guards the reviewed target head, validates the
  source commit, runs GitLab's native dry-run, rechecks before mutation, and
  verifies the resulting parent and branch pointer. Merge commits are rejected
  because the API has no explicit mainline selector; use local Git when an
  explicit merge-parent choice is required
- `apply_repository_hunks` for exact, server-side search/replace edits guarded
  by the reviewed branch head and optional blob SHA; use `dry_run` to validate
  contexts without committing
- `create_commit` for non-destructive create, update, move, or chmod actions
- `create_destructive_commit` for file deletion or forced commit updates;
  requires a reviewed `start_sha`; non-force update/move actions and all delete
  actions require the reviewed file `last_commit_id`. With `force=true`,
  update/move may omit that file guard because the operation intentionally
  replaces history from the reviewed `start_sha`

Prefer local `git` for an existing checkout. Use repository-write tools only
when the user wants a direct remote edit or no checkout is available.

## Issues

- `list_global_issues`, `list_issues`, `get_issue`, `create_issue`,
  `update_issue`
- `list_issue_notes`, `create_issue_note`, `update_issue_note`,
  `delete_issue_note`
- `list_issue_reactions`, `add_issue_reaction`, `remove_issue_reaction`; pass
  `note_id` for a comment

## Merge requests and review

- `list_merge_requests`, `get_merge_request`, `create_merge_request`,
  `update_merge_request`, `merge_merge_request`
- `get_merge_request_approvals`, `approve_merge_request`,
  `unapprove_merge_request`
- `list_merge_request_diffs`, `get_merge_request_file_patch`,
  `list_merge_request_commits`, `list_merge_request_pipelines`
- `list_merge_request_discussions`, `create_merge_request_discussion`,
  `reply_merge_request_discussion`, `resolve_merge_request_discussion`
- `update_merge_request_note`, `delete_merge_request_note`
- `list_merge_request_reactions`, `add_merge_request_reaction`,
  `remove_merge_request_reaction`; pass `note_id` for a discussion note

Use discussions rather than flat comments when inline position and resolution
state matter. Before `approve_merge_request` or `merge_merge_request`, re-read
the merge request and pass its exact full 40-character current head SHA as
`sha`; if that head differs from the reviewed version, review the new head
before retrying the mutation.

## Pipelines, jobs, and statuses

- `list_pipelines`, `create_pipeline`, `get_latest_pipeline`, `get_pipeline`,
  `get_pipeline_test_report`, `get_pipeline_test_report_summary`,
  `list_pipeline_bridges`, `retry_pipeline`, `cancel_pipeline`
- `list_pipeline_jobs`, `list_project_jobs`, `get_job`, `get_job_log`,
  `get_job_artifact_file`, `get_job_artifact_archive`
- `commit_job_artifact_file` to promote one bounded same-instance job artifact
  directly into a guarded repository create/update commit without returning the
  artifact contents through MCP
- `retry_job`, `cancel_job`, `play_job`
- `list_commit_statuses`, `create_commit_status`
- `list_project_runners` for runner availability without authentication tokens
- `lint_ci_configuration` for project-context CI YAML validation
- `list_pipeline_schedules`, `get_pipeline_schedule`
- `create_pipeline_schedule`, `update_pipeline_schedule`,
  `delete_pipeline_schedule`, `run_pipeline_schedule`,
  `take_ownership_pipeline_schedule`
- `create_pipeline_schedule_variable`, `update_pipeline_schedule_variable`,
  `delete_pipeline_schedule_variable`

Logs and artifact responses are bounded to reduce accidental bulk disclosure.
For `retry_pipeline`, response loss, HTTP 408, HTTP 409, and 5xx failures are
mutation-ambiguous: GitLab can create retry jobs before returning 409. Re-read
the pipeline and `list_pipeline_jobs` with `include_retried: true` before any
further retry; do not infer attribution from postflight state alone.
Schedule inspection and variable mutations omit variable values. Schedule
updates may change the target branch or tag; use a fully-qualified ref when a
short branch/tag name is ambiguous.

## Governance and releases

- `list_protected_branches`, `get_protected_branch`
- `protect_branch`, `update_protected_branch`, `unprotect_branch` (mutations
  require capability/read preflights and explicit acknowledgement; creation
  requires an explicit unprotect rule, while updates address existing access
  records by `id` and delete them with `_destroy: true`)
- `list_project_approval_rules`, `get_project_approval_rule`,
  `create_project_approval_rule`, `update_project_approval_rule`,
  `delete_project_approval_rule` (mutations preflight and require explicit
  acknowledgement)
- `list_tags`, `get_tag`, `create_tag`, `delete_tag`
- `list_releases`, `get_release`, `create_release`, `update_release`,
  `delete_release`
- `list_release_asset_links`, `get_release_asset_link`,
  `create_release_asset_link`, `update_release_asset_link`,
  `delete_release_asset_link`

Use `get_gitlab_capabilities` with `project` when permissions, licensing, or
server support for these project-scoped features is uncertain. Governance
mutations also perform a bounded read preflight immediately before writing.
Inspect policy before proposing changes. Tag, release, and schedule mutations
require explicit user intent. Deleting a Release preserves its tag, but deleting
a tag that has an associated Release also deletes that Release. `delete_tag`
preflights the exact tag and requires
`acknowledge_associated_release_deletion: true` when GitLab reports that
collateral Release. GitLab's tag DELETE is not atomic with that preflight, so
postflight ambiguity must be reconciled rather than retried blindly.

## Safety

Tool annotations distinguish read-only, write, and destructive operations.
Always resolve the exact project and object before a write. Deletion, merge,
approval, discussion resolution, and CI state changes require explicit user
intent.
