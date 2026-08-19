# Task cookbook

Replace `group/project`, issue IDs, merge request IIDs, job IDs, and branch
names with real values. Add “do not make changes” when you want analysis only.
These workflows use the canonical GitLab MCP tool surface and are not tied to a
specific supported harness.

## Discover and orient

```text
Use GitLab to identify the connected account, instance type, server version
when visible, token scopes when visible, and project capabilities for
group/project.
```

```text
Find projects matching "payments" that I can access. Return the namespace,
visibility, default branch, and last activity for at most ten results.
```

```text
Summarize group/subgroup: its direct projects, inherited membership, and the
projects updated this week.
```

## Inspect repositories

```text
Show the repository tree under src/ at main, then identify likely entry points.
```

```text
Search group/project for uses of LegacyClient. Summarize each match with its
file path and why it matters.
```

```text
Compare release/1.2 with main. Group changes by feature, fix, dependency, and
risk. Do not modify GitLab.
```

```text
Read README.md from this GitLab URL and summarize only the installation steps.
```

## Triage issues

```text
List my open GitLab issues updated in the last seven days. Group them into
urgent, needs response, waiting, and informational.
```

```text
Review issue #17 in group/project, including notes. Extract the decision,
acceptance criteria, dependencies, and unanswered questions.
```

```text
Draft an issue for the bug described below. Show the final title, description,
labels, and acceptance criteria before creating it.
```

```text
Add a concise progress note to issue #17. Mention pipeline 123 and the
remaining blocker.
```

## Review merge requests

```text
Review !42 in group/project. Inspect metadata, commits, file diffs, approvals,
unresolved discussions, and pipeline state. Lead with correctness and security
risks.
```

```text
Use $gl-address-comments on !42. Classify every unresolved discussion, fix the
actionable items locally, run focused tests, and leave threads unresolved until
I approve the replies.
```

```text
Show the exact patch for src/auth.mjs in !42 and explain behavior changes line
by line.
```

```text
Check whether !42 is safe to merge. Do not approve or merge it.
```

## Diagnose pipelines

```text
Use $gl-fix-ci on !42. Inspect failed jobs and bounded logs, identify the first
root cause, implement the smallest fix, and verify it locally.
```

```text
List runners available to group/project and explain whether pending jobs have
an eligible online runner. Do not return authentication data.
```

```text
Lint this CI configuration in the context of group/project. Return validity,
errors, warnings, and jobs, but not merged YAML.
```

```text
Download reports/test-results.xml from job 456 and summarize failed tests.
```

## Publish changes

```text
Use $gl-publish. Review the current diff, exclude unrelated files, create a
focused feature branch, run appropriate verification, commit once, push, and
open a draft merge request against main.
```

```text
Prepare !42 for merge: confirm discussions, approvals, conflicts, and the
latest pipeline. If and only if all checks pass, mark it ready. Do not merge.
```

```text
Merge !42 after confirming its head SHA and successful latest pipeline. Remove
the source branch.
```

## Governance and releases

```text
Inspect protected branch policy and project approval rules for group/project.
Explain gaps against a pipeline-gated two-reviewer workflow. Do not change
policy.
```

```text
List the latest ten tags and releases. Identify tags without releases and
releases without useful notes.
```

```text
Create annotated tag v1.2.0 from the verified main SHA, then create a release
using the approved notes below.
```

## Pipeline schedules

```text
List active and inactive schedules for group/project. Include ownership, ref,
cron, timezone, next run, and last pipeline; omit variable values.
```

```text
Create an inactive weekly schedule for main at 03:00 UTC. Do not run it.
```

```text
Update schedule 7 to add DEPLOY_ENV=staging, then confirm only the variable
name and type.
```

## Reactions and collaboration

```text
Add a thumbs-up reaction to the latest note on issue #17.
```

```text
Reply to discussion abc123 on !42 with the verification summary below, then
resolve it.
```
