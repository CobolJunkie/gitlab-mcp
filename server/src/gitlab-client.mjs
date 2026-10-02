import { BlockList, isIP } from "node:net";

import {
  observationDurationMs,
  observationStartedAt,
  observeMetric,
} from "./observability.mjs";
import { SERVER_VERSION } from "./version.mjs";

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_BYTES = 1_000_000;
const DEFAULT_MAX_ERROR_BYTES = 16_384;
const OBSERVED_RESPONSE_BYTES = Symbol("observed_response_bytes");
const PRIVATE_DEVELOPMENT_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];
const PRIVATE_DEVELOPMENT_IPS = new BlockList();
const METRIC_HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
]);

for (const [network, prefix, type] of [
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
]) {
  PRIVATE_DEVELOPMENT_IPS.addSubnet(network, prefix, type);
}

function metricMethod(value) {
  const method = String(value || "GET").toUpperCase();
  return METRIC_HTTP_METHODS.has(method) ? method : "OTHER";
}

function statusClass(status) {
  return Number.isSafeInteger(status) && status >= 200 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : "none";
}

function responseContentLength(response) {
  const raw = response.headers.get("content-length");
  if (raw === null || raw === "") {
    return undefined;
  }
  const contentLength = Number(raw);
  return Number.isSafeInteger(contentLength) && contentLength >= 0
    ? contentLength
    : undefined;
}

function attachObservedResponseBytes(error, value) {
  if (
    !error ||
    (typeof error !== "object" && typeof error !== "function") ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return error;
  }
  try {
    if (error[OBSERVED_RESPONSE_BYTES] === undefined) {
      Object.defineProperty(error, OBSERVED_RESPONSE_BYTES, {
        configurable: false,
        enumerable: false,
        value,
        writable: false,
      });
    }
  } catch {
    // Internal byte accounting must never alter request failure behavior.
  }
  return error;
}

function observedResponseBytes(error) {
  try {
    const value = error?.[OBSERVED_RESPONSE_BYTES];
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function createRequestMetricState(method, responseType) {
  return {
    startedAt: observationStartedAt(),
    method: metricMethod(method),
    responseType: ["json", "text", "binary"].includes(responseType)
      ? responseType
      : "json",
    status: undefined,
    responseObserved: false,
    responseBytes: 0,
    outcome: "error",
  };
}

function markMetricResponse(state, response) {
  state.status = response.status;
  state.responseObserved = true;
}

function resetMetricResponse(state) {
  state.status = undefined;
  state.responseObserved = false;
}

function captureObservedErrorBytes(state, error) {
  const bytesRead = observedResponseBytes(error);
  if (bytesRead !== undefined) {
    state.responseBytes = bytesRead;
  }
}

function responseExceedsLimit(contentLength, maxBytes) {
  return contentLength !== undefined && contentLength > maxBytes;
}

function observeGitLabRetry(observer, state) {
  observeMetric({
    observer,
    metric: "gitlab_mcp.gitlab.retries",
    attributes: {
      reason: "authentication_fallback",
      method: state.method,
    },
  });
}

async function fetchGitLabResponse({
  fetchImpl,
  url,
  method,
  headers,
  payload,
  signal,
  token,
  observer,
  metricState,
}) {
  let response = await fetchImpl(url, {
    method,
    headers,
    body: payload,
    signal,
  });
  markMetricResponse(metricState, response);
  if (response.status !== 401 || !token.startsWith("glpat-")) {
    return response;
  }

  observeGitLabRetry(observer, metricState);
  await response.body?.cancel().catch(() => undefined);
  const fallbackHeaders = {
    ...headers,
    ...bearerAuthenticationHeaders(token),
  };
  delete fallbackHeaders["PRIVATE-TOKEN"];
  resetMetricResponse(metricState);
  response = await fetchImpl(url, {
    method,
    headers: fallbackHeaders,
    body: payload,
    signal,
  });
  markMetricResponse(metricState, response);
  return response;
}

function completeRequestMetrics(observer, state) {
  observeMetric({
    observer,
    metric: "gitlab_mcp.gitlab.request.duration",
    value: observationDurationMs(state.startedAt) / 1_000,
    attributes: {
      method: state.method,
      outcome: state.outcome,
      status_class: statusClass(state.status),
      response_type: state.responseType,
    },
  });
  if (state.responseObserved) {
    observeMetric({
      observer,
      metric: "gitlab_mcp.gitlab.response.size",
      value: state.responseBytes,
      attributes: {
        method: state.method,
        outcome: state.outcome,
        response_type: state.responseType,
      },
    });
  }
}

function isPrivateDevelopmentHostname(value) {
  const hostname = String(value || "")
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  const version = isIP(hostname);
  if (version) {
    return PRIVATE_DEVELOPMENT_IPS.check(
      hostname,
      version === 4 ? "ipv4" : "ipv6",
    );
  }
  return (
    hostname === "localhost" ||
    !hostname.includes(".") ||
    PRIVATE_DEVELOPMENT_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

export class GitLabAuthenticationError extends Error {
  constructor(
    message = "GitLab authentication is required. Set GITLAB_TOKEN for stdio or connect an OAuth Bearer token over HTTP.",
  ) {
    super(message);
    this.name = "GitLabAuthenticationError";
  }
}

export class GitLabApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GitLabApiError";
    this.status = details.status;
    this.method = details.method;
    this.path = details.path;
    this.response = details.response;
    if (details.observabilityCategory === "timeout") {
      Object.defineProperty(this, "observabilityCategory", {
        configurable: false,
        enumerable: false,
        value: "timeout",
        writable: false,
      });
    }
  }

  toJSON() {
    return {
      error: this.name,
      message: this.message,
      status: this.status,
      method: this.method,
      path: this.path,
      response: this.response,
    };
  }
}

export function normalizeGitLabUrl(
  value = process.env.GITLAB_URL,
  {
    allowInsecureHttp = process.env.GITLAB_ALLOW_INSECURE_HTTP === "true",
    production = process.env.NODE_ENV === "production",
  } = {},
) {
  const raw = stripTrailingSlashes((value || "https://gitlab.com").trim());
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("GITLAB_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("GITLAB_URL must not contain embedded credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("GITLAB_URL must not contain a query or fragment.");
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    throw new Error(
      "GITLAB_URL must use HTTPS. Set GITLAB_ALLOW_INSECURE_HTTP=true only for local development.",
    );
  }
  if (
    url.protocol === "http:" &&
    (production || !isPrivateDevelopmentHostname(url.hostname))
  ) {
    throw new Error(
      "GITLAB_ALLOW_INSECURE_HTTP is permitted only outside production for loopback, private-network IP, or private-development hostnames.",
    );
  }
  url.pathname = stripTrailingSlashes(
    url.pathname.replace(/\/api\/v4\/?$/, ""),
  );
  return stripTrailingSlashes(url.toString());
}

export function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

export function projectApiPath(project) {
  return `/projects/${encodePathSegment(project)}`;
}

function appendQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function paginationFromHeaders(headers) {
  const value = (name) => headers.get(name) || undefined;
  const number = (name) => {
    const raw = value(name);
    return raw ? Number(raw) : undefined;
  };

  const pagination = {
    page: number("x-page"),
    perPage: number("x-per-page"),
    nextPage: number("x-next-page"),
    previousPage: number("x-prev-page"),
    total: number("x-total"),
    totalPages: number("x-total-pages"),
  };

  return Object.values(pagination).some((item) => item !== undefined)
    ? pagination
    : undefined;
}

function abortError() {
  const error = new Error("GitLab response body read aborted.");
  error.name = "AbortError";
  return error;
}

async function readWithSignal(reader, signal) {
  if (signal.aborted) {
    throw abortError();
  }
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(
  response,
  { maxBytes, method, path, signal, label = "response", truncate = false },
) {
  const reader = response.body?.getReader();
  if (!reader) {
    return { bytes: Buffer.alloc(0), truncated: false };
  }

  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) {
        return {
          bytes: Buffer.concat(chunks, length),
          truncated: false,
        };
      }

      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      const remaining = maxBytes - length;
      if (chunk.length > remaining) {
        if (!truncate) {
          await reader.cancel().catch(() => undefined);
          throw attachObservedResponseBytes(
            new GitLabApiError(
              `GitLab ${label} exceeds the ${maxBytes}-byte safety limit.`,
              { status: response.status, method, path },
            ),
            length + chunk.length,
          );
        }
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          length += remaining;
        }
        await reader.cancel().catch(() => undefined);
        return {
          bytes: Buffer.concat(chunks, length),
          truncated: true,
        };
      }
      chunks.push(chunk);
      length += chunk.length;
    }
  } catch (error) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
    }
    throw attachObservedResponseBytes(error, length);
  } finally {
    reader.releaseLock();
  }
}

async function parseErrorBody(response, context) {
  const { bytes, truncated } = await readBoundedBody(response, {
    ...context,
    maxBytes: Math.min(context.maxBytes, DEFAULT_MAX_ERROR_BYTES),
    label: "error response",
    truncate: true,
  });
  const text = bytes.toString("utf8");
  let details;
  if (!text) {
    details = truncated ? { truncated: true } : undefined;
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    details = truncated ? { truncated: true, preview: parsed } : parsed;
  }
  return { details, bytesRead: bytes.length };
}

function responseTypeLabel(responseType) {
  if (responseType === "binary") {
    return "binary response";
  }
  if (responseType === "text") {
    return "text response";
  }
  return "JSON response";
}

function authenticationHeaders(token) {
  // GitLab personal, project, and group access tokens conventionally use the
  // PRIVATE-TOKEN header. OAuth tokens keep the Authorization header.
  return token.startsWith("glpat-")
    ? { "PRIVATE-TOKEN": token }
    : { Authorization: `Bearer ${token}` };
}

function bearerAuthenticationHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

export class GitLabClient {
  constructor({
    allowInsecureHttp = process.env.GITLAB_ALLOW_INSECURE_HTTP === "true",
    baseUrl = normalizeGitLabUrl(undefined, { allowInsecureHttp }),
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
    observabilityObserver,
  } = {}) {
    if (!token) {
      throw new GitLabAuthenticationError();
    }
    this.baseUrl = normalizeGitLabUrl(baseUrl, { allowInsecureHttp });
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxTextBytes = maxTextBytes;
    this.observabilityObserver = observabilityObserver;
  }

  async request(
    path,
    {
      method = "GET",
      query,
      body,
      responseType = "json",
      maxBytes = this.maxTextBytes,
    } = {},
  ) {
    const metricState = createRequestMetricState(method, responseType);
    const url =
      path instanceof URL
        ? new URL(path)
        : new URL(`${this.baseUrl}/api/v4${path}`);
    this.#validateRequestOrigin(url, path, method);
    const errorPath =
      path instanceof URL ? `${url.pathname}${url.search}` : path;
    appendQuery(url, query);

    // Single source of truth for request metadata shared by all error paths.
    const meta = { method, path: errorPath };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      Accept:
        responseType === "binary"
          ? "application/octet-stream"
          : "application/json",
      ...authenticationHeaders(this.token),
      "User-Agent": `gitlab-mcp/${SERVER_VERSION}`,
    };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    try {
      const response = await fetchGitLabResponse({
        fetchImpl: this.fetch,
        url,
        method,
        headers,
        payload,
        signal: controller.signal,
        token: this.token,
        observer: this.observabilityObserver,
        metricState,
      });

      if (!response.ok) {
        const contentLength = responseContentLength(response);
        const { details, bytesRead } = await parseErrorBody(response, {
          maxBytes,
          ...meta,
          signal: controller.signal,
        }).catch((error) => {
          const failure = new GitLabApiError(
            `GitLab API returned ${response.status} ${response.statusText}, but its error response body could not be read.`,
            {
              ...meta,
              status: response.status,
              ...(error?.name === "AbortError" || controller.signal.aborted
                ? { observabilityCategory: "timeout" }
                : undefined),
            },
          );
          throw attachObservedResponseBytes(
            failure,
            observedResponseBytes(error),
          );
        });
        metricState.responseBytes = contentLength ?? bytesRead;
        throw new GitLabApiError(
          `GitLab API returned ${response.status} ${response.statusText}.`,
          { ...meta, status: response.status, response: details },
        );
      }

      if (response.status === 204) {
        metricState.outcome = "success";
        return { data: { success: true } };
      }

      const contentLength = responseContentLength(response);
      if (responseExceedsLimit(contentLength, maxBytes)) {
        metricState.responseBytes = contentLength;
        await response.body?.cancel().catch(() => undefined);
        throw new GitLabApiError(
          `GitLab response is ${contentLength} bytes, above the ${maxBytes}-byte safety limit.`,
          { ...meta, status: response.status },
        );
      }

      const label = responseTypeLabel(responseType);
      const { bytes } = await readBoundedBody(response, {
        maxBytes,
        ...meta,
        signal: controller.signal,
        label,
      });
      metricState.responseBytes = contentLength ?? bytes.length;

      const data = this.#parseResponseBody(bytes, responseType, response, meta);
      const pagination = paginationFromHeaders(response.headers);
      metricState.outcome = "success";
      return pagination ? { data, pagination } : { data };
    } catch (error) {
      captureObservedErrorBytes(metricState, error);
      if (error instanceof GitLabApiError) {
        throw error;
      }
      const timedOut =
        error?.name === "AbortError" || controller.signal.aborted;
      const message = timedOut
        ? `GitLab request timed out after ${this.timeoutMs} ms.`
        : `GitLab request failed: ${error?.message || String(error)}`;
      throw new GitLabApiError(message, {
        ...meta,
        ...(timedOut ? { observabilityCategory: "timeout" } : undefined),
      });
    } finally {
      clearTimeout(timer);
      completeRequestMetrics(this.observabilityObserver, metricState);
    }
  }

  #validateRequestOrigin(url, path, method) {
    const configuredUrl = new URL(this.baseUrl);
    const configuredPath = stripTrailingSlashes(configuredUrl.pathname);
    const outsideConfiguredPath =
      path instanceof URL &&
      configuredPath &&
      configuredPath !== "/" &&
      url.pathname !== configuredPath &&
      !url.pathname.startsWith(`${configuredPath}/`);
    if (url.origin !== configuredUrl.origin || outsideConfiguredPath) {
      throw new GitLabApiError(
        "GitLab request URL must use the configured GitLab origin and path.",
        { method, path: url.pathname },
      );
    }
  }

  #parseResponseBody(bytes, responseType, response, meta) {
    if (responseType === "text") {
      return bytes.toString("utf8");
    }
    if (responseType === "binary") {
      return {
        encoding: "base64",
        contentType:
          response.headers.get("content-type") || "application/octet-stream",
        contentLength: bytes.length,
        content: bytes.toString("base64"),
      };
    }
    const text = bytes.toString("utf8");
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new GitLabApiError(
        "GitLab API returned an invalid JSON response.",
        { ...meta, status: response.status },
      );
    }
  }
}

export function tokenFromContext(extra) {
  return (
    extra?.authInfo?.token ||
    process.env.GITLAB_TOKEN ||
    process.env.GITLAB_PRIVATE_TOKEN ||
    undefined
  );
}
