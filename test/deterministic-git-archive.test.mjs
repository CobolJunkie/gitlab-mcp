import assert from "node:assert/strict";
import test from "node:test";

import * as archive from "../scripts/deterministic-git-archive.mjs";

const BASE_OPTIONS = {
  repositoryRoot: ".",
  archivePath: "archive.tar.gz",
  prefix: "safe/",
  commitMessage: "test archive",
  files: [],
};

test("rejects unsafe archive prefixes before Git work", async () => {
  for (const prefix of ["../escape/", "/absolute/", "C:/absolute/"]) {
    await assert.rejects(
      archive.createDeterministicGitArchive({ ...BASE_OPTIONS, prefix }),
      /file paths must stay inside the archive root/,
    );
  }
});

test("rejects unsafe archive file paths before Git work", async () => {
  const paths = ["../escape", "folder/..", "/absolute", "C:relative"];
  for (const archivePath of paths) {
    const files = [{ sourcePath: "ignored", archivePath }];
    await assert.rejects(
      archive.createDeterministicGitArchive({ ...BASE_OPTIONS, files }),
      /file paths must stay inside the archive root/,
    );
  }
});

test("rejects duplicate archive file paths before Git work", async () => {
  const files = [
    { sourcePath: "first", archivePath: "same.txt" },
    { sourcePath: "second", archivePath: "same.txt" },
  ];
  await assert.rejects(
    archive.createDeterministicGitArchive({ ...BASE_OPTIONS, files }),
    /file path same\.txt must be unique/,
  );
});
