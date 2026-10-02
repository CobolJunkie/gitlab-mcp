import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureFormattingFixArtifacts } from "../scripts/lib/formatting-fix-artifacts.mjs";

async function createCheckout(t) {
  const directory = await mkdtemp(join(tmpdir(), "gitlab-mcp-formatting-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await mkdir(join(directory, "nested"), { recursive: true });
  await writeFile(
    join(directory, "nested", "example.mjs"),
    "const value = 1;\n",
  );
  return directory;
}

function gitResult({ status = 0, stdout = "", stderr = "" } = {}) {
  return {
    status,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function formattingGit({
  changedPaths = ["nested/example.mjs"],
  patch = "exact patch\n",
} = {}) {
  return (_repositoryRoot, args) => {
    if (args.includes("--quiet")) {
      return gitResult({ status: changedPaths.length > 0 ? 1 : 0 });
    }
    if (args.includes("--name-only")) {
      return gitResult({
        stdout: changedPaths.length > 0 ? `${changedPaths.join("\0")}\0` : "",
      });
    }
    if (args.includes("--binary")) {
      return gitResult({ stdout: patch });
    }
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };
}

test("returns clean without leaving stale artifact output", async (t) => {
  const repositoryRoot = await createCheckout(t);
  const artifactDirectory = "artifacts/formatting";
  const stalePath = join(repositoryRoot, artifactDirectory, "stale.txt");
  await mkdir(join(repositoryRoot, artifactDirectory), { recursive: true });
  await writeFile(stalePath, "stale\n");

  const result = await captureFormattingFixArtifacts({
    repositoryRoot,
    artifactDirectory,
    git: formattingGit({ changedPaths: [] }),
  });

  assert.deepEqual(result, { changed: false, paths: [] });
  await assert.rejects(readFile(stalePath), /ENOENT/);
});

test("captures a binary-safe patch and exact formatted file copies", async (t) => {
  const repositoryRoot = await createCheckout(t);
  const formatted = "const value = 2;\n";
  const exactPatch =
    "diff --git a/nested/example.mjs b/nested/example.mjs\n-exact old\n+exact new\n";
  await writeFile(join(repositoryRoot, "nested", "example.mjs"), formatted);

  const result = await captureFormattingFixArtifacts({
    repositoryRoot,
    git: formattingGit({ patch: exactPatch }),
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.paths, ["nested/example.mjs"]);
  assert.equal(
    await readFile(
      join(result.filesDirectory, "nested", "example.mjs"),
      "utf8",
    ),
    formatted,
  );
  assert.equal(
    await readFile(result.manifestPath, "utf8"),
    "nested/example.mjs\n",
  );
  assert.equal(await readFile(result.patchPath, "utf8"), exactPatch);
});

test("preserves changed paths containing spaces", async (t) => {
  const repositoryRoot = await createCheckout(t);
  const spacedPath = join(repositoryRoot, "nested", "with space.md");
  await writeFile(spacedPath, "after\n");

  const result = await captureFormattingFixArtifacts({
    repositoryRoot,
    git: formattingGit({ changedPaths: ["nested/with space.md"] }),
  });

  assert.deepEqual(result.paths, ["nested/with space.md"]);
  assert.equal(
    await readFile(
      join(result.filesDirectory, "nested", "with space.md"),
      "utf8",
    ),
    "after\n",
  );
});

test("rejects artifact output outside the repository checkout", async (t) => {
  const repositoryRoot = await createCheckout(t);

  await assert.rejects(
    captureFormattingFixArtifacts({
      repositoryRoot,
      artifactDirectory: "../formatting-output",
      git: formattingGit({ changedPaths: [] }),
    }),
    /escapes checkout/u,
  );
});

test("fails closed when tracked changes have no copyable paths", async (t) => {
  const repositoryRoot = await createCheckout(t);
  const git = (_repositoryRoot, args) => {
    if (args.includes("--quiet")) {
      return gitResult({ status: 1 });
    }
    if (args.includes("--name-only")) {
      return gitResult();
    }
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };

  await assert.rejects(
    captureFormattingFixArtifacts({ repositoryRoot, git }),
    /no changed paths were reported/u,
  );
});
