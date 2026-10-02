# Agent checkpoint

Use this as a top-level issue or merge-request comment when a work session pauses or ownership changes.

## Agent checkpoint — YYYY-MM-DD HH:MM UTC

### Verified authoritative state

- main: <full SHA>
- Working issue: #...
- Working MR: !...
- MR head: <full SHA>
- MR target: <branch>
- MR target tip: <full SHA>
- Target-only divergence: <count of target-branch commits not present in MR head>
- Stable issue/MR contract changed since clean-pass snapshot: yes/no
- Exact-head pipeline: #... — <status>
- Relevant main pipeline: #... — <status>
- Relevant Sonar/security/external state:
- Deployment/runtime:
- Connector/registration state:

### Completed since previous checkpoint

- ...

### Current findings

- ...

### Changes made

- ...

### Validation completed

- ...

### Review convergence

- Current count: N/3
- Valid for snapshot: stable issue/MR contract + head <full SHA> + target <branch> @ <full SHA>
- Previous counted REVIEW_PASS: <note/discussion ID + created_at/updated_at | none>
- Carried REVIEW_PASS set: <every counted discussion/note ID + created_at/updated_at | none>
- MR head+target-branch+target-tip continuity with carried snapshot: yes/no/not-applicable (must be yes for any nonzero carried clean-pass count; not-applicable only at 0/3)
- Issue/MR title+description + target-branch freeze intact across carried count: yes/no/not-applicable (verify current history since the earliest carried REVIEW_PASS; must be yes for any nonzero carried clean-pass count; not-applicable only at 0/3)
- Every carried REVIEW_PASS discussion frozen (original note present/unedited, no replies, resolution state unchanged): yes/no/not-applicable (must be yes for any nonzero carried clean-pass count; not-applicable only at 0/3)
- Stable contract unchanged for carried count: yes/no (must be yes for any carried clean-pass count)
- Target-only divergence at checkpoint: <count> (must be 0 for any carried clean-pass count; target tip must be an ancestor of MR head)
- Last clean-pass scope:
- Count reset required: yes/no
- Reason if reset:

### Open blockers / dependencies

- ...

### Next valid action

1. ...

### Do not assume

- ...

This checkpoint records verified state only. A later agent must re-read current GitLab state before mutation instead of assuming the checkpoint is still current.
