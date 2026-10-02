# Independent review pass

Use this as a top-level MR discussion for each formal clean review. A pass is independent
only when its conclusion is reconstructed from current evidence instead of accepting earlier
review conclusions as premises. Leave a counted REVIEW_PASS discussion unresolved and do not
edit it or add replies while convergence is carrying it.

## Independent review pass N/3

Stable contract reviewed: issue #... + MR !... objective/scope/constraints/acceptance criteria

Previous counted pass: <none for pass 1 | note/discussion ID + created_at/updated_at>

Carried REVIEW_PASS set before this pass: <none for pass 1 | every counted discussion/note ID + created_at/updated_at>

Previous snapshot continuity: <not applicable | current MR head + target branch + target tip match previous counted pass>

Frozen title/description + target-branch continuity across carried count: <not applicable | established from current issue/MR history since earliest carried REVIEW_PASS>

Carried REVIEW_PASS integrity: <not applicable | every carried original note present/unedited; no replies; resolution state unchanged>

Reviewed exact head: <full SHA>

Target branch/tip: <branch> @ <full SHA>

Target-only divergence at review time: 0 (target tip is an ancestor of MR head)

Pipeline at review time: #... — <status>

Primary lens: <contract/correctness | failure/adversarial | integration>

### Cold-start evidence

Re-read from current GitLab state:

- authoritative stable issue/MR contract: objective, scope, constraints, and acceptance
  criteria;
- confirmation that issue/MR title and description were finalized before pass 1/3 and remain
  frozen during counted convergence; any title/description edit resets convergence regardless
  of intent;
- for pass 2/3 or 3/3, comparison of the current MR head, target branch, and target tip with
  the previous counted pass, issue/MR title/description and target-branch history since the
  earliest carried counted pass, and the complete set of earlier counted REVIEW_PASS discussion
  states contributing to the carried count; any snapshot mismatch, missing carried pass,
  title/description or target-branch edit, edited
  original note, added reply, changed resolution state, or incomplete/ambiguous evidence
  resets convergence;
- exact MR head, current target branch identity, target tip/target-only divergence, complete final diff/merge context,
  and changed files;
- current discussions and unresolved threads;
- exact-head pipeline/jobs and relevant main-authoritative quality state;
- dependencies, deployment/runtime state, and other blockers when material.

Prior review comments may be used to locate historical context, but their conclusions were
not accepted as evidence that the current implementation is correct. A green pipeline was
treated as supporting evidence, not proof. The implementation was treated as competent, so
the pass deliberately sought subtle interactions and failure modes rather than assuming
obvious-path checks were sufficient.

### Review scope

Independently examined:

- material callers, callees, types, tests, configuration, failure paths, generated state,
  and adjacent subsystems needed to re-establish the changed contracts;
- relevant API/behavior contracts and compatibility;
- correctness and edge cases;
- safety/privacy/security/concurrency/resource implications;
- regression coverage;
- architecture/dependency boundaries;
- CI/security/release impact;
- documentation/operational implications;
- current unresolved discussions.

### Distinct falsification work

Primary defect classes deliberately targeted in this pass:

- ...
- ...

New failure hypotheses or interactions tested/reasoned through:

- ...
- ...

This pass did not merely repeat the route or conclusions of an earlier clean pass.

### Findings

**Actionable findings:** 0

If findings exist, this is not a clean pass. Fix them and reset review convergence to 0/3.
After any code, test, documentation, generated-state, or behavior-affecting correction,
start clean-pass counting again from the resulting exact head.

### Clean-pass integrity

- [ ] No repository content or behavior-affecting state was changed during this pass.
- [ ] The authoritative stable issue/MR contract did not change during this pass.
- [ ] No issue/MR title or description edit occurred during counted convergence.
- [ ] For pass 2/3 or 3/3, the current MR head+target branch+target tip match the previous counted snapshot, current history since the earliest carried counted pass shows no title/description or target-branch edit, and every earlier counted REVIEW_PASS discussion contributing to the carried count remains frozen: each original note is present with `created_at == updated_at`, no replies were added, and resolution state is unchanged; no carried pass or evidence is missing.
- [ ] Neither the MR head, target branch identity, nor target tip changed while this pass was being evaluated.
- [ ] Target-only divergence remained zero for the recorded review snapshot (target tip remained an ancestor of MR head).
- [ ] The conclusion follows from current evidence gathered in this pass.

### Conclusion

This is clean pass **N/3** for exact head <SHA>.

The pass becomes invalid if the authoritative stable issue/MR contract, issue/MR title or
description, MR head, target branch identity, or target tip changes. Every counted REVIEW_PASS discussion is
frozen evidence for as long as it contributes to the carried convergence count: do not edit
its original note, add replies, or change its resolution state. To correct/invalidate one,
append a reply and reset convergence.
