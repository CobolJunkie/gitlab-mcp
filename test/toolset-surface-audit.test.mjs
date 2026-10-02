import assert from "node:assert/strict";
import test from "node:test";

import { GITLAB_TOOLSETS } from "../server/src/tools/toolsets.mjs";
import {
  auditCanonicalToolsetSurfaces,
  auditToolsetSurface,
} from "../scripts/lib/toolset-surface-audit.mjs";

test("canonical toolset surface audit reports every primary toolset exactly once", async () => {
  const surfaces = await auditCanonicalToolsetSurfaces();

  assert.deepEqual(Object.keys(surfaces), GITLAB_TOOLSETS);
  assert.equal(
    Object.values(surfaces).reduce(
      (total, surface) => total + surface.toolCount,
      0,
    ),
    175,
  );
  for (const [toolset, surface] of Object.entries(surfaces)) {
    assert.deepEqual(surface.selection.toolsets, [toolset]);
    assert.equal(surface.readOnly, false);
    assert.ok(surface.toolCount > 0, `${toolset} must not be empty`);
    assert.ok(surface.serializedSchemaBytes > 0);
    assert.ok(surface.estimatedSchemaTokens > 0);
    assert.equal(
      surface.readToolCount + surface.writeToolCount,
      surface.toolCount,
    );
  }
});

test("candidate toolset unions are measured through the real core selector", async () => {
  const context = await auditToolsetSurface("context");
  const repository = await auditToolsetSurface("repository");
  const combined = await auditToolsetSurface("repository,context");

  assert.deepEqual(combined.selection.toolsets, ["context", "repository"]);
  assert.equal(combined.toolCount, context.toolCount + repository.toolCount);
  assert.deepEqual(
    combined.tools.map(({ name }) => name),
    [...context.tools, ...repository.tools]
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right)),
  );
});

test("toolset surface audit preserves default/all and read-only semantics", async () => {
  const all = await auditToolsetSurface("all");
  const defaults = await auditToolsetSurface("default");
  const readOnlyIssues = await auditToolsetSurface("issues", {
    readOnly: true,
  });

  assert.equal(all.toolCount, 175);
  assert.deepEqual(defaults.tools, all.tools);
  assert.equal(readOnlyIssues.writeToolCount, 0);
  assert.equal(readOnlyIssues.destructiveToolCount, 0);
  assert.ok(readOnlyIssues.readToolCount > 0);
});
