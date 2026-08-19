import { BlockList, isIP } from "node:net";

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
const PRIVATE_DEVELOPMENT_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];
const PRIVATE_DEVELOPMENT_IPS = new BlockList();

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
          throw new GitLabApiError(
            `GitLab ${label} exceeds the ${maxBytes}-byte safety limit.`,
            { status: response.status, method, path },
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
    throw error;
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
  if (!text) {
    return truncated ? { truncated: true } : undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return truncated ? { truncated: true, preview: parsed } : parsed;
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
  } = {}) {
    if (!token) {
      throw new GitLabAuthenticationError();
    }
    this.baseUrl = normalizeGitLabUrl(baseUrl, { allowInsecureHttp });
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxTextBytes = maxTextBytes;
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
      let response = await this.fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });

      // Some self-managed GitLab versions reject resource access tokens sent
      // through PRIVATE-TOKEN even though the same token is accepted as a
      // bearer credential. Retry only an authentication rejection and only
      // for a recognized access token prefix; all other failures preserve the
      // original request behavior and error details.
      if (response.status === 401 && this.token.startsWith("glpat-")) {
        await response.body?.cancel().catch(() => undefined);
        const fallbackHeaders = {
          ...headers,
          ...bearerAuthenticationHeaders(this.token),
        };
        delete fallbackHeaders["PRIVATE-TOKEN"];
        response = await this.fetch(url, {
          method,
          headers: fallbackHeaders,
          body: payload,
          signal: controller.signal,
        });
      }

      if (!response.ok) {
        const details = await parseErrorBody(response, {
          maxBytes,
          ...meta,
          signal: controller.signal,
        });
        throw new GitLabApiError(
          `GitLab API returned ${response.status} ${response.statusText}.`,
          { ...meta, status: response.status, response: details },
        );
      }

      if (response.status === 204) {
        return { data: { success: true } };
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > maxBytes) {
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

      const data = this.#parseResponseBody(bytes, responseType, response, meta);
      const pagination = paginationFromHeaders(response.headers);
      return pagination ? { data, pagination } : { data };
    } catch (error) {
      if (error instanceof GitLabApiError) {
        throw error;
      }
      const message =
        error?.name === "AbortError" || controller.signal.aborted
          ? `GitLab request timed out after ${this.timeoutMs} ms.`
          : `GitLab request failed: ${error?.message || String(error)}`;
      throw new GitLabApiError(message, meta);
    } finally {
      clearTimeout(timer);
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
