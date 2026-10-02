import { normalizeGitLabUrl } from "../gitlab-client.mjs";

export const DEFAULT_MCP_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_REQUEST_BYTES = 25 * 1024 * 1024;
export const DEFAULT_TOKEN_CACHE_MAX_ENTRIES = 256;
export const DEFAULT_AUTH_FAILURE_LIMIT = 20;
export const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000;
export const DEFAULT_AUTH_FAILURE_MAX_ENTRIES = 1_024;
export const DEFAULT_AUTH_VALIDATION_LIMIT = 40;
export const DEFAULT_AUTH_VALIDATION_WINDOW_MS = 60_000;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
export const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_IDENTITY = 4;
export const DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_BODY_READ_TIMEOUT_MS = 120_000;
export const DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS = 30_000;
export const MAX_HTTP_SHUTDOWN_TIMEOUT_MS = 5 * 60_000;
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::"]);
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_URL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function isLoopbackBindHost(host) {
  return LOOPBACK_BIND_HOSTS.has(host);
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_URL_HOSTNAMES.has(
    String(hostname || "")
      .toLowerCase()
      .replace(/^\[/, "")
      .replace(/\]$/, ""),
  );
}

export function parseAllowedHosts(value) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
}

export function parseRequestBodyLimit(
  value = process.env.MCP_MAX_REQUEST_BYTES,
) {
  if (value === undefined || value === "") {
    return DEFAULT_MCP_REQUEST_BYTES;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 64 * 1024 ||
    parsed > MAX_MCP_REQUEST_BYTES
  ) {
    throw new Error(
      `MCP_MAX_REQUEST_BYTES must be an integer from 65536 through ${MAX_MCP_REQUEST_BYTES}.`,
    );
  }
  return parsed;
}

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

export function parsePort(value = process.env.PORT || process.env.MCP_PORT) {
  if (value === undefined || value === "") {
    return 3000;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `PORT must be an integer from ${MIN_PORT} through ${MAX_PORT}.`,
    );
  }
  return parsed;
}

export function positiveInteger(value, name, { min = 1, max = 100_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

function validatePublicUrl(url, allowInsecurePublicUrl) {
  if (url.username || url.password) {
    throw new Error("MCP_PUBLIC_URL must not contain embedded credentials.");
  }
  if (url.href.includes("?") || url.href.includes("#")) {
    throw new Error("MCP_PUBLIC_URL must not contain a query or fragment.");
  }
  if (url.protocol !== "https:" && !allowInsecurePublicUrl) {
    throw new Error(
      "MCP_PUBLIC_URL must use HTTPS. Set MCP_ALLOW_INSECURE_PUBLIC_URL=true only for local development.",
    );
  }
}

function resolvePublicPathname(url) {
  url.pathname = stripTrailingSlashes(url.pathname);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/mcp";
  } else if (!url.pathname.endsWith("/mcp")) {
    throw new Error("MCP_PUBLIC_URL path must end with /mcp.");
  }
}

function canonicalizeHost(host) {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::") {
    return "[::1]";
  }
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

function canonicalMcpUrl({ host, port, publicUrl, allowInsecurePublicUrl }) {
  if (publicUrl) {
    const url = new URL(publicUrl);
    validatePublicUrl(url, allowInsecurePublicUrl);
    resolvePublicPathname(url);
    return url;
  }
  return new URL(`http://${canonicalizeHost(host)}:${port}/mcp`);
}

export function validateHttpAppOptions({
  port,
  host,
  allowedHosts,
  requestBodyLimitBytes,
  requestBodyReadTimeoutMs,
  gitlabUrl: rawGitlabUrl,
  allowInsecureGitLabUrl,
  tokenValidationTtlMs,
  tokenValidationMaxEntries,
  authFailureLimit,
  authFailureWindowMs,
  authFailureMaxEntries,
  authValidationLimit,
  authValidationWindowMs,
  maxConcurrentRequests,
  maxConcurrentRequestsPerIdentity,
  requirePublicUrl,
  publicUrl,
  allowInsecurePublicUrl,
  allowServerToken,
  readOnly,
}) {
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `PORT must be an integer from ${MIN_PORT} through ${MAX_PORT}.`,
    );
  }
  const normalizedGitlabUrl = normalizeGitLabUrl(rawGitlabUrl, {
    allowInsecureHttp: allowInsecureGitLabUrl,
  });
  if (WILDCARD_BIND_HOSTS.has(host) && !allowedHosts?.length) {
    throw new Error(
      `MCP_ALLOWED_HOSTS is required when MCP_HOST is ${host} to prevent DNS-rebinding attacks.`,
    );
  }
  if (
    !Number.isSafeInteger(requestBodyLimitBytes) ||
    requestBodyLimitBytes < 64 * 1024 ||
    requestBodyLimitBytes > MAX_MCP_REQUEST_BYTES
  ) {
    throw new Error(
      `requestBodyLimitBytes must be an integer from 65536 through ${MAX_MCP_REQUEST_BYTES}.`,
    );
  }
  tokenValidationTtlMs = positiveInteger(
    tokenValidationTtlMs,
    "tokenValidationTtlMs",
    { max: 24 * 60 * 60 * 1_000 },
  );
  tokenValidationMaxEntries = positiveInteger(
    tokenValidationMaxEntries,
    "MCP_TOKEN_CACHE_MAX_ENTRIES",
  );
  authFailureLimit = positiveInteger(
    authFailureLimit,
    "MCP_AUTH_FAILURE_LIMIT",
  );
  authFailureWindowMs = positiveInteger(
    authFailureWindowMs,
    "MCP_AUTH_FAILURE_WINDOW_MS",
    { max: 24 * 60 * 60 * 1_000 },
  );
  authFailureMaxEntries = positiveInteger(
    authFailureMaxEntries,
    "MCP_AUTH_FAILURE_MAX_ENTRIES",
  );
  authValidationLimit = positiveInteger(
    authValidationLimit,
    "MCP_AUTH_VALIDATION_LIMIT",
  );
  authValidationWindowMs = positiveInteger(
    authValidationWindowMs,
    "MCP_AUTH_VALIDATION_WINDOW_MS",
    { max: 24 * 60 * 60 * 1_000 },
  );
  maxConcurrentRequests = positiveInteger(
    maxConcurrentRequests,
    "MCP_MAX_CONCURRENT_REQUESTS",
  );
  maxConcurrentRequestsPerIdentity = positiveInteger(
    maxConcurrentRequestsPerIdentity,
    "MCP_MAX_CONCURRENT_REQUESTS_PER_IDENTITY",
  );
  requestBodyReadTimeoutMs = positiveInteger(
    requestBodyReadTimeoutMs,
    "requestBodyReadTimeoutMs",
    { min: 1_000, max: MAX_REQUEST_BODY_READ_TIMEOUT_MS },
  );

  if (requirePublicUrl && !publicUrl) {
    throw new Error("MCP_PUBLIC_URL is required when NODE_ENV=production.");
  }

  const resourceUrl = canonicalMcpUrl({
    host,
    port,
    publicUrl,
    allowInsecurePublicUrl,
  });
  const localBinding = isLoopbackBindHost(host);
  const localResource = isLoopbackHostname(resourceUrl.hostname);
  if (
    allowInsecurePublicUrl &&
    (requirePublicUrl || !localBinding || !localResource)
  ) {
    throw new Error(
      "MCP_ALLOW_INSECURE_PUBLIC_URL is permitted only for local development on a loopback listener and loopback public URL.",
    );
  }
  if (allowServerToken && (!localBinding || (publicUrl && !localResource))) {
    throw new Error(
      "ALLOW_SERVER_TOKEN_HTTP is permitted only for a loopback HTTP deployment without a public URL.",
    );
  }

  return {
    gitlabUrl: normalizedGitlabUrl,
    tokenValidationTtlMs,
    tokenValidationMaxEntries,
    authFailureLimit,
    authFailureWindowMs,
    authFailureMaxEntries,
    authValidationLimit,
    authValidationWindowMs,
    maxConcurrentRequests,
    maxConcurrentRequestsPerIdentity,
    requestBodyReadTimeoutMs,
    resourceUrl,
    localBinding,
  };
}
