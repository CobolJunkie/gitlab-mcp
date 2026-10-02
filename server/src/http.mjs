// Stable public HTTP compatibility façade. Internal ownership lives under ./http/.
export {
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_MAX_ENTRIES,
  DEFAULT_AUTH_FAILURE_WINDOW_MS,
  DEFAULT_AUTH_VALIDATION_LIMIT,
  DEFAULT_AUTH_VALIDATION_WINDOW_MS,
  DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_CONCURRENT_REQUESTS_PER_IDENTITY,
  DEFAULT_MCP_REQUEST_BYTES,
  DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS,
  DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
  MAX_HTTP_SHUTDOWN_TIMEOUT_MS,
  MAX_MCP_REQUEST_BYTES,
  MAX_PORT,
  MAX_REQUEST_BODY_READ_TIMEOUT_MS,
  MIN_PORT,
  parsePort,
  parseRequestBodyLimit,
} from "./http/policy.mjs";
export { buildAuthChallenge, validateGitLabBearerToken } from "./http/auth.mjs";
export { checkGitLabReadiness } from "./http/readiness.mjs";
export { createHttpApp } from "./http/app.mjs";
export { shutdownHttpServer, startHttpServer } from "./http/lifecycle.mjs";
