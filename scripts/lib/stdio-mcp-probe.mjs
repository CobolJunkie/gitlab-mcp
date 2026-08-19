import { spawn } from "node:child_process";

const DIAGNOSTIC_LIMIT = 2_000;
export const MCP_PROTOCOL_VERSION = "2025-11-25";
const PROTOCOL_LINE_LIMIT = 1_048_576;
const TERMINATION_GRACE_MS = 1_000;

function boundedDiagnostic(value) {
  const text = String(value ?? "");
  if (text.length <= DIAGNOSTIC_LIMIT) return text;
  return `${text.slice(0, DIAGNOSTIC_LIMIT)}…[truncated]`;
}

function appendDiagnostic(current, chunk) {
  if (current.length >= DIAGNOSTIC_LIMIT) return current;
  return boundedDiagnostic(current + chunk);
}

function rejectPending(pending, error) {
  for (const { reject } of pending.values()) {
    reject(error);
  }
  pending.clear();
}

function streamError(label, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`MCP stdio ${label} failed: ${boundedDiagnostic(detail)}`);
}

function jsonRpcFailure(method, error) {
  return new Error(
    `MCP ${method} failed: ${boundedDiagnostic(JSON.stringify(error))}`,
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function classifyInboundMessage(message) {
  const hasMethod = Object.hasOwn(message, "method");
  if (
    hasMethod &&
    (message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      !message.method)
  ) {
    return "invalid";
  }
  if (hasMethod) {
    return Object.hasOwn(message, "id") ? "request" : "notification";
  }
  return Object.hasOwn(message, "id") ? "response" : "invalid";
}

function serverRequestResponse(message) {
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id: message.id, result: {} };
  }
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  };
}

function dispatchInboundMessage(message, pending, writeMessage, fail) {
  const messageKind = classifyInboundMessage(message);
  if (messageKind === "notification") return;

  if (messageKind === "request") {
    writeMessage(serverRequestResponse(message)).catch(fail);
    return;
  }

  if (messageKind === "invalid") {
    fail(
      new Error(
        `MCP stdio emitted an invalid JSON-RPC message: ${boundedDiagnostic(JSON.stringify(message))}`,
      ),
    );
    return;
  }

  const pendingRequest = pending.get(message.id);
  if (!pendingRequest) {
    fail(
      new Error(
        `MCP stdio emitted a response with unknown request id ${boundedDiagnostic(message.id)}.`,
      ),
    );
    return;
  }
  pending.delete(message.id);
  pendingRequest.resolve(message);
}

function assertJsonRpcResponse(message, requestId, method) {
  if (message.jsonrpc !== "2.0") {
    throw new Error(`MCP ${method} response must use JSON-RPC 2.0.`);
  }
  if (message.id !== requestId) {
    throw new Error(
      `MCP ${method} response id must match request ${requestId}.`,
    );
  }

  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasResult === hasError) {
    throw new Error(
      `MCP ${method} response must contain exactly one of result or error.`,
    );
  }
  if (hasError && !isObject(message.error)) {
    throw new Error(`MCP ${method} response error must be an object.`);
  }
}

function assertInitializeResult(result) {
  if (!isObject(result)) {
    throw new Error("MCP initialize result must be an object.");
  }
  if (typeof result.protocolVersion !== "string" || !result.protocolVersion) {
    throw new Error(
      "MCP initialize result must contain a non-empty protocolVersion.",
    );
  }
  if (result.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Error(
      `MCP initialize negotiated unsupported protocolVersion ${boundedDiagnostic(result.protocolVersion)}; expected ${MCP_PROTOCOL_VERSION}.`,
    );
  }
  if (!isObject(result.capabilities)) {
    throw new Error("MCP initialize result capabilities must be an object.");
  }
  if (!isObject(result.serverInfo)) {
    throw new Error("MCP initialize result serverInfo must be an object.");
  }
  if (typeof result.serverInfo.name !== "string" || !result.serverInfo.name) {
    throw new Error(
      "MCP initialize result serverInfo.name must be a non-empty string.",
    );
  }
  if (
    typeof result.serverInfo.version !== "string" ||
    !result.serverInfo.version
  ) {
    throw new Error(
      "MCP initialize result serverInfo.version must be a non-empty string.",
    );
  }
}

export async function probeStdioMcp({
  command,
  args,
  env,
  clientInfo,
  timeoutMs = 10_000,
}) {
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let output = "";
  let stderr = "";
  let terminalError;
  let stopping = false;
  let childClosed = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const fail = (error) => {
    if (stopping || terminalError) return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    rejectPending(pending, terminalError);
  };

  const writeMessage = (message) =>
    new Promise((resolve, reject) => {
      if (terminalError) {
        reject(terminalError);
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(streamError("stdin write", error));
          else resolve();
        });
      } catch (error) {
        reject(streamError("stdin write", error));
      }
    });

  const failOversizedProtocolLine = (lineLength) => {
    const diagnostic = boundedDiagnostic(output);
    output = "";
    fail(
      new Error(
        `MCP stdio protocol line exceeded ${PROTOCOL_LINE_LIMIT} characters (received at least ${lineLength}): ${diagnostic}`,
      ),
    );
  };

  const onStdoutData = (chunk) => {
    if (stopping) return;
    output += chunk;
    let newlineIndex;
    while ((newlineIndex = output.indexOf("\n")) !== -1) {
      if (newlineIndex > PROTOCOL_LINE_LIMIT) {
        failOversizedProtocolLine(newlineIndex);
        return;
      }

      const line = output.slice(0, newlineIndex).trim();
      output = output.slice(newlineIndex + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(
          new Error(
            `MCP stdio emitted invalid JSON: ${boundedDiagnostic(line)}`,
          ),
        );
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        fail(
          new Error(
            `MCP stdio emitted a non-object JSON message: ${boundedDiagnostic(line)}`,
          ),
        );
        return;
      }

      dispatchInboundMessage(message, pending, writeMessage, fail);
      if (terminalError) return;
    }

    if (output.length > PROTOCOL_LINE_LIMIT) {
      failOversizedProtocolLine(output.length);
    }
  };
  const onStderrData = (chunk) => {
    stderr = appendDiagnostic(stderr, chunk);
  };
  const onChildError = (error) => fail(streamError("process", error));
  const onStdinError = (error) => fail(streamError("stdin", error));
  const onStdoutError = (error) => fail(streamError("stdout", error));
  const onStderrError = (error) => fail(streamError("stderr", error));
  const onChildExit = (code, signal) => {
    if (stopping) return;
    fail(
      new Error(
        `MCP stdio process exited before probe completion (code=${code}, signal=${signal}): ${boundedDiagnostic(stderr)}`,
      ),
    );
  };
  const onChildClose = () => {
    childClosed = true;
    resolveClosed();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", onStdoutData);
  child.stdout.on("error", onStdoutError);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", onStderrData);
  child.stderr.on("error", onStderrError);
  child.stdin.on("error", onStdinError);
  child.once("error", onChildError);
  child.once("exit", onChildExit);
  child.once("close", onChildClose);

  let nextId = 1;
  const request = async (method, params) => {
    if (terminalError) throw terminalError;

    const id = nextId;
    nextId += 1;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    try {
      await writeMessage({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      fail(error);
    }
    const message = await response;
    if (terminalError) throw terminalError;
    assertJsonRpcResponse(message, id, method);
    return message;
  };

  const timeout = setTimeout(() => {
    fail(
      new Error(
        `MCP stdio probe timed out after ${timeoutMs}ms: ${boundedDiagnostic(stderr)}`,
      ),
    );
  }, timeoutMs);

  const waitForClose = async () => {
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(resolve, TERMINATION_GRACE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const stopChild = async () => {
    if (childClosed) return;
    child.kill();
    await waitForClose();
    if (!childClosed) {
      child.kill("SIGKILL");
      await waitForClose();
      if (!childClosed) {
        throw new Error(
          `MCP stdio process did not close within ${TERMINATION_GRACE_MS}ms after SIGKILL.`,
        );
      }
    }
  };

  try {
    const initialize = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    if (initialize.error) {
      throw jsonRpcFailure("initialize", initialize.error);
    }
    assertInitializeResult(initialize.result);

    try {
      await writeMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
    } catch (error) {
      fail(error);
      throw terminalError;
    }

    const tools = await request("tools/list", {});
    if (tools.error) {
      throw jsonRpcFailure("tools/list", tools.error);
    }

    const runtimeInfo = await request("tools/call", {
      name: "get_runtime_info",
      arguments: {},
    });
    if (runtimeInfo.error) {
      throw jsonRpcFailure("get_runtime_info", runtimeInfo.error);
    }

    return {
      protocolVersion: initialize.result.protocolVersion,
      tools: tools.result.tools,
      runtimeInfo: runtimeInfo.result,
    };
  } finally {
    stopping = true;
    clearTimeout(timeout);
    rejectPending(
      pending,
      terminalError ?? new Error("MCP stdio probe stopped before completion."),
    );
    await stopChild();
    child.stdout.off("data", onStdoutData);
    child.stdout.off("error", onStdoutError);
    child.stderr.off("data", onStderrData);
    child.stderr.off("error", onStderrError);
    child.stdin.off("error", onStdinError);
    child.off("error", onChildError);
    child.off("exit", onChildExit);
    child.off("close", onChildClose);
  }
}
