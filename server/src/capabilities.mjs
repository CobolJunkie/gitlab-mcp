import { createHash } from "node:crypto";

import { GitLabApiError, projectApiPath } from "./gitlab-client.mjs";
import { observeMetric } from "./observability.mjs";

export const CAPABILITY_CACHE_TTL_MS = 60_000;
export const CAPABILITY_CACHE_MAX_ENTRIES = 256;

const capabilityCache = new Map();
const STATES = new Set([
  "available",
  "unavailable",
  "permission_required",
  "license_required",
  "not_configured",
  "unknown",
]);

function redactText(value) {
  return String(value)
    .replace(/\b(Bearer|Private-Token|Job-Token)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(access_token|private_token|job_token|refresh_token|token)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 500);
}

function safeErrorText(error) {
  const response = error?.response;
  const candidate =
    typeof response === "string"
      ? response
      : response?.message || response?.error || error?.message || "";
  return redactText(candidate);
}

export function normalizeCapabilityError(error) {
  const status = error instanceof GitLabApiError ? error.status : undefined;
  const message = safeErrorText(error);
  const lower = message.toLowerCase();

  // Strong HTTP-status evidence determines the primary classification.
  // A 401/403/404 status is a more reliable signal than body text, which
  // can mention "disabled" or "licensed" even when the real problem is a
  // permission or authentication failure.
  if (status === 401) {
    return {
      category: "authentication_failure",
      state: "unavailable",
      reason: "GitLab rejected the credential for this endpoint.",
      status,
    };
  }
  if (status === 403) {
    return {
      category: "insufficient_permission",
      state: "permission_required",
      reason:
        "The credential is authenticated but lacks permission for this endpoint.",
      status,
    };
  }
  if (status === 404) {
    return {
      category: "unsupported_endpoint_or_server_version",
      state: "unknown",
      reason:
        "The endpoint is absent, unsupported by this GitLab version, or intentionally hidden; GitLab does not disambiguate these cases.",
      status,
    };
  }
  // Text-based refinement is retained only where status evidence is
  // insufficient (e.g. non-HTTP errors or ambiguous statuses).
  if (
    /\b(ultimate|premium|licensed feature|license required|requires a license|paid feature)\b/.test(
      lower,
    )
  ) {
    return {
      category: "licensed_feature_unavailable",
      state: "license_required",
      reason:
        "GitLab reports that this feature requires a license or higher tier.",
      status,
    };
  }
  if (
    /\b(disabled|not configured|configuration required|not enabled|no .* configured)\b/.test(
      lower,
    )
  ) {
    return {
      category: "feature_disabled_or_not_configured",
      state: "not_configured",
      reason: "GitLab reports that this feature is disabled or not configured.",
      status,
    };
  }
  if (
    status === 429 ||
    (status >= 500 && status <= 599) ||
    status === undefined
  ) {
    return {
      category: "transient_server_or_network_failure",
      state: "unknown",
      reason:
        "A transient GitLab server, rate-limit, timeout, or network failure prevented discovery.",
      status,
    };
  }
  return {
    category: "unknown_failure",
    state: "unknown",
    reason:
      "GitLab did not provide enough evidence to classify this discovery failure.",
    status,
  };
}

export function capabilityCacheIdentity(baseUrl, token, project) {
  const digest = createHash("sha256")
    .update(`gitlab-capabilities\0${baseUrl}\0${token}\0${project ?? ""}`)
    .digest("hex");
  return `${baseUrl}\0sha256:${digest}`;
}

export function clearGitLabCapabilityCache() {
  capabilityCache.clear();
}

export function getGitLabCapabilityCacheSize() {
  return capabilityCache.size;
}

function sweepExpiredCapabilityCacheEntries(now, retainedKey) {
  for (const [key, entry] of capabilityCache) {
    if (key !== retainedKey && entry.expiresAt <= now) {
      capabilityCache.delete(key);
    }
  }
}

function setCapabilityCacheEntry(key, entry) {
  // Map iteration order provides a small LRU queue when hits and writes are
  // moved to the end.
  capabilityCache.delete(key);
  capabilityCache.set(key, entry);
  while (capabilityCache.size > CAPABILITY_CACHE_MAX_ENTRIES) {
    capabilityCache.delete(capabilityCache.keys().next().value);
  }
}

function result(state, reason, evidence) {
  if (!STATES.has(state)) {
    throw new Error(`Invalid capability state: ${state}`);
  }
  return {
    state,
    reason,
    ...(evidence ? { evidence } : {}),
  };
}

async function probe(client, name, path) {
  try {
    const response = await client.request(path);
    return { name, ok: true, data: response.data, status: 200 };
  } catch (error) {
    return { name, ok: false, error: normalizeCapabilityError(error) };
  }
}

function instanceKind(baseUrl) {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname === "gitlab.com" ? "gitlab.com" : "self_managed_or_dedicated";
}

function compactUser(user) {
  if (!user) return undefined;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    state: user.state,
    ...(typeof user.is_admin === "boolean" ? { isAdmin: user.is_admin } : {}),
  };
}

function compactScopes(tokenInfo) {
  if (!tokenInfo) return undefined;
  return {
    tokenType: "personal_access_token",
    scopes: Array.isArray(tokenInfo.scopes) ? tokenInfo.scopes : undefined,
    expiresAt: tokenInfo.expires_at || undefined,
    active:
      typeof tokenInfo.active === "boolean" ? tokenInfo.active : undefined,
  };
}

function compactOAuthToken(tokenInfo, now) {
  if (!tokenInfo) return undefined;
  const expiresInSeconds = Number.isFinite(tokenInfo.expires_in)
    ? tokenInfo.expires_in
    : undefined;
  return {
    tokenType: "oauth_access_token",
    scopes: Array.isArray(tokenInfo.scope) ? tokenInfo.scope : undefined,
    ...(expiresInSeconds !== undefined
      ? {
          expiresInSeconds,
          expiresAt: new Date(now + expiresInSeconds * 1_000).toISOString(),
        }
      : {}),
  };
}

function probeSummary(item) {
  return item.ok
    ? { status: "available", httpStatus: item.status }
    : {
        status: item.error.state,
        category: item.error.category,
        httpStatus: item.error.status,
        reason: item.error.reason,
      };
}

async function discover(client, project) {
  const userProbe = await probe(client, "user", "/user");
  if (!userProbe.ok && userProbe.error.category === "authentication_failure") {
    return {
      userProbe,
      probes: [userProbe],
      project,
      nativeProbes: {},
      version: undefined,
      revision: undefined,
      edition: undefined,
    };
  }

  const [versionProbe, metadataProbe, tokenProbe] = await Promise.all([
    probe(client, "version", "/version"),
    probe(client, "metadata", "/metadata"),
    probe(client, "token", "/personal_access_tokens/self"),
  ]);
  const oauthTokenProbe = tokenProbe.ok
    ? undefined
    : await probe(
        client,
        "oauthToken",
        new URL("oauth/token/info", `${client.baseUrl}/`),
      );
  const projectBase =
    project !== undefined ? projectApiPath(project) : undefined;
  const nativeProbes = projectBase
    ? await Promise.all([
        probe(client, "projectRunners", `${projectBase}/runners?per_page=1`),
        probe(
          client,
          "protectedBranches",
          `${projectBase}/protected_branches?per_page=1`,
        ),
        probe(
          client,
          "projectApprovalRules",
          `${projectBase}/approval_rules?per_page=1`,
        ),
        probe(client, "tags", `${projectBase}/repository/tags?per_page=1`),
        probe(client, "releases", `${projectBase}/releases?per_page=1`),
        probe(
          client,
          "pipelineSchedules",
          `${projectBase}/pipeline_schedules?per_page=1`,
        ),
        probe(
          client,
          "protectedTags",
          `${projectBase}/protected_tags?per_page=1`,
        ),
      ])
    : [];
  const versionData = versionProbe.ok ? versionProbe.data : metadataProbe.data;
  return {
    userProbe,
    versionProbe,
    metadataProbe,
    tokenProbe,
    oauthTokenProbe,
    probes: [
      userProbe,
      versionProbe,
      metadataProbe,
      tokenProbe,
      ...(oauthTokenProbe ? [oauthTokenProbe] : []),
      ...nativeProbes,
    ],
    project,
    nativeProbes: Object.fromEntries(
      nativeProbes.map((item) => [item.name, item]),
    ),
    version: versionData?.version,
    revision: versionData?.revision,
    edition: (() => {
      if (typeof metadataProbe.data?.enterprise !== "boolean") return undefined;
      return metadataProbe.data.enterprise ? "enterprise" : "community";
    })(),
  };
}

function buildVersionOutcome(discovered) {
  if (discovered.version) {
    return result("available", "GitLab exposed version metadata.", {
      source: discovered.versionProbe?.ok ? "/version" : "/metadata",
      version: discovered.version,
      revision: discovered.revision,
    });
  }
  return result(
    discovered.versionProbe?.error?.state || "unknown",
    discovered.versionProbe?.error?.reason ||
      "GitLab did not expose version metadata.",
    { source: "/version" },
  );
}

function buildScopeOutcome(discovered, tokenInfo, oauthTokenInfo) {
  if (tokenInfo) {
    return result(
      "available",
      "GitLab exposed metadata for the current personal access token.",
      {
        source: "/personal_access_tokens/self",
        scopes: tokenInfo.scopes,
      },
    );
  }
  if (oauthTokenInfo) {
    return result(
      "available",
      "GitLab exposed metadata for the current OAuth access token.",
      {
        source: "/oauth/token/info",
        scopes: oauthTokenInfo.scope,
        ...(Number.isFinite(oauthTokenInfo.expires_in)
          ? { expiresInSeconds: oauthTokenInfo.expires_in }
          : {}),
      },
    );
  }
  let tokenMetadataState;
  if (
    discovered.oauthTokenProbe?.error?.category === "authentication_failure" ||
    discovered.tokenProbe?.error?.category === "authentication_failure"
  ) {
    tokenMetadataState = "unknown";
  } else {
    tokenMetadataState =
      discovered.oauthTokenProbe?.error?.state ||
      discovered.tokenProbe?.error?.state ||
      "unknown";
  }
  return result(
    tokenMetadataState,
    "Token scopes were not exposed by either the personal-access-token or OAuth token information endpoint.",
    { sources: ["/personal_access_tokens/self", "/oauth/token/info"] },
  );
}

function buildBaseline(discovered, authOk) {
  if (authOk) {
    return result(
      "available",
      "The authenticated GitLab v4 API is reachable. Individual object permissions still apply.",
      { source: "/user" },
    );
  }
  return result(
    discovered.userProbe.error.state,
    discovered.userProbe.error.reason,
    { source: "/user" },
  );
}

function resolveProjectProbe(
  discovered,
  authOk,
  baseline,
  name,
  availableReason,
) {
  if (!authOk) {
    return baseline;
  }
  if (discovered.project === undefined) {
    return result(
      "unknown",
      "Provide a project ID or path to probe this project-scoped capability.",
    );
  }
  const item = discovered.nativeProbes?.[name];
  if (item?.ok) {
    return result("available", availableReason, {
      source: item.name,
      project: discovered.project,
    });
  }
  return result(
    item?.error?.state || "unknown",
    item?.error?.reason ||
      "GitLab did not provide enough evidence for this capability.",
    {
      source: item?.name || name,
      project: discovered.project,
      ...(item?.error?.status ? { httpStatus: item.error.status } : {}),
    },
  );
}

function shape(client, discovered, { detailed, cacheStatus, now, ttlMs }) {
  const user = discovered.userProbe.ok ? discovered.userProbe.data : undefined;
  const tokenInfo = discovered.tokenProbe?.ok
    ? discovered.tokenProbe.data
    : undefined;
  const oauthTokenInfo = discovered.oauthTokenProbe?.ok
    ? discovered.oauthTokenProbe.data
    : undefined;
  const authOk = discovered.userProbe.ok;
  const versionOutcome = buildVersionOutcome(discovered);
  const scopeOutcome = buildScopeOutcome(discovered, tokenInfo, oauthTokenInfo);
  const baseline = buildBaseline(discovered, authOk);
  const projectProbe = (name, availableReason) =>
    resolveProjectProbe(discovered, authOk, baseline, name, availableReason);

  const capabilities = {
    authenticated_api: baseline,
    version_metadata: versionOutcome,
    token_scope_metadata: scopeOutcome,
    projects_and_repository: baseline,
    issues_and_merge_requests: baseline,
    review_discussions_and_approvals: authOk
      ? result(
          "unknown",
          "Discussion APIs are broadly available, but approval rules and enforcement can depend on project permissions, tier, and configuration.",
        )
      : baseline,
    pipelines_jobs_and_artifacts: authOk
      ? result(
          "unknown",
          "CI APIs exist, but availability depends on project access and whether CI is configured.",
        )
      : baseline,
    project_runners: projectProbe(
      "projectRunners",
      "GitLab returned project runner metadata without authentication tokens.",
    ),
    ci_configuration_lint: (() => {
      if (!authOk) return baseline;
      if (discovered.project === undefined) {
        return result(
          "unknown",
          "Provide a project ID or path to lint CI configuration in project context.",
        );
      }
      return result(
        "unknown",
        "Discovery does not submit synthetic CI configuration; call lint_ci_configuration to obtain direct project evidence.",
        { project: discovered.project },
      );
    })(),
    protected_branches: projectProbe(
      "protectedBranches",
      "GitLab returned protected-branch policy for the project.",
    ),
    project_approval_rules: projectProbe(
      "projectApprovalRules",
      "GitLab returned project-level merge-request approval rules.",
    ),
    repository_tags: projectProbe(
      "tags",
      "GitLab returned repository tags for the project.",
    ),
    releases: projectProbe(
      "releases",
      "GitLab returned releases for the project.",
    ),
    pipeline_schedules: projectProbe(
      "pipelineSchedules",
      "GitLab returned pipeline schedules for the project.",
    ),
    protected_tags: projectProbe(
      "protectedTags",
      "GitLab returned protected-tag policy for the project.",
    ),
    advanced_search: result(
      "unknown",
      "Advanced and Zoekt search depend on tier and instance configuration; no safe global probe is conclusive.",
    ),
    administrator_api: (() => {
      if (typeof user?.is_admin === "boolean") {
        const state = user.is_admin ? "available" : "permission_required";
        const reason = user.is_admin
          ? "GitLab explicitly identified the current user as an administrator."
          : "GitLab explicitly identified the current user as a non-administrator.";
        return result(state, reason, {
          source: "/user",
          isAdmin: user.is_admin,
        });
      }
      return result(
        "unknown",
        "GitLab did not expose administrator status for the current identity.",
      );
    })(),
  };

  return {
    schemaVersion: 1,
    instance: {
      url: client.baseUrl,
      kind: instanceKind(client.baseUrl),
      ...(discovered.version ? { version: discovered.version } : {}),
      ...(discovered.revision ? { revision: discovered.revision } : {}),
      ...(discovered.edition ? { edition: discovered.edition } : {}),
    },
    identity: compactUser(user),
    authentication:
      compactScopes(tokenInfo) || compactOAuthToken(oauthTokenInfo, now),
    capabilities,
    cache: {
      status: cacheStatus,
      ttlSeconds: Math.floor(ttlMs / 1000),
      expiresAt: new Date(now + ttlMs).toISOString(),
      keying:
        "normalized instance URL plus one-way SHA-256 credential identity",
    },
    ...(detailed
      ? {
          probes: Object.fromEntries(
            discovered.probes.map((item) => [item.name, probeSummary(item)]),
          ),
          notes: [
            "A 404 can mean unsupported, hidden, or unavailable on this server version.",
            "Project-level permissions, licensing, and configuration require project context and remain unknown when no conclusive global evidence exists.",
          ],
        }
      : {}),
  };
}

export async function getGitLabCapabilities(
  client,
  {
    detailed = false,
    refresh = false,
    project,
    now = Date.now(),
    ttlMs = CAPABILITY_CACHE_TTL_MS,
  } = {},
) {
  const key = capabilityCacheIdentity(client.baseUrl, client.token, project);
  let cached = capabilityCache.get(key);
  sweepExpiredCapabilityCacheEntries(now, key);
  const cacheHit = !refresh && cached && cached.expiresAt > now;
  observeMetric({
    observer: client.observabilityObserver,
    metric: "gitlab_mcp.cache.requests",
    attributes: { cache: "capability", result: cacheHit ? "hit" : "miss" },
  });
  observeMetric({
    observer: client.observabilityObserver,
    metric: "gitlab_mcp.cache.entries",
    value: capabilityCache.size,
    attributes: { cache: "capability" },
  });
  observeMetric({
    observer: client.observabilityObserver,
    metric: "gitlab_mcp.cache.capacity",
    value: CAPABILITY_CACHE_MAX_ENTRIES,
    attributes: { cache: "capability" },
  });
  if (cacheHit) {
    setCapabilityCacheEntry(key, cached);
    return shape(client, cached.value, {
      detailed,
      cacheStatus: "hit",
      now: cached.createdAt,
      ttlMs,
    });
  }

  const value = await discover(client, project);
  setCapabilityCacheEntry(key, {
    value,
    createdAt: now,
    expiresAt: now + ttlMs,
  });
  let cacheStatus;
  if (refresh) {
    cacheStatus = "refreshed";
  } else if (cached) {
    cacheStatus = "expired";
  } else {
    cacheStatus = "miss";
  }
  return shape(client, value, {
    detailed,
    cacheStatus,
    now,
    ttlMs,
  });
}
