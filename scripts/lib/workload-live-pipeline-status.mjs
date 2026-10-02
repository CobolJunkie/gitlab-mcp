const TERMINAL_PIPELINE_STATES = new Set([
  "success",
  "failed",
  "canceled",
  "skipped",
]);

export function isTerminalPipelineStatus(status) {
  return TERMINAL_PIPELINE_STATES.has(status);
}
