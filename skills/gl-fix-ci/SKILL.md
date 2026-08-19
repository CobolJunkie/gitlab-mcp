---
name: gl-fix-ci
description: Diagnose and fix failing GitLab merge-request pipelines by inspecting pipeline and job state, bounded job logs, artifacts, and the local checkout, then verifying an approved code or CI configuration change. Use when the user asks why a GitLab pipeline failed, wants failed jobs investigated, or asks to fix GitLab CI/CD failures.
---

# Fix GitLab CI

Use the bundled GitLab MCP tools for pipeline, job, log, artifact, and commit
status inspection. Use local `git` for code changes and local verification.

## Workflow

1. Resolve the project and merge request, branch, commit SHA, pipeline ID, or
   job ID from the request and current checkout.
2. For a merge request, call `list_merge_request_pipelines`, then inspect the
   most relevant failed or running pipeline with `get_pipeline`.
3. Call `list_pipeline_jobs` and inspect failed, canceled, or blocked jobs.
4. Fetch only the relevant bounded log section with `get_job_log`. Retrieve a
   specific artifact file with `get_job_artifact_file` only when logs are
   insufficient.
5. Separate the first causal failure from downstream or canceled noise.
6. Explain the root cause with job names, failure evidence, and affected files.
7. If the user asked for a fix, make the smallest scoped change in the local
   checkout and run the closest practical local checks.
8. Recheck the resulting diff and report what should change in the next
   pipeline.

## Guardrails

- A diagnosis request does not authorize editing code or CI configuration.
- Do not retry, cancel, or play jobs or pipelines unless the user explicitly
  requested that state change.
- Do not print or preserve access tokens, masked variables, credentials, or
  secrets that appear in logs or artifacts.
- Avoid downloading broad artifact archives; request only a named file.
- Do not claim the remote pipeline is fixed until a new pipeline verifies it.

## Output

Lead with the root cause. Distinguish observed remote evidence, local changes,
local verification, and any remaining remote verification step.
