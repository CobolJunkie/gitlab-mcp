---
name: gl-publish
description: Publish intentional local changes to GitLab by reviewing scope, creating or selecting a branch, committing, pushing, and opening a draft merge request through the bundled GitLab MCP tools. Use when the user asks to publish, push, ship, or open a GitLab merge request from local work.
---

# Publish Changes to GitLab

Use local `git` for checkout state, branches, staging, commits, and pushes. Use
the bundled GitLab MCP tools for project resolution and merge-request creation.
Use `glab` only as a fallback when it is installed and the MCP operation is
unavailable.

## Workflow

1. Inspect `git status --short`, the current branch, the configured remotes,
   and the full intended diff.
2. Confirm that the changed files match the user's requested scope. Preserve
   unrelated work and do not stage it.
3. If a new branch is needed, follow the repository's documented branch naming
   convention when one exists; otherwise use `gitlab/<short-description>`.
4. Run focused tests or checks appropriate to the change.
5. Stage only the intended files and review the staged diff.
6. Create one clear commit unless the user requested a different history.
7. Push the branch to the resolved GitLab remote.
8. Use `create_merge_request` to open a draft merge request with:
   - a concise title;
   - a summary of the change;
   - verification performed;
   - known limitations or follow-ups.
9. Read back the merge request and return its URL.

## Guardrails

- Do not include unrelated, generated, credential, or secret files.
- Do not rewrite history, force-push, delete branches, merge, or mark the merge
  request ready unless explicitly requested.
- Do not claim success until the push and merge-request creation both succeed.
- If tests fail, report the failure and stop before publishing unless the user
  explicitly directs otherwise.
- If the current branch already has unrelated commits, pause before building a
  merge request on top of them.

## Output

Return the branch, commit, tests, and draft merge-request URL. Clearly identify
anything not published.
