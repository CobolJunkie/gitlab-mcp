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
- `search_gitlab` for global, group, or project search
- `list_global_issues` for account-wide recent issue triage
- `search_projects`
- `get_project`
- `list_project_members`, `get_project_member`
- `list_project_labels`

## Repository and commits

- `list_repository_tree`
- `search_code`
- `get_blob`, `get_file`
- `fetch_gitlab_file_url` for same-instance blob, raw, or API file URLs
- `download_gitlab_attachment`
- `create_file`, `update_file`, `delete_file`
- `list_branches`, `create_branch`, `delete_branch`
- `list_commits`, `get_commit`, `list_commit_diffs`, `compare_refs`
- `create_commit` for non-destructive create, update, move, or chmod actions
- `create_destructive_commit` for file deletion or forced commit updates;
  requires a reviewed `start_sha`, and delete actions require `last_commit_id`

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
state matter.

## Pipelines, jobs, and statuses

- `list_pipelines`, `create_pipeline`, `get_latest_pipeline`, `get_pipeline`,
  `get_pipeline_test_report`, `get_pipeline_test_report_summary`,
  `list_pipeline_bridges`, `retry_pipeline`, `cancel_pipeline`
- `list_pipeline_jobs`, `list_project_jobs`, `get_job`, `get_job_log`,
  `get_job_artifact_file`, `get_job_artifact_archive`
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
Schedule inspection and variable mutations omit variable values.

## Governance and releases

- `list_protected_branches`, `get_protected_branch`
- `protect_branch`, `update_protected_branch`, `unprotect_branch` (mutations
  require a capability read preflight, explicit acknowledgement, and an
  explicit unprotect rule)
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
require explicit user intent; tag and release deletions are separate actions.

## Safety

Tool annotations distinguish read-only, write, and destructive operations.
Always resolve the exact project and object before a write. Deletion, merge,
approval, discussion resolution, and CI state changes require explicit user
intent.
