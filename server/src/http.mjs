import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomUUID } from "node:crypto";
import express from "express";

import { GitLabClient, normalizeGitLabUrl } from "./gitlab-client.mjs";
import { observationStartedAt, observeHttpRequest } from "./observability.mjs";
import { createGitLabMcpServer } from "./server.mjs";

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

function isLoopbackHostname(hostname) {
  return LOOPBACK_URL_HOSTNAMES.has(
    String(hostname || "")
      .toLowerCase()
      .replace(/^\[/, "")
      .replace(/\]$/, ""),
  );
}

function jsonRpcError(res, status, code, message) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function parseAllowedHosts(value) {
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

function positiveInteger(value, name, { min = 1, max = 100_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

function cacheGet(cache, key, now) {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(cache, key, value, expiresAt, now, maxEntries) {
  for (const [candidate, entry] of cache) {
    if (candidate !== key && entry.expiresAt <= now) {
      cache.delete(candidate);
    }
  }
  cache.delete(key);
  cache.set(key, { value, expiresAt });
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function retryAfterSeconds(entry, now, windowMs) {
  return Math.max(1, Math.ceil((entry.startedAt + windowMs - now) / 1_000));
}

function failureLimitState(failures, key, now, windowMs) {
  const entry = failures.get(key);
  if (!entry || entry.startedAt + windowMs <= now) {
    if (entry) {
      failures.delete(key);
    }
    return undefined;
  }
  return entry;
}

function recordFailure(failures, key, now, windowMs, maxEntries) {
  for (const [candidate, candidateEntry] of failures) {
    if (candidateEntry.startedAt + windowMs <= now) {
      failures.delete(candidate);
    }
  }
  const entry = failureLimitState(failures, key, now, windowMs) || {
    count: 0,
    startedAt: now,
  };
  entry.count += 1;
  failures.delete(key);
  failures.set(key, entry);
  while (failures.size > maxEntries) {
    failures.delete(failures.keys().next().value);
  }
  return entry;
}

function createBoundedMcpExpressApp({
  host,
  allowedHosts,
  requestIdFactory,
  requestObserver,
  observabilityObserver,
}) {
  const app = express();
  app.use((req, res, next) => {
    const requestId = requestIdFactory();
    const startedAt = observationStartedAt();
    req.requestId = requestId;
    res.set("X-Request-Id", requestId);
    if (requestObserver || observabilityObserver) {
      res.once("finish", () => {
        observeHttpRequest({
          observer: observabilityObserver,
          requestObserver,
          requestId,
          method: req.method,
          routePath: req.route?.path ?? req.path,
          status: res.statusCode,
          startedAt,
        });
      });
    }
    next();
  });
  if (allowedHosts?.length) {
    app.use(hostHeaderValidation(allowedHosts));
  } else if (LOOPBACK_BIND_HOSTS.has(host)) {
    app.use(localhostHostValidation());
  }
  return app;
}

/**
 * Read the request body stream, enforce a byte limit, and parse as JSON.
 * Returns the parsed body object.  Throws typed errors that callers can
 * map to HTTP responses:
 *   - { type: "entity.too.large" }  body exceeds limit
 *   - { type: "request.timeout" }   body read timed out
 *   - SyntaxError                   malformed JSON
 *
 * When `readTimeoutMs` is set, the reader enforces a per-chunk deadline.
 * If no new chunk arrives within the deadline the stream is destroyed and
 * a timeout error is thrown, preventing slow clients from holding admission
 * slots indefinitely.
 */
async function parseBoundedJsonBody(req, limitBytes, readTimeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let timer;

    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      if (error) reject(error);
      else resolve(result);
    };

    const onData = (chunk) => {
      if (timer) clearTimeout(timer);
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        const error = new Error("Request body too large");
        error.type = "entity.too.large";
        settle(error);
        return;
      }
      chunks.push(chunk);
      if (readTimeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error("Request body read timed out");
          error.type = "request.timeout";
          settle(error);
        }, readTimeoutMs);
      }
    };

    const onEnd = () => {
      try {
        const combined =
          chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        settle(null, JSON.parse(combined.toString("utf8")));
      } catch (error) {
        settle(error);
      }
    };

    const onError = (error) => {
      settle(error);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);

    if (readTimeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error("Request body read timed out");
        error.type = "request.timeout";
        settle(error);
      }, readTimeoutMs);
    }
  });
}

/**
 * Parse the MCP request body with error mapping.  Returns the parsed
 * body on success or undefined if an error response was already sent.
 */
async function parseMcpBody(req, res, limitBytes, readTimeoutMs) {
  try {
    return await parseBoundedJsonBody(req, limitBytes, readTimeoutMs);
  } catch (error) {
    if (error?.type === "entity.too.large") {
      jsonRpcError(
        res,
        413,
        -32001,
        `MCP request body exceeds the ${limitBytes}-byte limit.`,
      );
      return undefined;
    }
    if (error instanceof SyntaxError) {
      jsonRpcError(res, 400, -32700, "Parse error.");
      return undefined;
    }
    if (error?.type === "request.timeout") {
      jsonRpcError(res, 408, -32001, "Request body read timed out.");
      return undefined;
    }
    throw error;
  }
}

function validatePublicUrl(url, allowInsecurePublicUrl) {
  if (url.username || url.password) {
    throw new Error("MCP_PUBLIC_URL must not contain embedded credentials.");
  }
  if (url.search || url.hash) {
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

function bearerToken(req) {
  const header = req.get("authorization");
  if (!header) {
    return undefined;
  }
  const headerLower = header;
  const bearerPrefix = headerLower.match(/^Bearer\s+/i);
  const match = bearerPrefix
    ? [null, header.slice(bearerPrefix[0].length)]
    : null;
  return match?.[1]?.trim() || undefined;
}

export function buildAuthChallenge(
  resourceUrl,
  { error, errorDescription, scope = "api" } = {},
) {
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    resourceUrl,
  );
  const parameters = [
    `resource_metadata="${metadataUrl.toString()}"`,
    `scope="${scope}"`,
  ];
  if (error) {
    const escapedError = String(error).replaceAll('"', String.raw`\"`);
    parameters.push(`error="${escapedError}"`);
  }
  if (errorDescription) {
    const escapedDesc = String(errorDescription).replaceAll(
      '"',
      String.raw`\"`,
    );
    parameters.push(`error_description="${escapedDesc}"`);
  }
  return `Bearer ${parameters.join(", ")}`;
}

export async function validateGitLabBearerToken({
  gitlabUrl,
  token,
  allowInsecureHttp = false,
}) {
  const client = new GitLabClient({
    baseUrl: gitlabUrl,
    token,
    allowInsecureHttp,
    timeoutMs: 10_000,
  });
  return (await client.request("/user")).data;
}

/**
 * Maximum bytes to consume when probing the readiness endpoint for
 * a bounded JSON sanity check.  Keeps the probe safe against
 * misrouted HTML pages, WAF responses, or oversized gateway bodies.
 */
const READINESS_PROBE_MAX_BYTES = 4096;

export async function checkGitLabReadiness({ gitlabUrl }) {
  const apiUrl = new URL(`${gitlabUrl}/api/v4/user`);
  const response = await fetch(apiUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });

  if (![200, 401, 403].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }

  // Consume a bounded prefix and verify valid JSON.  This rejects HTML,
  // malformed JSON, and unexpected non-object bodies from proxies or WAFs.
  try {
    const chunks = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) {
      return false;
    }
    try {
      while (totalBytes < READINESS_PROBE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = READINESS_PROBE_MAX_BYTES - totalBytes;
        if (value.length > remaining) {
          await reader.cancel().catch(() => undefined);
          return false;
        }
        chunks.push(value);
        totalBytes += value.length;
      }
    } finally {
      // Discard remaining body to avoid back-pressure stalls
      reader.cancel().catch(() => undefined);
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = JSON.parse(new TextDecoder().decode(combined));
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
}

function validateHttpAppOptions({
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
  const localBinding = LOOPBACK_BIND_HOSTS.has(host);
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

async function validateToken({
  token,
  req,
  validatedTokens,
  authenticationFailures,
  validationBudget,
  tokenValidator,
  gitlabUrl,
  allowInsecureGitLabUrl,
  tokenValidationTtlMs,
  tokenValidationMaxEntries,
  authFailureLimit,
  authFailureWindowMs,
  authFailureMaxEntries,
  authValidationLimit,
  authValidationWindowMs,
  now,
  oauthChallenge,
  res,
}) {
  const tokenKey = createHash("sha256").update(token).digest("hex");
  const requestTime = now();
  let identity = cacheGet(validatedTokens, tokenKey, requestTime);
  if (identity) {
    return { identity, tokenKey };
  }

  // Key failures by token hash rather than by peer address.  Behind a
  // reverse proxy every client shares one IP, so per-IP throttling lets a
  // handful of bad tokens block all legitimate users.  Per-token tracking
  // isolates each credential while still bounding total map size.
  const failureKey = `token:${tokenKey}`;
  const tokenFailure = failureLimitState(
    authenticationFailures,
    failureKey,
    requestTime,
    authFailureWindowMs,
  );
  if ((tokenFailure?.count || 0) >= authFailureLimit) {
    const retryAfter = retryAfterSeconds(
      tokenFailure,
      requestTime,
      authFailureWindowMs,
    );
    res.status(429).set("Retry-After", String(retryAfter)).json({
      error: "too_many_requests",
      message: "Too many rejected GitLab access tokens. Retry later.",
    });
    return undefined;
  }

  // Aggregate validation budget — caps the total number of uncached
  // GitLab token-validation calls per sliding window regardless of token
  // identity.  Prevents unique-token rotation from producing unlimited
  // upstream API amplification.  Cached valid tokens bypass this check.
  if (
    requestTime - validationBudget.windowStartedAt >=
    authValidationWindowMs
  ) {
    validationBudget.count = 0;
    validationBudget.windowStartedAt = requestTime;
  }
  validationBudget.count += 1;
  if (validationBudget.count > authValidationLimit) {
    const retryAfter = Math.max(
      1,
      Math.ceil(
        (validationBudget.windowStartedAt +
          authValidationWindowMs -
          requestTime) /
          1_000,
      ),
    );
    res.status(429).set("Retry-After", String(retryAfter)).json({
      error: "too_many_requests",
      message: "Token validation rate limit exceeded. Retry later.",
    });
    return undefined;
  }

  try {
    identity = await tokenValidator({
      gitlabUrl,
      token,
      allowInsecureHttp: allowInsecureGitLabUrl,
    });
    cacheSet(
      validatedTokens,
      tokenKey,
      identity,
      now() + tokenValidationTtlMs,
      now(),
      tokenValidationMaxEntries,
    );
  } catch {
    validatedTokens.delete(tokenKey);
    recordFailure(
      authenticationFailures,
      failureKey,
      now(),
      authFailureWindowMs,
      authFailureMaxEntries,
    );
    res.status(401).set("WWW-Authenticate", oauthChallenge).json({
      error: "invalid_token",
      message: "GitLab rejected the connected access token.",
    });
    return undefined;
  }

  return { identity, tokenKey };
}

export function createHttpApp({
  host = process.env.MCP_HOST || "127.0.0.1",
  port = parsePort(),
  publicUrl = process.env.MCP_PUBLIC_URL,
  allowInsecureGitLabUrl = process.env.GITLAB_ALLOW_INSECURE_HTTP === "true",
  gitlabUrl = normalizeGitLabUrl(undefined, {
    allowInsecureHttp: allowInsecureGitLabUrl,
  }),
  allowedHosts = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS),
  allowServerToken = process.env.ALLOW_SERVER_TOKEN_HTTP === "true",
  readOnly = process.env.MCP_READ_ONLY === "true",
  allowInsecurePublicUrl = process.env.MCP_ALLOW_INSECURE_PUBLIC_URL === "true",
  requirePublicUrl = process.env.NODE_ENV === "production",
  requestBodyLimitBytes = parseRequestBodyLimit(),
  tokenValidator = validateGitLabBearerToken,
  tokenValidationTtlMs = 60_000,
  tokenValidationMaxEntries = Number(
    process.env.MCP_TOKEN_CACHE_MAX_ENTRIES || DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
  ),
  authFailureLimit = Number(
    process.env.MCP_AUTH_FAILURE_LIMIT || DEFAULT_AUTH_FAILURE_LIMIT,
  ),
  authFailureWindowMs = Number(
    process.env.MCP_AUTH_FAILURE_WINDOW_MS || DEFAULT_AUTH_FAILURE_WINDOW_MS,
  ),
  authFailureMaxEntries = Number(
    process.env.MCP_AUTH_FAILURE_MAX_ENTRIES ||
      DEFAULT_AUTH_FAILURE_MAX_ENTRIES,
  ),
  authValidationLimit = Number(
    process.env.MCP_AUTH_VALIDATION_LIMIT || DEFAULT_AUTH_VALIDATION_LIMIT,
  ),
  authValidationWindowMs = Number(
    process.env.MCP_AUTH_VALIDATION_WINDOW_MS ||
      DEFAULT_AUTH_VALIDATION_WINDOW_MS,
  ),
  maxConcurrentRequests = Number(
    process.env.MCP_MAX_CONCURRENT_REQUESTS || DEFAULT_MAX_CONCURRENT_REQUESTS,
  ),
  maxConcurrentRequestsPerIdentity = Number(
    process.env.MCP_MAX_CONCURRENT_REQUESTS_PER_IDENTITY ||
      DEFAULT_MAX_CONCURRENT_REQUESTS_PER_IDENTITY,
  ),
  requestBodyReadTimeoutMs = Number(
    process.env.MCP_REQUEST_BODY_READ_TIMEOUT_MS ??
      DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS,
  ),
  now = Date.now,
  readinessCheck = checkGitLabReadiness,
  requestIdFactory = randomUUID,
  requestObserver,
  observabilityObserver,
  errorLogger = console.error,
  serverFactory = createGitLabMcpServer,
} = {}) {
  const validated = validateHttpAppOptions({
    port,
    host,
    allowedHosts,
    requestBodyLimitBytes,
    gitlabUrl,
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
    requestBodyReadTimeoutMs,
    requirePublicUrl,
    publicUrl,
    allowInsecurePublicUrl,
    allowServerToken,
    readOnly,
  });
  gitlabUrl = validated.gitlabUrl;
  tokenValidationTtlMs = validated.tokenValidationTtlMs;
  tokenValidationMaxEntries = validated.tokenValidationMaxEntries;
  authFailureLimit = validated.authFailureLimit;
  authFailureWindowMs = validated.authFailureWindowMs;
  authFailureMaxEntries = validated.authFailureMaxEntries;
  authValidationLimit = validated.authValidationLimit;
  authValidationWindowMs = validated.authValidationWindowMs;
  maxConcurrentRequests = validated.maxConcurrentRequests;
  maxConcurrentRequestsPerIdentity = validated.maxConcurrentRequestsPerIdentity;
  requestBodyReadTimeoutMs = validated.requestBodyReadTimeoutMs;
  const { resourceUrl } = validated;
  const oauthScope = readOnly ? "read_api" : "api";
  const oauthChallenge = buildAuthChallenge(resourceUrl, {
    error: "invalid_token",
    errorDescription: "A valid GitLab access token is required.",
    scope: oauthScope,
  });
  const securitySchemes = allowServerToken
    ? [{ type: "noauth" }]
    : [{ type: "oauth2", scopes: [oauthScope] }];
  const app = createBoundedMcpExpressApp({
    host,
    allowedHosts,
    requestIdFactory,
    requestObserver,
    observabilityObserver,
  });

  const metadata = {
    resource: resourceUrl.toString(),
    authorization_servers: [gitlabUrl],
    scopes_supported: [oauthScope],
    resource_name: "GitLab",
    resource_documentation:
      "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
  };
  const validatedTokens = new Map();
  const authenticationFailures = new Map();
  const activeByIdentity = new Map();
  let activeRequests = 0;
  const validationBudget = { count: 0, windowStartedAt: 0 };

  app.get(
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
    (_req, res) => {
      res.json(metadata);
    },
  );

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "gitlab-mcp",
    });
  });

  app.get("/ready", async (_req, res) => {
    try {
      if ((await readinessCheck({ gitlabUrl })) === false) {
        throw new Error("not ready");
      }
      res.json({ status: "ready", service: "gitlab-mcp" });
    } catch {
      res.status(503).json({
        status: "unavailable",
        service: "gitlab-mcp",
      });
    }
  });

  app.post("/mcp", async (req, res) => {
    // 1. Cheap content-type check — no body reading required.
    if (!req.is("application/json")) {
      jsonRpcError(
        res,
        415,
        -32600,
        "MCP requests must use Content-Type: application/json.",
      );
      return;
    }

    // 2. Global concurrency admission — must precede body buffering.
    if (activeRequests >= maxConcurrentRequests) {
      res.status(429).set("Retry-After", "1").json({
        error: "too_many_requests",
        message: "The MCP service is at its concurrent request limit.",
      });
      return;
    }
    activeRequests += 1;

    try {
      // 3. Bounded JSON body parsing — after admission, before auth.
      const body = await parseMcpBody(
        req,
        res,
        requestBodyLimitBytes,
        requestBodyReadTimeoutMs,
      );
      if (body === undefined) {
        return;
      }

      // 4. Extract and resolve the bearer token.
      const requestToken = bearerToken(req);
      const configuredToken =
        process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN;
      const token =
        requestToken || (allowServerToken ? configuredToken : undefined);

      if (!token) {
        res.status(401).set("WWW-Authenticate", oauthChallenge).json({
          error: "unauthorized",
          message:
            "Connect a GitLab OAuth Bearer token. Server-side tokens are disabled for HTTP unless ALLOW_SERVER_TOKEN_HTTP=true.",
        });
        return;
      }

      // 5. Validate the token against GitLab.
      const tokenResult = await validateToken({
        token,
        req,
        validatedTokens,
        authenticationFailures,
        validationBudget,
        tokenValidator,
        gitlabUrl,
        allowInsecureGitLabUrl,
        tokenValidationTtlMs,
        tokenValidationMaxEntries,
        authFailureLimit,
        authFailureWindowMs,
        authFailureMaxEntries,
        authValidationLimit,
        authValidationWindowMs,
        now,
        oauthChallenge,
        res,
      });
      if (!tokenResult) {
        return;
      }
      const { identity, tokenKey } = tokenResult;

      req.auth = {
        token,
        clientId: `gitlab-user-${identity?.id || "unknown"}`,
        scopes: [oauthScope],
        resource: resourceUrl,
        extra: {
          gitlabUrl,
          gitlabUserId: identity?.id,
          gitlabUsername: identity?.username,
        },
      };

      // 6. Per-identity concurrency limit.
      const identityKey = String(identity?.id || tokenKey);
      const identityActive = activeByIdentity.get(identityKey) || 0;
      if (identityActive >= maxConcurrentRequestsPerIdentity) {
        res.status(429).set("Retry-After", "1").json({
          error: "too_many_requests",
          message: "This GitLab identity is at its concurrent request limit.",
        });
        return;
      }
      activeByIdentity.set(identityKey, identityActive + 1);

      // 7. MCP request processing.
      let server;
      let transport;
      try {
        server = serverFactory({
          securitySchemes,
          authChallenge: oauthChallenge,
          readOnly,
          deploymentMode: "http",
          observabilityObserver,
        });
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        errorLogger(
          JSON.stringify({
            level: "error",
            event: "mcp_request_failed",
            requestId: req.requestId,
            errorType: error?.name || "Error",
          }),
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error.",
            },
            id: null,
          });
        }
      } finally {
        await transport?.close().catch(() => undefined);
        await server?.close().catch(() => undefined);
        const remaining = (activeByIdentity.get(identityKey) || 1) - 1;
        if (remaining > 0) {
          activeByIdentity.set(identityKey, remaining);
        } else {
          activeByIdentity.delete(identityKey);
        }
      }
    } finally {
      activeRequests -= 1;
    }
  });

  const methodNotAllowed = (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed for stateless MCP transport.",
      },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.use((error, req, res, _next) => {
    if (res.headersSent) {
      return;
    }
    errorLogger(
      JSON.stringify({
        level: "error",
        event: "http_request_failed",
        requestId: req.requestId,
        errorType: error?.name || "Error",
      }),
    );
    jsonRpcError(res, 500, -32603, "Internal MCP server error.");
  });

  return {
    app,
    host,
    port,
    resourceUrl,
    metadata,
    diagnostics: {
      validatedTokenCount: () => validatedTokens.size,
      authenticationFailureKeyCount: () => authenticationFailures.size,
      activeRequestCount: () => activeRequests,
      validationBudgetCount: () => validationBudget.count,
    },
  };
}

export function startHttpServer(options = {}) {
  const state = createHttpApp(options);
  const shutdownTimeoutMs = positiveInteger(
    options.shutdownTimeoutMs ??
      process.env.MCP_SHUTDOWN_TIMEOUT_MS ??
      DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS,
    "MCP_SHUTDOWN_TIMEOUT_MS",
    { max: MAX_HTTP_SHUTDOWN_TIMEOUT_MS },
  );
  const httpServer = state.app.listen(state.port, state.host);
  const ready = new Promise((resolve, reject) => {
    httpServer.once("listening", () => {
      console.error(`GitLab MCP HTTP server listening at ${state.resourceUrl}`);
      resolve(httpServer);
    });
    httpServer.once("error", (error) => {
      console.error("Failed to start GitLab MCP HTTP server:", error);
      process.exitCode = 1;
      reject(error);
    });
  });
  // Keep startup failures observable through `ready` without generating an
  // unhandled rejection when a synchronous caller only uses the server handle.
  ready.catch(() => undefined);
  return {
    ...state,
    httpServer,
    ready,
    shutdown: () =>
      shutdownHttpServer(httpServer, { timeoutMs: shutdownTimeoutMs }),
  };
}

export function shutdownHttpServer(
  httpServer,
  { timeoutMs = DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS } = {},
) {
  timeoutMs = positiveInteger(timeoutMs, "MCP_SHUTDOWN_TIMEOUT_MS", {
    max: MAX_HTTP_SHUTDOWN_TIMEOUT_MS,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      // Stop waiting for keep-alive or stalled requests once the bounded drain
      // window expires. These methods are available on supported Node runtimes
      // and are guarded for test doubles/older runtimes.
      httpServer.closeIdleConnections?.();
      httpServer.closeAllConnections?.();
      finish();
    }, timeoutMs);
    try {
      httpServer.close((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}
