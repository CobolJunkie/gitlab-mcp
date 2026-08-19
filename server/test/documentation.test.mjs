import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const documents = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  "TERMS.md",
  "docs/README.md",
  "docs/USER_GUIDE.md",
  "docs/TASK_COOKBOOK.md",
  "docs/CONFIGURATION.md",
  "docs/TROUBLESHOOTING.md",
  "docs/DEVELOPER_GUIDE.md",
  "docs/COMPATIBILITY.md",
  "docs/RELEASING.md",
  "docs/PUBLICATION_CHECKLIST.md",
  "docs/CHATGPT_DEPLOYMENT.md",
  "docs/PARITY.md",
];

const canonicalToolCountClaims = [
  {
    path: "README.md",
    patterns: [/\d+\s+typed\s+tools/i],
  },
  {
    path: "docs/README.md",
    patterns: [/\ball\s+\d+\s+tools\s+grouped\s+by\s+workflow/i],
  },
  {
    path: "docs/USER_GUIDE.md",
    patterns: [/\d+\s+typed\s+tools/i],
  },
  {
    path: "docs/PARITY.md",
    patterns: [/\bMCP\s+contract\s+test\s+enumerates\s+\d+\s+tools\b/i],
  },
];

test("product documentation does not advertise a hardcoded canonical tool count", async () => {
  for (const { path, patterns } of canonicalToolCountClaims) {
    const content = await readFile(resolve(root, path), "utf8");
    for (const pattern of patterns) {
      assert.doesNotMatch(
        content,
        pattern,
        `${path} should not contain a hardcoded canonical tool count; use runtime inventory discovery instead.`,
      );
    }
  }
});

test("CHANGELOG.md contains a section matching the package.json version", async () => {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const version = pkg.version;
  // Strip any build-metadata suffix after '+' for section matching.
  const baseVersion = version.split("+")[0];
  const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  assert.match(
    changelog,
    new RegExp(`^## ${baseVersion.replace(/\./g, "\\.")}\\s*$`, "m"),
    `CHANGELOG.md must contain a "## ${baseVersion}" section matching the package.json version.`,
  );
});

test("keeps local documentation links valid and exposes both audience paths", async () => {
  const hub = await readFile(resolve(root, "docs/README.md"), "utf8");
  assert.match(hub, /\[User guide\]\(USER_GUIDE\.md\)/);
  assert.match(hub, /\[Developer guide\]\(DEVELOPER_GUIDE\.md\)/);

  for (const relativePath of documents) {
    const absolutePath = resolve(root, relativePath);
    const markdown = await readFile(absolutePath, "utf8");
    const links = markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
    for (const [, rawTarget] of links) {
      const target = rawTarget.split("#", 1)[0];
      if (
        !target ||
        /^(?:https?:|mailto:|codex:)/.test(target) ||
        target.includes("<")
      ) {
        continue;
      }
      const decoded = decodeURIComponent(target);
      await assert.doesNotReject(
        access(resolve(dirname(absolutePath), decoded)),
        `${relativePath} links to missing ${target}`,
      );
    }
  }
});
