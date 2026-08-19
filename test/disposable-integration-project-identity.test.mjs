import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateResolvedDisposableIntegrationProject } from "../scripts/lib/disposable-integration-report-gate.mjs";

const CURRENT_PROJECT = Object.freeze({
  CI_PROJECT_ID: "12",
  CI_PROJECT_PATH: "group/project",
});

test("resolved disposable projects require an authoritative project ID", () => {
  for (const projectInfo of [
    { default_branch: "main" },
    { id: null, path_with_namespace: "group/disposable" },
    { id: " ", path_with_namespace: "group/disposable" },
    { id: 0, path_with_namespace: "group/disposable" },
    { id: -1, path_with_namespace: "group/disposable" },
    { id: 1.5, path_with_namespace: "group/disposable" },
    { id: "01", path_with_namespace: "group/disposable" },
    { id: "1e2", path_with_namespace: "group/disposable" },
    { id: "+99", path_with_namespace: "group/disposable" },
    { id: "99.0", path_with_namespace: "group/disposable" },
    { id: "9007199254740992", path_with_namespace: "group/disposable" },
    {
      id: Number.MAX_SAFE_INTEGER + 1,
      path_with_namespace: "group/disposable",
    },
    { id: {}, path_with_namespace: "group/disposable" },
  ]) {
    assert.throws(
      () =>
        validateResolvedDisposableIntegrationProject(
          projectInfo,
          CURRENT_PROJECT,
        ),
      /must include an authoritative project ID/u,
    );
  }

  for (const id of [
    99,
    "99",
    Number.MAX_SAFE_INTEGER,
    String(Number.MAX_SAFE_INTEGER),
  ]) {
    assert.deepEqual(
      validateResolvedDisposableIntegrationProject(
        { id, path_with_namespace: "group/disposable" },
        CURRENT_PROJECT,
      ),
      { projectId: String(id), projectPath: "group/disposable" },
    );
  }
});

test("alias-shaped resolved project IDs cannot bypass current-project isolation", () => {
  assert.throws(
    () =>
      validateResolvedDisposableIntegrationProject(
        {
          id: CURRENT_PROJECT.CI_PROJECT_PATH,
          path_with_namespace: "group/disposable",
        },
        CURRENT_PROJECT,
      ),
    /must include an authoritative project ID/u,
  );
});

test("disposable integration pins later operations to the authoritative project ID", async () => {
  const source = await readFile(
    new URL("../scripts/integration-disposable.mjs", import.meta.url),
    "utf8",
  );
  const assignmentStart = source.indexOf(
    "project = validateResolvedDisposableIntegrationProject(",
  );
  assert.notEqual(
    assignmentStart,
    -1,
    "integration script must bind the validated project ID",
  );

  const assignmentEnd = source.indexOf(").projectId;", assignmentStart);
  assert.notEqual(
    assignmentEnd,
    -1,
    "integration script must select the authoritative projectId",
  );

  const postResolution = source.slice(assignmentEnd + ").projectId;".length);
  assert.doesNotMatch(
    postResolution,
    /\brequestedProject\b/u,
    "project-scoped operations after identity validation must not reuse the requested alias",
  );
});
