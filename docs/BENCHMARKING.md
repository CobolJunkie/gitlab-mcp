# Surface benchmarking

BENCH-01 establishes a deterministic baseline for the canonical MCP tool surface
before any future toolset reduction or progressive-disclosure work. BENCH-02
adds a reproducible workflow benchmark so optimization claims can be evaluated
against real GitLab task behavior instead of schema size alone.

## Surface baseline

The committed baseline is `benchmarks/surface-baseline.json`. It records the
canonical `all` surface, tool counts, serialized schema bytes, deterministic
estimated schema tokens, family breakdowns, largest tools, and a definition
fingerprint.

The baseline is intentionally generated from the same canonical server
registration source used by every harness adapter. Adapters must not maintain
independent tool surfaces.

Run:

```sh
npm run benchmark:surface:check
npm run benchmark:surface
```

The check command verifies the frozen historical baseline byte-for-byte,
anchors the full and read-only pre-toolset tool-name sets to SHA-256
fingerprints derived from the contract snapshot at the pinned baseline commit,
checks that current membership differs from those historical sets only by
explicitly approved additions, and validates the current surface snapshot
against the current canonical surface. It deliberately does not regenerate
historical schema metrics from today's definitions: an existing pre-baseline
tool may evolve while the historical artifact remains immutable. Those contract
changes belong only in `benchmarks/surface-current.json`. When refreshing
that current snapshot, its `source.commit` must be the exact clean code commit
whose canonical surface was measured; do not retain provenance from an older
surface.

The non-check command prints the current audit for review.

The token estimator is deliberately model-neutral: `ceil(canonical UTF-8
bytes / 4)`. Raw byte counts remain authoritative; the token count is only a
stable comparison aid.

## Synthetic workload benchmark

BENCH-02 defines `gitlab-mcp-synthetic-v1` in
`benchmarks/workload-scenarios.mjs`. The manifest currently contains 35
canonical tasks spanning all required workflow domains:

- project context/discovery;
- repository inspection;
- issues;
- merge-request review;
- merge-request mutation;
- CI diagnosis;
- CI operations;
- governance/configuration;
- release/deployment;
- failure/safety.

Scenarios describe fixture state/setup, the user goal, permitted and forbidden
effects, expected final state, cleanup, standard metrics, and an execution
profile. They deliberately do not prescribe an exact MCP tool sequence unless
the semantics require one.

Validate the manifest with:

```sh
npm run benchmark:workload:check
```

For a local live run, first obtain the full commit SHA of the exact clean
checkout being benchmarked:

```sh
git rev-parse HEAD
```

Then replace `FULL_COMMIT_SHA` below with that 40-character value:

```sh
npm run benchmark:workload:live -- --mode=correctness --commit-sha=FULL_COMMIT_SHA
npm run benchmark:workload:live -- --mode=benchmark --commit-sha=FULL_COMMIT_SHA
```

Do not attribute dirty or uncommitted code to that SHA. CI supplies
`CI_COMMIT_SHA` automatically, but local execution deliberately requires an
explicit full SHA so report provenance cannot silently describe a different
source tree.

Live execution also requires an explicitly approved disposable project and
token. The session positively verifies the target and default branch before any
mutation. Read workflows that need generated issues, branches, merge requests,
pipelines, releases, or deployments declare those fixture mutations explicitly
and clean them idempotently after the measured operation.

### Measurement model

The workload consumes Metric Contract v1 observability events and reports:

- wall-clock duration;
- MCP tool calls;
- GitLab logical requests and physical attempts;
- GitLab response bytes and MCP result bytes;
- presentation truncations;
- retries;
- cache hits/misses;
- admission rejections.

Derived metrics are GitLab API amplification, workflow API amplification, and
context amplification. Physical attempts are currently derived as logical
requests plus recorded retry attempts because Metric Contract v1 emits the
logical-request duration and retry counters separately.

Fixture preparation, warm-ups, final-state verification, cleanup, and final
fixture teardown are outside the measured wall-clock interval. Failed measured
operations preserve the time consumed before failure; cleanup time still stays
outside the measurement.

Repeated benchmark runs retain per-scenario samples and emit min, mean, median,
p95, and max summaries for every standard metric. No latency threshold is a
correctness gate in BENCH-02.

### Execution modes

Correctness mode runs deterministic safe scenarios once and excludes scenarios
whose execution profile opts out of correctness mode. Benchmark mode runs the
full manifest with versioned per-scenario warm-up/repetition profiles. Mutation
profiles have zero warm-ups so untracked fixture mutation cannot occur.

Repository blob search uses the dedicated `rateLimitedRead` profile with two
warm-ups and 20 measured repetitions. This keeps the canonical run below
GitLab's default authenticated search rate limit while reserving headroom for
the independent fallback query. The scenario deliberately does not repeat an
exhausted query set, so service-side rate limiting remains visible instead of
being hidden by benchmark retries.

The protected benchmark CI job is defined in
`.gitlab/benchmark-workload.yml`. It materializes only when
`BENCHMARK_WORKLOAD=true` and the pipeline is a schedule or manual/web pipeline
on a protected ref. Merge-request pipelines cannot materialize the job, so
protected disposable credentials are never exposed to MR code.

The job defaults to benchmark mode, validates disposable prerequisites before
invoking the runner, has a one-hour bound, and persists JSON and Markdown
reports for 30 days. Reports include commit, server/workload/fixture identity,
Metric Contract v1 and CI execution provenance without credentials, plus the
canonical `all`-surface tool count and definition fingerprint observed by the
benchmark process.

### Persisted all-surface baseline

A transient benchmark artifact is never promoted automatically. After a
successful protected full-workload run has been reviewed, play the manual
`promote_workload_baseline` job in that same protected pipeline. It consumes the
reviewed report artifact and runs:

```sh
npm run benchmark:workload:promote -- --report=benchmark-results/workload-report.json
```

The promotion command requires checkout `HEAD` to equal the report commit and
requires a clean tracked checkout before writing the baseline. This prevents a
stale protected artifact from being promoted after benchmark code has moved on.
Promotion also fails closed for partial workloads, failed scenarios, safety or
final-state violations, incorrect repetition profiles, unprotected refs,
pipeline sources other than protected schedule/manual-web execution, or a
report whose recorded `all`-surface tool count/fingerprint differs from
`benchmarks/surface-baseline.json`. The resulting
`benchmarks/workload-baseline.json` embeds that verified canonical `all`
surface identity. This binds workflow measurements to the exact registered
surface used for the comparison and prevents later SURF-01/SURF-02 work from
silently comparing against a different toolset.

The persisted workload baseline remains comparison evidence rather than a
latency SLO. Timing variation alone does not fail deterministic CI.
