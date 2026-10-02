import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import { MCP_SEMCONV } from "../src/opentelemetry-semconv.mjs";
import { sanitizeOtelSpanForExport } from "../src/opentelemetry.mjs";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function fakeSpan(protocolVersion) {
  return {
    attributes: {
      "mcp.method.name": "tools/list",
      [MCP_SEMCONV.protocolVersion]: protocolVersion,
    },
    events: [],
    links: [],
    parentSpanContext: undefined,
    spanContext() {
      return {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 0,
        isRemote: false,
      };
    },
    status: { code: 0 },
  };
}

test("trace export preserves only SDK-supported MCP protocol revisions", () => {
  const supportedVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
  const supported = sanitizeOtelSpanForExport(fakeSpan(supportedVersion));
  assert.equal(
    supported.attributes[MCP_SEMCONV.protocolVersion],
    supportedVersion,
  );

  const canary = "private-cardinality-value";
  const unsupported = sanitizeOtelSpanForExport(fakeSpan(canary));
  assert.equal(unsupported.attributes[MCP_SEMCONV.protocolVersion], undefined);
  assert.doesNotMatch(
    JSON.stringify(unsupported.attributes),
    new RegExp(canary),
  );
});
