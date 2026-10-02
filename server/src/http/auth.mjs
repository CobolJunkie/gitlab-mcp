import { createHash } from "node:crypto";

import { GitLabApiError, GitLabClient } from "../gitlab-client.mjs";
import {
  observationDurationMs,
  observationStartedAt,
  observeMetric,
} from "../observability.mjs";

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

export function bearerToken(req) {
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
  observabilityObserver,
}) {
  const client = new GitLabClient({
    baseUrl: gitlabUrl,
    token,
    allowInsecureHttp,
    timeoutMs: 10_000,
    observabilityObserver,
  });
  return (await client.request("/user")).data;
}

function tokenValidationFailureKind(error) {
  if (!(error instanceof GitLabApiError)) {
    return "upstream_failure";
  }
  if (error.status === 401) {
    return "invalid_token";
  }
  if (error.status === 403) {
    return "insufficient_scope";
  }
  return "upstream_failure";
}

export async function validateToken({
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
}) {
  const startedAt = observationStartedAt();
  const tokenKey = createHash("sha256").update(token).digest("hex");
  const requestTime = now();
  let identity = cacheGet(validatedTokens, tokenKey, requestTime);
  observeMetric({
    observer: observabilityObserver,
    metric: "gitlab_mcp.cache.requests",
    attributes: {
      cache: "token_validation",
      result: identity ? "hit" : "miss",
    },
  });
  observeMetric({
    observer: observabilityObserver,
    metric: "gitlab_mcp.cache.entries",
    value: validatedTokens.size,
    attributes: { cache: "token_validation" },
  });
  observeMetric({
    observer: observabilityObserver,
    metric: "gitlab_mcp.cache.capacity",
    value: tokenValidationMaxEntries,
    attributes: { cache: "token_validation" },
  });
  if (identity) {
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.auth.validation.duration",
      value: observationDurationMs(startedAt) / 1_000,
      attributes: { outcome: "cached" },
    });
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
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.http.admission.rejections",
      attributes: { reason: "token_failure_limit" },
    });
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.auth.validation.duration",
      value: observationDurationMs(startedAt) / 1_000,
      attributes: { outcome: "rejected" },
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
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.http.admission.rejections",
      attributes: { reason: "validation_budget" },
    });
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.auth.validation.duration",
      value: observationDurationMs(startedAt) / 1_000,
      attributes: { outcome: "rejected" },
    });
    return undefined;
  }

  try {
    identity = await tokenValidator({
      gitlabUrl,
      token,
      allowInsecureHttp: allowInsecureGitLabUrl,
      observabilityObserver,
    });
    cacheSet(
      validatedTokens,
      tokenKey,
      identity,
      now() + tokenValidationTtlMs,
      now(),
      tokenValidationMaxEntries,
    );
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.auth.validation.duration",
      value: observationDurationMs(startedAt) / 1_000,
      attributes: { outcome: "success" },
    });
  } catch (error) {
    const failureKind = tokenValidationFailureKind(error);

    if (failureKind === "invalid_token") {
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
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.http.admission.rejections",
        attributes: { reason: "invalid_token" },
      });
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.auth.validation.duration",
        value: observationDurationMs(startedAt) / 1_000,
        attributes: { outcome: "rejected" },
      });
      return undefined;
    }

    if (failureKind === "insufficient_scope") {
      validatedTokens.delete(tokenKey);
      res.status(403).set("WWW-Authenticate", insufficientScopeChallenge).json({
        error: "insufficient_scope",
        message:
          "GitLab did not authorize the connected access token for the required scope.",
      });
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.http.admission.rejections",
        attributes: { reason: "insufficient_scope" },
      });
      observeMetric({
        observer: observabilityObserver,
        metric: "gitlab_mcp.auth.validation.duration",
        value: observationDurationMs(startedAt) / 1_000,
        attributes: { outcome: "rejected" },
      });
      return undefined;
    }

    res.status(503).json({
      error: "temporarily_unavailable",
      message:
        "GitLab token validation is temporarily unavailable. Retry later.",
    });
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.http.admission.rejections",
      attributes: { reason: "token_validation_unavailable" },
    });
    observeMetric({
      observer: observabilityObserver,
      metric: "gitlab_mcp.auth.validation.duration",
      value: observationDurationMs(startedAt) / 1_000,
      attributes: { outcome: "error" },
    });
    return undefined;
  }

  return { identity, tokenKey };
}
