import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeOtelSpanForExport } from "../src/opentelemetry.mjs";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function fakeHttpSpan(method) {
  return {
    attributes: { "http.request.method": method },
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

test("trace privacy projection preserves bounded HTTP method semantics", () => {
  const query = sanitizeOtelSpanForExport(fakeHttpSpan("QUERY"));
  assert.equal(query.attributes["http.request.method"], "QUERY");
  assert.equal(query.name, "HTTP QUERY");

  const unknown = sanitizeOtelSpanForExport(
    fakeHttpSpan("PRIVATE_USER_CONTROLLED_METHOD"),
  );
  assert.equal(unknown.attributes["http.request.method"], "_OTHER");
  assert.equal(unknown.name, "HTTP _OTHER");
});
