# Release-train milestone template

Use this structure in a GitLab milestone description when several compatible changes should land before an expensive deployment/runtime refresh.

# <Train name>

## Goal

Deliver a coherent set of compatible changes before the next deployment/runtime refresh.

## Deployment budget

Expected production deployments for this train: **1**

Additional deployments require an explicit reason recorded in the milestone or a blocking issue.

## Entry criteria

Work may enter when:

- it is required by dogfooding or a directly related operational gap;
- scope is sufficiently bounded;
- it can be validated at repository/MR level before deployment;
- inclusion does not materially increase deployment risk.

## Included work

| Issue | MR   | Type | Dependency | Repository state | Runtime required |
| ----- | ---- | ---- | ---------- | ---------------- | ---------------- |
| #...  | !... | ...  | ...        | ...              | yes/no           |

## Explicitly excluded / deferred

| Issue | Reason |
| ----- | ------ |
| #...  | ...    |

## Intended merge order

1. ...
2. ...
3. ...

Rationale:

...

## Train invariants

- Every MR independently satisfies repository quality requirements.
- Nothing is merged merely to reduce deployment count.
- No CI/security/Sonar/release gate is weakened.
- Three-clean-pass review convergence remains per MR.
- Post-merge main regressions stop the train.
- Runtime-dependent acceptance is not marked complete before runtime verification.

## Pre-deployment exit criteria

- [ ] Intended train MRs are merged.
- [ ] Main repository-validation pipeline is green; the optional manual `deploy_production` job has not been treated as a prerequisite.
- [ ] Main-authoritative Sonar state is green.
- [ ] No train issue has an untracked repository-level acceptance gap.
- [ ] Canonical runtime/tool surface is frozen for deployment.
- [ ] Exact deployment source SHA is selected.
- [ ] Rollback target is known.

## Deployment acceptance

- [ ] Exact SHA deployed.
- [ ] Runtime build identity verified.
- [ ] Health/readiness verified.
- [ ] Source/runtime parity verified.
- [ ] External connector registration refreshed if necessary.
- [ ] Fresh-session surface verified.
- [ ] Representative dogfooding acceptance checks pass.

## Train closure

Close the milestone only after required repository and runtime state agree.
