import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express from "express";

import { observationStartedAt, observeHttpRequest } from "../observability.mjs";
import { isLoopbackBindHost } from "./policy.mjs";

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  // Keep a leading BOM in the decoded text so JSON.parse rejects it as before.
  ignoreBOM: true,
});

export function jsonRpcError(res, status, code, message) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

export function createBoundedMcpExpressApp({
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
  } else if (isLoopbackBindHost(host)) {
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
 *   - TypeError                     malformed UTF-8
 *
 * When `readTimeoutMs` is set, the reader enforces one absolute deadline from
 * the start of body reading. Incoming chunks do not extend it, preventing
 * slow-trickle clients from holding admission slots indefinitely.
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
      if (error?.type === "request.timeout") req.pause();
      if (error) reject(error);
      else resolve(result);
    };

    const onData = (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        const error = new Error("Request body too large");
        error.type = "entity.too.large";
        settle(error);
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      try {
        const combined =
          chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        settle(null, JSON.parse(STRICT_UTF8_DECODER.decode(combined)));
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
      timer.unref?.();
    }
  });
}

/**
 * Parse the MCP request body with error mapping.  Returns the parsed
 * body on success or undefined if an error response was already sent.
 */
export async function parseMcpBody(req, res, limitBytes, readTimeoutMs) {
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
    if (error instanceof SyntaxError || error instanceof TypeError) {
      jsonRpcError(res, 400, -32700, "Parse error.");
      return undefined;
    }
    if (error?.type === "request.timeout") {
      // Stop consuming the unread body, but keep the socket alive long enough
      // to deliver the sanitized timeout response. Closing the connection after
      // that response prevents unread bytes from being reused as another HTTP
      // request on a keep-alive connection.
      const ignoreLateRequestError = () => {};
      req.once("error", ignoreLateRequestError);
      res.set("Connection", "close");
      res.once("close", () => {
        req.removeListener("error", ignoreLateRequestError);
      });
      jsonRpcError(res, 408, -32001, "Request body read timed out.");
      return undefined;
    }
    throw error;
  }
}

export function bodyAdmissionFailureReason(statusCode) {
  if (statusCode === 413) return "body_limit";
  if (statusCode === 408) return "body_timeout";
  return "parse_error";
}
