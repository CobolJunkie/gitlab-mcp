---
name: gl-address-comments
description: Inspect unresolved GitLab merge-request review discussions, identify actionable feedback, implement selected fixes in the local checkout, verify them, and optionally reply to or resolve discussions. Use when the user asks to address review comments, requested changes, unresolved threads, or inline feedback on a GitLab merge request.
---

# Address GitLab Merge Request Comments

Use the bundled GitLab MCP tools for merge-request metadata, diffs, and
thread-aware discussions. Use local `git` for code changes and verification.

## Workflow

1. Resolve the project and merge-request IID from the request, GitLab URL, or
   the current checkout.
2. Call `get_merge_request`, `list_merge_request_diffs`, and
   `list_merge_request_discussions`.
3. Focus on unresolved discussions and classify each as:
   - actionable code or documentation work;
   - a question needing a reply;
   - already addressed or obsolete;
   - unclear and requiring user direction.
4. Summarize the actionable threads with their discussion IDs, locations, and
   requested outcomes.
5. If the request includes implementation, edit only the agreed scope in the
   local checkout and run focused tests or checks.
6. Reinspect the diff and explain how each selected thread was addressed.
7. Reply with `reply_merge_request_discussion` or resolve with
   `resolve_merge_request_discussion` only when the user explicitly asked to
   post or resolve feedback.

## Guardrails

- Do not infer that a request to review comments authorizes posting replies,
  resolving threads, approving, merging, committing, or pushing.
- Preserve unrelated local changes.
- Do not resolve a discussion until its requested change is implemented and
  verified, or the reviewer explicitly accepts a non-code resolution.
- If an inline position no longer maps cleanly to the current diff, report that
  rather than guessing.
- Never include secrets or credentials in discussion replies.

## Output

Report fixed, pending, and non-actionable threads separately. Include focused
test results and call out any thread still requiring a human decision.
