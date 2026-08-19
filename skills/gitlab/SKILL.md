---
name: gitlab
description: Triage and handle GitLab project, repository, issue, merge request, review, CI/CD, label, reaction, file, branch, and commit work through the bundled GitLab MCP server. Use when the user asks for general GitLab help, wants issue or merge-request summaries, needs repository context, or needs a GitLab operation that is not already routed to a narrower workflow skill.
---

# GitLab

Use the bundled GitLab MCP tools as the primary interface to GitLab. Use local
`git` for an existing checkout and use `glab` only as a narrow fallback when it
is installed and the MCP surface does not cover the operation.

Read [references/tool-routing.md](references/tool-routing.md) before selecting
tools.

## Resolve the project

1. Prefer an explicit GitLab project URL, project ID, or `namespace/project`
   path from the user.
2. For a local checkout, inspect `git remote -v` and normalize SSH or HTTPS
   remotes to a GitLab project path.
3. If the project is still ambiguous, use `search_projects`.
4. Respect `GITLAB_URL` for self-managed or dedicated GitLab instances. Do not
   assume GitLab.com.

## Route specialized workflows

- For unresolved merge-request feedback, use the sibling
  `gl-address-comments` skill.
- For failed merge-request pipelines, use the sibling `gl-fix-ci` skill.
- For committing, pushing, and opening a draft merge request, use the sibling
  `gl-publish` skill.

## General workflow

1. Use `get_gitlab_capabilities` when availability, version, licensing,
   permissions, token scope, or instance configuration may explain an outcome.
2. Read the current GitLab state before proposing or making a change.
3. Use the smallest tool that provides the required data.
4. Summarize relevant findings, including project, issue, merge request,
   branch, pipeline, or job identifiers.
5. If the user requested a change, make only the scoped change and then read
   back the resulting state when practical.
6. Report links or stable identifiers so the user can verify the result.

## Write safety

- Treat tools marked read-only as safe inspection.
- Before a write, confirm the target project and object from the conversation
  and current state.
- Do not delete branches, files, comments, or other objects unless deletion is
  explicitly requested.
- Do not merge a merge request, retry or cancel CI, approve a merge request, or
  resolve review discussions unless the user asked for that outcome.
- Never expose access tokens, job tokens, private variables, or unredacted
  secrets from logs.

## Output

Lead with the outcome or most important finding. Keep routine tool narration
brief. For changes, state what changed and include the GitLab URL or object ID.
