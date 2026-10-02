import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";

import { normalizeGitLabUrl } from "../gitlab-client.mjs";
import {
  observationDurationMs,
  observationStartedAt,
  observeMetric,
} from "../observability.mjs";
import { createGitLabMcpServer } from "../server.mjs";
import {
  bodyAdmissionFailureReason,
  createBoundedMcpExpressApp,
  jsonRpcError,
  parseMcpBody,
} from "./admission.mjs";
import {
  bearerToken,
  buildAuthChallenge,
  validateGitLabBearerToken,
  validateToken,
} from "./auth.mjs";
import {
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_MAX_ENTRIES,
  DEFAULT_AUTH_FAILURE_WINDOW_MS,
  DEFAULT_AUTH_VALIDATION_LIMIT,
  DEFAULT_AUTH_VALIDATION_WINDOW_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_CONCURRENT_REQUESTS_PER_IDENTITY,
  DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS,
  DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
  parseAllowedHosts,
  parsePort,
  parseRequestBodyLimit,
  validateHttpAppOptions,
} from "./policy.mjs";
import { checkGitLabReadiness } from "./readiness.mjs";

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
  const insufficientScopeChallenge = buildAuthChallenge(resourceUrl, {
    error: "insufficient_scope",
    errorDescription:
      "The connected GitLab access token is not authorized for the required scope.",
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
    const startedAt = observationStartedAt();
    let outcome = "error";
    try {
      if ((await readinessCheck({ gitlabUrl })) === false) {
        outcome = "unavailable";
        res.status(503).json({
          status: "unavailable",
          service: "gitlab-mcp",
        });
        return;
      }
      outcome = "ready";
      res.json({ status: "ready", service: "gitlab-mcp" });
    } catch {
      res.status(503).json({
        status: "unavailable",
        service: "gitlab-mcp",
      });
    } finally {
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.gitlab.readiness.duration",
        value: observationDurationMs(startedAt) / 1_000,
        attributes: { outcome },
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
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.http.admission.rejections",
        attributes: { reason: "content_type" },
      });
      return;
    }

    // 2. Global concurrency admission — must precede body buffering.
    if (activeRequests >= maxConcurrentRequests) {
      res.status(429).set("Retry-After", "1").json({
        error: "too_many_requests",
        message: "The MCP service is at its concurrent request limit.",
      });
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.http.admission.rejections",
        attributes: { reason: "global_concurrency" },
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
        observeMetric({
          observer: observabilityObserver,
          metric: "gitlab_mcp.http.admission.rejections",
          attributes: { reason: bodyAdmissionFailureReason(res.statusCode) },
        });
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
        observeMetric({
          observer: observabilityObserver,
          metric: "gitlab_mcp.http.admission.rejections",
          attributes: { reason: "missing_token" },
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
        insufficientScopeChallenge,
        res,
        observabilityObserver,
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
        observeMetric({
          observer: observabilityObserver,
          metric: "gitlab_mcp.http.admission.rejections",
          attributes: { reason: "identity_concurrency" },
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
