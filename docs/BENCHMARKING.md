# Surface benchmarking

BENCH-01 freezes the GitLab MCP tool surface before toolset optimization. The baseline is intentionally about MCP-visible definitions and stable registration metadata, not runtime latency or production behavior.

## Commands

`npm run benchmark:surface` prints a fresh audit for both the full `all` surface and read-only mode, including every tool's family, access class, schema bytes, and estimated schema tokens.

`npm run benchmark:surface:check` regenerates both surfaces from the canonical MCP server and fails when the committed baseline has drifted.

To verify and reserialize the existing frozen baseline, run:

```sh
npm run benchmark:surface -- --write --source-commit=<pre-toolset-commit-sha> --captured-at=<YYYY-MM-DD>
```

Baseline creation is a reviewed historical operation. The source commit records the state being frozen, not necessarily the later commit that adds or updates the audit tooling. Because this file is a historical comparison anchor, BENCH-01 pins its exact source commit and capture date in the audit code; both `--write` and `--check` reject provenance drift. Once the frozen snapshot exists, `--write` is idempotent-only: it requires the committed snapshot to exist and refuses to replace it with a different surface or metadata shape. If the snapshot is missing, restore it from repository history rather than recreating historical data from the current surface. Correcting historical provenance or establishing a later comparison point requires an explicit reviewed change.

## What is measured

The audit connects an MCP client to `createGitLabMcpServer()` using the SDK in-memory transport and consumes the real `tools/list` response. It therefore measures the same names, descriptions, input schemas, output schemas, annotations, and MCP extensions exposed by the canonical server rather than maintaining a parallel inventory.

For every surface the report records:

- total tool count;
- read, write, and destructive classifications;
- canonical serialized UTF-8 schema bytes;
- per-tool schema bytes and estimated tokens;
- per-registration-family counts and schema sizes;
- the ten largest tool definitions;
- a SHA-256 fingerprint of the canonical tool-definition array.

Registration-family classification is audit-only. The audit invokes the same tool-family registration modules used by production against a metadata collector, then cross-checks the resulting names and safety classifications against the canonical `tools/list` response. If production adds, removes, or reclassifies a tool without updating the audit family coverage, the audit fails instead of silently inventing metadata. BENCH-01 does not alter runtime registration or filter the default surface.

The committed baseline intentionally omits the complete per-tool table to keep reviewed drift compact. It persists aggregate counts, every family summary, the ten largest tools, and an exact canonical-definition fingerprint. The complete deterministic per-tool table remains machine-readable from `npm run benchmark:surface` whenever a drift needs to be diagnosed.

## Token estimate

Raw UTF-8 bytes are authoritative. Token counts use the versioned `utf8-bytes-div-4` v1 estimator: `ceil(canonical UTF-8 bytes / 4)`. This deliberately avoids pretending that one provider/model tokenizer is universal. Later model evaluation may add provider-specific context measurements without rewriting this baseline.

## Provenance classes

Stored measurements use three distinct classes:

- `reference`: measurements published or captured from other MCP projects; informational only and never CI thresholds;
- `benchmark`: controlled GitLab MCP measurements such as this pre-toolset surface baseline;
- `production`: reserved for future real deployment observations.

`benchmarks/external-references.json` contains the source project/snapshot, methodology, units, provenance, and caveats for each external value. Reference values are schema-validated, but their numeric values never determine CI pass/fail.

## Intentional drift

Any change to a tool name, description, schema, safety annotation, registration family, or read-only visibility can make the current canonical surface differ from this baseline. The test suite and `benchmark:surface:check` report that drift so the change is explicit and reviewable.

The pre-toolset baseline is a historical comparison anchor and must not be overwritten merely because a later optimization intentionally changes the surface. Future surface-changing work should retain this file, add a new benchmark snapshot when a new comparison point is needed, and deliberately evolve the drift gate for the new expected state.
