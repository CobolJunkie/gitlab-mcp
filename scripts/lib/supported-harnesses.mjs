import { CLAUDE_DISTRIBUTION } from "../../adapters/claude/distribution.mjs";
import { CLINE_DISTRIBUTION } from "../../adapters/cline/distribution.mjs";
import { CODEX_DISTRIBUTION } from "../../adapters/codex/distribution.mjs";
import { PI_DISTRIBUTION } from "../../adapters/pi/distribution.mjs";

function harness(label, distribution) {
  return Object.freeze({
    id: distribution.id,
    label,
    artifactName: distribution.artifactName,
  });
}

export const SUPPORTED_HARNESSES = Object.freeze([
  harness("Codex", CODEX_DISTRIBUTION),
  harness("Claude Code", CLAUDE_DISTRIBUTION),
  harness("Cline", CLINE_DISTRIBUTION),
  harness("Pi", PI_DISTRIBUTION),
]);
