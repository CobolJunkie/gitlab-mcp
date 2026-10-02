import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("publishes complete project-controlled plugin metadata", async () => {
  const manifest = JSON.parse(
    await readFile(new URL(".codex-plugin/plugin.json", root), "utf8"),
  );
  const projectOrigin =
    "https://gitlab.villainmindset.org/CobolJunkie/gitlab-codex-plugin";

  for (const value of [
    manifest.homepage,
    manifest.repository,
    manifest.interface.websiteURL,
    manifest.interface.privacyPolicyURL,
    manifest.interface.termsOfServiceURL,
  ]) {
    assert.ok(
      value.startsWith(projectOrigin),
      `${value} must be project controlled`,
    );
  }

  assert.ok(manifest.interface.screenshots.length >= 2);
  for (const screenshot of manifest.interface.screenshots) {
    assert.match(screenshot, /^\.\/assets\/.+\.png$/);
    await access(new URL(screenshot.slice(2), root));
  }

  assert.ok(manifest.interface.defaultPrompt.length <= 3);
  assert.doesNotMatch(JSON.stringify(manifest), /\[TODO:/);
});
