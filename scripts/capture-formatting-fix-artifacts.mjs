import { pathToFileURL } from "node:url";

import { captureFormattingFixArtifacts } from "./lib/formatting-fix-artifacts.mjs";

async function main() {
  const result = await captureFormattingFixArtifacts();
  if (!result.changed) {
    console.log(
      "Formatting check passed; pinned Prettier produced no tracked changes.",
    );
    return;
  }

  console.error(
    `Formatting check failed; pinned Prettier changed ${result.paths.length} tracked file(s):`,
  );
  for (const path of result.paths) {
    console.error(`- ${path}`);
  }
  console.error(
    "Download the formatting job artifacts for prettier.patch and exact formatted file copies.",
  );
  process.exitCode = 1;
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  await main();
}
