# Testing

GitLab MCP uses layered validation so fast deterministic checks run on every change while live GitLab mutation remains isolated to explicitly disposable fixtures.

## Local contributor checks

For ordinary source changes, run the same core checks used by CI:

```sh
npm run check
npm run lint
npm run format:check
npm run deps:check
npm test
npm run test:coverage
```

Changes that affect packaging, adapters, or release behavior should also run:

```sh
npm run adapters:check
npm run check:versions
npm run check:bundle
npm run build
npm run smoke
npm run validate:harnesses
npm run release:validate
```

The coverage gate includes `server/src`, `shared`, `adapters`, reusable modules under `scripts/lib`, and the directly instrumented top-level operational modules classified below. Current repository thresholds remain 90% lines, 80% functions, and 75% branches.

### Operational script coverage policy

Top-level files under `scripts/` are executable entry points, probes, integration runners, or packaging wrappers. Coverage is intentional rather than directory-wide: substantive reusable logic belongs under `scripts/lib/**` and is always instrumented, while the self-contained streamed production deployer is instrumented directly because moving it behind an import would break the SSH deployment contract.

| Classification                                                      | Files                                                                                                                                                             | Coverage rationale                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production deployment state machine                                 | `scripts/deploy-production.mjs`                                                                                                                                   | Directly instrumented. Deterministic tests cover candidate failure before production mutation, promotion, rollback recovery, already-current validation, credential-file cleanup, and retention helpers without a Docker daemon or production credentials.                      |
| Security/deployment validation modules                              | `check-gitlab-oauth.mjs`, `check-mcp-candidate.mjs`, `check-mcp-deployment.mjs`, `check-mcp-runtime.mjs`, `check-mcp-surface-parity.mjs`, `docker-entrypoint.mjs` | Directly instrumented because their exported audit/runtime/container logic is already exercised by deterministic tests. Their small direct-execution shells remain boundary behavior around the tested functions.                                                               |
| Release/package helpers                                             | `deterministic-git-archive.mjs`, `harness-package-validation.mjs`                                                                                                 | Directly instrumented because they contain reusable release-critical logic with deterministic tests.                                                                                                                                                                            |
| Disposable integration report logic                                 | `scripts/integration-report.mjs`                                                                                                                                  | Directly instrumented. Its bounded/sanitized report helpers are reusable logic with deterministic unit coverage; only the environment-facing disposable integration runner remains excluded.                                                                                    |
| Reusable operational logic                                          | `scripts/lib/**/*.mjs`                                                                                                                                            | Directly instrumented. Shared benchmark, release, security-gate, packaging, formatting, and MCP-probe logic belongs here rather than in CLI wrappers.                                                                                                                           |
| Build, release, adapter, formatting, and security-gate entry points | `adapters-generate.mjs`, `build.mjs`, `capture-formatting-fix-artifacts.mjs`, `release-validate.mjs`, `smoke-extracted-bundle.mjs`, and `validate-*.mjs`          | Explicit Sonar coverage exclusions. They are orchestration/CLI surfaces whose substantive reusable logic is covered in `scripts/lib` or adapter modules and whose end-to-end behavior is exercised by blocking build, adapter, release, SAST, secret-detection, and smoke jobs. |
| Benchmark entry points                                              | `benchmark-surface.mjs`, `benchmark-workload.mjs`, `benchmark-workload-live.mjs`, `promote-workload-baseline.mjs`                                                 | Explicit Sonar coverage exclusions. Deterministic benchmark semantics live in covered `scripts/lib` modules; the live runner additionally requires protected disposable-fixture execution.                                                                                      |
| Thin deployment/runtime boundary wrappers                           | `docker-smoke.mjs`, `smoke-bundle.mjs`                                                                                                                            | Explicit Sonar coverage exclusions. These are environment-facing smoke wrappers exercised at their real boundary; reusable distribution logic is in directly covered modules.                                                                                                   |
| Live integration harness                                            | `integration-disposable.mjs`, `integration-smoke.mjs`                                                                                                             | Explicit Sonar coverage exclusions. `integration-smoke.mjs` is a read-only configured-project probe; `integration-disposable.mjs` mutates only after verifying the dedicated disposable fixture. Neither file is production application logic.                                  |

`test/coverage-scope.test.mjs` enforces that `scripts` remains in Sonar source analysis, that operational scripts are not source-excluded, and that every top-level `scripts/*.mjs` file is either directly included in Node coverage or named in Sonar's coverage exclusions. Adding a new operational entry point therefore requires an explicit coverage decision instead of silently disappearing from analysis or appearing as 0% in Sonar.

CI keeps ordinary local `npm test` behavior unchanged. The Node 22/24 matrix instead runs `npm run test:ci`, which executes the same `node:test` suite once with the human-readable `spec` reporter on stdout and the built-in `junit` reporter at `artifacts/test-results/junit.xml` for GitLab's Tests UI. The JUnit file is a report artifact only; it is not also published as a normal downloadable artifact archive.

## Disposable GitLab integration

Live mutation tests must never target a production or user-owned project. `npm run test:integration:disposable` requires the dedicated disposable integration variables documented in `CONFIGURATION.md` and validates the target before mutation. The integration harness must leave the fixture project in its declared final state and fail closed when target verification or cleanup cannot be proven.

## BENCH-02 synthetic workload

`benchmarks/workload-scenarios.mjs` is the versioned source of truth for the synthetic GitLab workload. Validate it without contacting GitLab with:

```sh
npm run benchmark:workload:check
```

The deterministic unit suite covers manifest contracts, report safety, metric derivation, execution/repetition semantics, fixture ownership, repeated-run statistics, live-session behavior, handler registration, and protected-CI rules. These tests belong in ordinary CI and must not depend on latency thresholds or external credentials.

Use the live runner only with a positively verified disposable project. For a
local run, obtain the full SHA of the exact clean checkout first:

```sh
git rev-parse HEAD
```

Replace `FULL_COMMIT_SHA` with that 40-character value when invoking the live
runner:

```sh
npm run benchmark:workload:live -- --mode=correctness --commit-sha=FULL_COMMIT_SHA
npm run benchmark:workload:live -- --mode=benchmark --commit-sha=FULL_COMMIT_SHA
```

Do not benchmark dirty or uncommitted code while attributing the report to that
SHA. CI supplies `CI_COMMIT_SHA` automatically; local runs require the explicit
value to keep benchmark provenance fail-closed.

Correctness mode executes deterministic safe scenarios once and excludes destructive scenarios. Benchmark mode follows each scenario's versioned warm-up and repetition profile. Fixture preparation, warm-ups, final-state verification, and cleanup are outside the measured wall-clock window; only the requested MCP workflow is measured.

A diagnostic subset may be selected with `BENCHMARK_WORKLOAD_SCENARIOS` or `--scenarios=...`. Subsets are for diagnosis only and must not be promoted as the canonical `all`-surface baseline.

## Protected benchmark CI runbook

The protected benchmark job is defined in `.gitlab/benchmark-workload.yml`. It is intentionally absent from merge-request pipelines. To execute it, use a protected ref with protected disposable credentials and set `BENCHMARK_WORKLOAD=true` in either a manual/web pipeline or a protected schedule. The default mode is `benchmark`; set `BENCHMARK_WORKLOAD_MODE=correctness` only when validating workflow correctness.

Before accepting a run, verify all of the following:

1. The job ran from the intended protected commit and disposable fixture configuration.
2. Every selected scenario succeeded, final-state checks passed, and no forbidden side effects were reported.
3. Cleanup/finalization succeeded; no benchmark-owned issue, branch, merge request, tag, release, pipeline fixture, or other temporary state remains unexpectedly.
4. The report contains the commit SHA, server version, workload version, fixture configuration id, mode, per-scenario repetition metadata, Metric Contract v1 provenance, and CI execution provenance.
5. The JSON and Markdown artifacts contain no credentials or production payloads.

The job stores `benchmark-results/workload-report.json` and `benchmark-results/workload-report.md` for 30 days. A failed, partial, diagnostic-subset, or unprotected run must never be promoted as the repository baseline.

## Baseline review and promotion

The BENCH-02 baseline represents the current canonical `all` tool surface executing the full versioned workload against the controlled disposable GitLab fixture. Baseline promotion is deliberately separate from benchmark execution so a transient or failed CI artifact cannot silently rewrite repository history.

After reviewing a successful protected full-workload benchmark artifact, use the optional manual `promote_workload_baseline` job from that same protected benchmark pipeline. The job consumes the benchmark artifact and runs:

```sh
npm run benchmark:workload:promote -- --report=benchmark-results/workload-report.json
```

For an equivalent local promotion, check out the exact report commit with no tracked modifications before running the same command. Promotion rejects a report whose commit differs from checkout `HEAD` or whose checkout has tracked changes, so an older protected artifact cannot be relabeled as evidence for newer benchmark code.

The promotion validator also fails closed unless the report is benchmark mode, comes from a protected scheduled or manual/web pipeline, covers every canonical scenario exactly, has zero scenario/safety/final-state failures, and records each scenario's declared warm-up/repetition profile. The generated `benchmarks/workload-baseline.json` records the canonical `all` surface tool count and `definitionFingerprint` from `benchmarks/surface-baseline.json`, preventing later optimization work from silently comparing a workload baseline against a different tool surface.

Review the generated baseline diff before committing it. The promoted baseline is comparison evidence, not a latency SLO: BENCH-02 does not make CI pass or fail on timing values.

See `BENCHMARKING.md` for metric definitions, report semantics, and baseline provenance rules.

## Failure triage

Treat deterministic failures as product/test defects until isolated. Formatting, lint, dependency-boundary, security, unit-test, coverage, adapter, smoke, and release-validation failures are blocking unless explicitly documented otherwise. Benchmark latency variation alone is not a correctness failure.

If a live benchmark fails during fixture setup or cleanup, inspect the disposable project before retrying. Cleanup is designed to be bounded and idempotent, but repeated execution must still positively verify the intended disposable target rather than assuming ownership from names alone.
