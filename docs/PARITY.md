# GitHub Plugin Parity

Parity is measured by user-visible workflow, not by requiring GitLab to expose
GitHub-specific object models. The bundled GitHub plugin currently ships one
general skill and three specialist workflows; GitLab MCP provides the same
four-part interaction model through its canonical MCP core and shared Agent
Skills.

| GitHub plugin capability                     | GitLab implementation                                                                                                 | Status   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| Repository and account discovery             | current user, project search/details, members, labels                                                                 | Complete |
| Instance and credential capability discovery | version/metadata, identity, token scopes, normalized availability evidence                                            | Complete |
| Organization/installation discovery          | GitLab groups, group projects, inherited members, global/group/project search                                         | Complete |
| Code search and file inspection              | project blob search, repository tree, decoded file/blob fetch, same-instance file URLs                                | Complete |
| File, branch, and commit writes              | file CRUD, branch create/delete, multi-action commit                                                                  | Complete |
| Commit history and comparison                | commit list/detail, ref comparison with diffs                                                                         | Complete |
| Issue triage and mutation                    | project and account-wide filters/search, create/update/close/reopen, labels, assignees, milestones, locking           | Complete |
| Issue comments and reactions                 | note CRUD and issue/note award emoji list/add/remove                                                                  | Complete |
| Pull/merge request triage                    | MR filters/search, detail, create/update/close/reopen                                                                 | Complete |
| Draft and ready transitions                  | Draft-title creation and title-prefix fallback for API-compatible transitions                                         | Complete |
| Reviewers, approvals, and merge              | reviewer assignment, approve/unapprove, merge and auto-merge                                                          | Complete |
| Changed files and patches                    | paginated MR diffs, exact-path patch lookup, and commit list                                                          | Complete |
| Thread-aware code review                     | positioned discussions, replies, update/delete, resolve/reopen                                                        | Complete |
| Review reactions                             | MR/note award emoji list/add/remove                                                                                   | Complete |
| Workflow/pipeline diagnosis                  | MR pipelines, project pipelines, latest-by-ref lookup, test reports, bridge traversal, jobs, job detail, bounded logs | Complete |
| CI artifacts                                 | bounded retrieval of a named job artifact file                                                                        | Complete |
| Complete CI artifact download                | bounded job artifact ZIP retrieval                                                                                    | Complete |
| Private issue/MR uploads                     | same-instance bounded attachment retrieval                                                                            | Complete |
| Status checks                                | list and create external commit statuses                                                                              | Complete |
| CI control                                   | retry/cancel pipeline; retry/cancel/play job                                                                          | Complete |
| Address review comments workflow             | `$gl-address-comments`                                                                                                | Complete |
| Diagnose/fix CI workflow                     | `$gl-fix-ci`                                                                                                          | Complete |
| Commit/push/open draft PR workflow           | `$gl-publish` opens a draft MR                                                                                        | Complete |

## Platform-native equivalents

Some GitHub connector calls do not have a one-to-one GitLab object:

- GitHub App installations and organizations map to accessible GitLab projects,
  namespaces, and inherited project membership.
- GitHub raw blob/tree/ref assembly maps to GitLab's atomic multi-action commit
  API, which produces the same repository outcome with fewer intermediate
  objects.
- GitHub submitted reviews and review threads map to GitLab approvals and
  resolvable discussions.
- GitHub Actions workflow runs map to GitLab pipelines; jobs, traces, retries,
  cancellation, manual play, statuses, and artifacts remain available.

These are semantic equivalents rather than emulations of GitHub-only API
shapes.

## GitLab-native operator and release surface

| GitLab-native capability | Tools                                                                                                                                                      | Status                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Runner availability      | `list_project_runners`                                                                                                                                     | Complete; credentials are stripped                                                 |
| Project CI lint          | `lint_ci_configuration`                                                                                                                                    | Complete; merged YAML is omitted                                                   |
| Protected branch policy  | `list_protected_branches`, `get_protected_branch`, `protect_branch`, `update_protected_branch`, `unprotect_branch`                                         | Complete with read preflight and explicit acknowledgement                          |
| Protected tag policy     | `list_protected_tags`, `get_protected_tag`, `protect_tag`, `unprotect_tag`                                                                                 | Complete with capability preflight and explicit acknowledgement                    |
| Project approval policy  | `list_project_approval_rules`, `get_project_approval_rule`, `create_project_approval_rule`, `update_project_approval_rule`, `delete_project_approval_rule` | Complete where supported/licensed; mutations preflight and require acknowledgement |
| Repository tags          | `list_tags`, `get_tag`, `create_tag`, `delete_tag`                                                                                                         | Complete; tag deletion remains separate from release deletion                      |
| Releases                 | `list_releases`, `get_release`, `create_release`, `update_release`, `delete_release`                                                                       | Complete; asset links have independent CRUD                                        |
| Release asset links      | `list_release_asset_links`, `get_release_asset_link`, `create_release_asset_link`, `update_release_asset_link`, `delete_release_asset_link`                | Complete                                                                           |
| Pipeline schedules       | list/get/create/update/delete/run/take-ownership tools                                                                                                     | Complete; variable values are omitted from reads                                   |

Read and mutation tools remain separate. `get_gitlab_capabilities` accepts an
optional project and probes runner, governance, tag, release, and schedule
endpoints so permission, licensing, configuration, and unsupported outcomes
are reported from GitLab evidence rather than inferred.

## Evidence

- the MCP contract test enumerates every registered tool and checks critical
  annotations;
- a machine-readable mapping covers all 89 tools captured from the installed
  GitHub connector and fails if any mapped GitLab tool is absent;
- route tests verify representative GitLab REST paths and mutations;
- client tests cover URL normalization, authentication, pagination, error
  redaction, and response-size limits;
- HTTP tests cover health, OAuth protected-resource metadata, bearer challenges,
  per-tool security declarations, bearer validation, and DNS-rebinding
  configuration;
- every supported harness distribution validates its canonical MCP package and
  shared Agent Skills, while harness-specific manifest and launch validation
  remains inside the owning adapter.

Capability discovery is deliberately evidence-based. GitLab.com can be
identified from the exact configured host, while a non-GitLab.com host is
reported as `self_managed_or_dedicated` because the API does not reliably
distinguish those deployment models. Project-specific runner, governance,
release, and schedule availability is probed when a project is provided.
Advanced/Zoekt search, CI lint support without submitted YAML, and ambiguous
404 responses remain `unknown` unless GitLab returns unambiguous evidence.

## External publication gate

GitLab MCP can be installed locally through Codex, Claude Code, Cline, or Pi
after building and materializing the matching distribution. ChatGPT use
requires a public HTTPS deployment of `/mcp`, successful OAuth connection
testing in ChatGPT developer mode, and the technical app ID issued during
registration. Public marketplace review, if desired, is controlled by OpenAI
and is not an offline build step.
