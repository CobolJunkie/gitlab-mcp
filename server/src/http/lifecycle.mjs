import { createHttpApp } from "./app.mjs";
import {
  DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS,
  MAX_HTTP_SHUTDOWN_TIMEOUT_MS,
  positiveInteger,
} from "./policy.mjs";

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
