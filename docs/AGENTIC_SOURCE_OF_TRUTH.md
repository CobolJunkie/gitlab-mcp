# GitLab as the agentic source of truth

GitLab is the durable execution ledger for development in this repository. Chat sessions, local worktrees, and agent scratchpads are transient. A fresh contributor or agent should be able to reconstruct the current task, verified state, and next valid action from GitLab without requiring earlier chat history.

## State ownership

| Information                                               | Authoritative GitLab surface                      |
| --------------------------------------------------------- | ------------------------------------------------- |
| Stable objective, scope, constraints, acceptance criteria | Issue or MR description                           |
| Classification and lifecycle state                        | Labels, issue/MR state, Draft state, milestone    |
| Chronological investigation and execution evidence        | Issue/MR comments and discussions                 |
| Implementation                                            | Branch commits and MR diff                        |
| Automated verification                                    | Exact pipeline/jobs/artifacts                     |
| Review convergence                                        | MR comments using the independent-review template |
| Cross-session handoff                                     | Agent-checkpoint comment                          |
| Architectural/scope decision or blocker                   | Decision/blocker comment                          |
| Deployment/release grouping                               | Milestone plus linked issues/MRs                  |
| Final reconciliation                                      | Closure-verification comment                      |

Do not maintain competing copies of the same state in multiple places. Descriptions hold the stable contract; comments hold changing execution history.

## Repository description templates

GitLab Community Edition supports repository description templates. This project uses:

- .gitlab/issue_templates/Default.md as the default issue/work-item description;
- specialized issue templates for features, bugs, quality/maintenance, benchmark/evaluation, and deployment/operations work;
- .gitlab/merge_request_templates/Default.md as the default MR description;
- Hotfix.md for narrowly scoped regression repairs.

Project-setting default description text is a Premium/Ultimate feature, so repository Default.md files are the portable default mechanism for this self-managed Community Edition instance.

The project currently auto-closes issues referenced with closing keywords. The default MR template therefore uses non-closing linkage. Use `Closes #...` only when merge itself satisfies every closure condition. If main-only, deployment, runtime, connector, or other post-merge acceptance remains, use `Related to #...` and close the issue only after the closure-verification record is complete.

## Native metadata contract

Use exactly one primary type when applicable:

- type::bug
- type::feature
- type::quality
- type::maintenance

Use one priority when prioritized:

- priority::P1
- priority::P2

Prefer scoped priority labels over legacy flat labels.

Use exactly one lifecycle status:

- status::ready
- status::in-progress
- status::in-review
- status::blocked
- status::done

Normal progression is:

ready → in-progress → in-review → done

Use blocked only while a concrete unblock condition is recorded. Reconcile closed issues to status::done; a closed issue left as in-progress or in-review is ambiguous machine state.

Apply one or more area::\* labels when they materially aid routing. Do not create new area labels for one-off categorization.

Use milestones for release trains, architectural programmes, or groups of issues sharing an exit condition. Do not use milestones as a replacement for labels.

## Agent execution protocol

Before any mutation:

1. Read current main.
2. Read the authoritative issue.
3. Read open/relevant merge requests.
4. Read relevant recent comments/discussions.
5. Verify MR head and divergence.
6. Verify current/exact-head pipelines.
7. Verify main-authoritative quality state when relevant.
8. Verify deployment/runtime state if the task crosses that boundary.
9. Verify dependencies/blockers.
10. Only then mutate.

For writes:

- use an existing branch when it already exists;
- use exact-head or optimistic-concurrency guards where available;
- never convert a failed existing-branch write into implicit branch creation;
- never force-push unless a separately reviewed workflow explicitly requires it;
- re-read state after an ambiguous mutation;
- preserve unrelated concurrent work.

During work:

- record meaningful checkpoints in GitLab rather than only in chat;
- open a scoped issue when dogfooding exposes a reusable missing capability;
- keep stable requirements in the description and changing evidence in comments;
- keep labels and milestone state synchronized with reality.

## Review convergence

The repository requires three consecutive independent clean reviews of one unchanged review
snapshot: the authoritative stable issue/MR contract (objective, scope, constraints, and
acceptance criteria), the exact MR head, the current target branch identity and tip, and the
complete final diff/merge context. Start clean-pass counting only when target-only divergence
is zero: the target tip is an ancestor of the MR head, so no target-branch commit is missing
from the source. This does not require the source to have zero commits ahead of the target. Any stable-contract change resets convergence to
**0/3** even when the Git SHAs are unchanged. Ordinary comments, discussion resolution, and
lifecycle metadata do not by themselves change the stable contract. A target-branch identity
change resets convergence to **0/3** and requires zero target-only divergence against the new target
before counting resumes. If the target tip advances on the same branch, update or rebase onto
the current target before continuing; the resulting MR head resets convergence to **0/3**.

Convergence continuity must be established between counted passes, not only within each pass.
Before pass 1/3, finalize the issue and MR title/description surfaces, including the MR
ready/draft title state when applicable. From the first counted pass until convergence is
accepted, those title/description surfaces are frozen: any edit resets convergence to
**0/3** regardless of whether the edit was intended as a checklist, wording, or lifecycle
change. Put mutable execution evidence in comments or native GitLab metadata instead.

Before pass 2/3 or 3/3, use the previous counted `REVIEW_PASS` comment as the head/target
continuity boundary and the earliest carried counted `REVIEW_PASS` as the history boundary for
issue/MR title/description and target-branch identity. First verify the current MR head, target
branch, and target tip exactly match the previous pass's recorded snapshot; then inspect current
issue and MR history since the earliest carried pass and verify there was no title, description,
or target-branch edit. Also enumerate
and verify **every** earlier counted `REVIEW_PASS` discussion
that contributes to the carried convergence count: each original note must still be present
with `created_at == updated_at`, no replies may have been added, and each discussion's
resolution state must be unchanged. If the snapshot, frozen surfaces, any carried review
evidence, or evidence-thread state changed, a carried pass is missing, or available history
is incomplete or ambiguous, reset to **0/3** rather than carrying the count. Counted
`REVIEW_PASS` discussions are frozen evidence for as long as they contribute to the carried
count: corrections are appended as replies and immediately invalidate/reset convergence.
Resolution changes on those counted evidence discussions also reset convergence because
GitLab mutates their note timestamps; resolution changes on other discussions, plus labels,
assignees, and other native lifecycle metadata, do not reset the count unless they alter the
defined stable contract.

An agent checkpoint may carry a nonzero clean-pass count only after revalidating, at
checkpoint time, the current stable contract, MR head, target branch identity, target tip/target-only divergence,
and frozen issue/MR title, description, and target-branch history across the full carried
interval (using the earliest carried counted pass as the history boundary), and every counted `REVIEW_PASS` discussion in the
carried set. This applies to **1/3** as well as larger counts. If any check fails or the evidence is
incomplete or ambiguous, record **0/3** and the reset reason rather than carrying stale
convergence state across the handoff.

Independence is procedural, not merely a repeated label. Each formal pass must cold-start
from current GitLab state and derive its conclusion from current evidence. Earlier review
comments are historical context; their clean verdicts, assumptions, and scope decisions are
not premises that a later pass may inherit.

Before each pass, re-read the authoritative issue/MR contract, exact head, current target
branch identity and tip/target-only divergence, complete final diff/merge context, current discussions, exact-head
pipeline/jobs, and relevant main-authoritative quality state. Re-establish material
surrounding contracts beyond the changed lines when needed:
callers/callees, types, tests, configuration, failure paths, generated state, adjacent
subsystems, deployment/runtime boundaries, and dependencies.

Green CI, coverage, security jobs, and Sonar are strong automated evidence, but none is
proof that the implementation is correct. Assume a competent implementation and actively try
to falsify it. As repository quality improves and obvious defect classes disappear, increase
attention to subtle cross-contract, failure-order, lifecycle, concurrency, resource, and
operational interactions rather than shortening or simplifying the review.

Use deliberately distinct primary lenses for the three consecutive passes:

1. **Contract/correctness** — behavior, API semantics, edge cases, compatibility, and
   acceptance-criteria completeness.
2. **Failure/adversarial** — security, privacy, concurrency, resources, error paths,
   destructive/ambiguous outcomes, and regression surfaces.
3. **Integration** — architecture, dependency boundaries, tests, CI/release behavior,
   documentation, operations, maintainability, and repository/runtime integration.

The primary lens changes the attack route, not responsibility: every pass still reports
obvious defects outside its lens and should seek defect classes missed by earlier passes.
A prior clean pass is a reason to shift or deepen the attack surface, not to reduce scrutiny.
Repeating the same checklist path or accepting an earlier pass's reasoning does not count as
independent convergence.

A clean pass must make no code, test, documentation, generated-state, or behavior-affecting
change. Any actionable finding or subsequent correction resets the count to **0/3** and
review restarts from the resulting exact head. A pass that produced a correction was useful,
but it was not clean.

The authoritative stable issue/MR contract, exact MR head, current target branch identity,
target tip/target-only divergence, final diff/merge context, current discussions, exact-head pipeline state, and
applicable main-authoritative quality evidence are authoritative for convergence. Read mutable head/pipeline state from those live GitLab
surfaces rather than copying it into the stable MR description. The MR description may
define required lenses and readiness criteria, but it is not a second convergence ledger.
Use docs/templates/REVIEW_PASS.md comments to record the exact per-pass snapshot, cold-start
evidence, distinct lens, falsification work, and zero-change integrity of each pass.

## Validation and merge

Before merge:

1. Confirm the authoritative stable issue/MR contract is unchanged from the clean-pass snapshot.
2. Confirm the exact final head, target branch identity, and zero target-only divergence from the current target tip.
3. Confirm issue acceptance criteria.
4. Confirm exact-head CI is green.
5. Re-read all current discussions.
6. Complete three consecutive independent clean reviews.
7. Resolve or explicitly transfer all actionable findings.
8. Merge according to repository policy and remove the source branch where appropriate.

After merge:

1. Identify the resulting main SHA.
2. Verify the required main pipeline.
3. Verify any main-only Sonar/quality gate.
4. Reconcile issue labels, issue state, and milestone.
5. Continue or close the release train as appropriate.
6. Do not mark runtime-dependent work complete before required deployment/runtime verification.

## Deployment boundary

Repository-complete and runtime-complete are distinct states.

A successful required main pipeline is the repository-authoritative validation
signal. Its blocking contract covers formatting, quality and dependency
boundaries, the Node test matrix, coverage and dependency audit, blocking
security gates, SonarQube when materialized, build, supported adapters, smoke
checks, Docker smoke, and release validation. Report-producing security
analyzers retain their existing non-blocking template semantics; their blocking
gate jobs carry the repository invariant. The protected `deploy_production`
job is an optional manual runtime transition and does not block repository
success. `test/release-pipeline-gates.test.mjs` guards this split mechanically.

When deployment is required, record and verify the deployment job plus runtime
acceptance separately; never infer runtime completion from a green repository
pipeline.

If deployment is operationally expensive, group compatible dogfooding-driven work in a milestone using docs/templates/RELEASE_TRAIN_MILESTONE.md. Every included MR still has to pass normal review and CI independently; deployment minimization is never a reason to merge unfinished work.

## Checkpoint and closure templates

Reusable comment bodies are stored under docs/templates/:

- AGENT_CHECKPOINT.md
- REVIEW_PASS.md
- DECISION_BLOCKER.md
- CLOSURE_VERIFICATION.md
- RELEASE_TRAIN_MILESTONE.md

Copy the relevant body into the authoritative issue/MR/milestone and fill it with current verified evidence.

## Commit messages

Use focused Conventional Commit-style branch commits:

<type>(<scope>): <imperative summary>

Preferred types are feat, fix, refactor, test, ci, docs, build, and chore.

Use Closes #... only on the MR/commit intended to close the issue. Intermediate commits should normally use Refs #... so GitLab closure state remains meaningful.
