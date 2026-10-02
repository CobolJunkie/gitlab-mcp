import assert from "node:assert/strict";
import test from "node:test";

import { ROOT_CONTEXT, trace } from "@opentelemetry/api";

import { createTraceparentOnlyPropagator } from "../src/traceparent-propagator.mjs";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

const getter = Object.freeze({
  get(carrier, key) {
    return carrier[key];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
});

const setter = Object.freeze({
  set(carrier, key, value) {
    carrier[key] = value;
  },
});

test("extracts only traceparent and discards tracestate and baggage", () => {
  const canary = "CANARY_PRIVATE_TRACE_STATE";
  const propagator = createTraceparentOnlyPropagator();
  const extracted = propagator.extract(
    ROOT_CONTEXT,
    {
      traceparent: TRACEPARENT,
      tracestate: `vendor=${canary}`,
      baggage: `private=${canary}`,
    },
    getter,
  );
  const spanContext = trace.getSpanContext(extracted);

  assert.deepEqual(propagator.fields(), ["traceparent"]);
  assert.deepEqual(spanContext, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: 1,
    isRemote: true,
  });
  assert.equal(spanContext?.traceState, undefined);
  assert.doesNotMatch(JSON.stringify(spanContext), new RegExp(canary));
});

test("injects only traceparent even when the source context has tracestate", () => {
  const canary = "CANARY_PRIVATE_TRACE_STATE";
  const propagator = createTraceparentOnlyPropagator();
  const activeContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: 1,
    isRemote: false,
    traceState: {
      serialize() {
        return `vendor=${canary}`;
      },
    },
  });
  const carrier = {};

  propagator.inject(activeContext, carrier, setter);

  assert.deepEqual(carrier, { traceparent: TRACEPARENT });
  assert.doesNotMatch(JSON.stringify(carrier), new RegExp(canary));
});

test("rejects invalid traceparent values without creating a remote context", () => {
  const propagator = createTraceparentOnlyPropagator();
  for (const traceparent of [
    "00-00000000000000000000000000000000-b7ad6b7169203331-01",
    "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
    "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra",
  ]) {
    const extracted = propagator.extract(ROOT_CONTEXT, { traceparent }, getter);
    assert.equal(trace.getSpanContext(extracted), undefined);
  }
});

test("accepts future traceparent versions while ignoring extension data", () => {
  const propagator = createTraceparentOnlyPropagator();
  const extracted = propagator.extract(
    ROOT_CONTEXT,
    {
      traceparent: `01-${TRACE_ID}-${SPAN_ID}-00-future`,
    },
    getter,
  );

  assert.deepEqual(trace.getSpanContext(extracted), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: 0,
    isRemote: true,
  });
});

test("masks reserved trace flags while preserving level 2 flags", () => {
  const propagator = createTraceparentOnlyPropagator();
  const extracted = propagator.extract(
    ROOT_CONTEXT,
    {
      traceparent: `01-${TRACE_ID}-${SPAN_ID}-ff-future`,
    },
    getter,
  );
  assert.deepEqual(trace.getSpanContext(extracted), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: 3,
    isRemote: true,
  });

  const activeContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: 0xff,
    isRemote: false,
  });
  const carrier = {};
  propagator.inject(activeContext, carrier, setter);
  assert.deepEqual(carrier, {
    traceparent: `00-${TRACE_ID}-${SPAN_ID}-03`,
  });
});

test("carrier failures are fail-open", () => {
  const propagator = createTraceparentOnlyPropagator();
  const extracted = propagator.extract(
    ROOT_CONTEXT,
    {},
    {
      get() {
        throw new Error("carrier read failed");
      },
      keys() {
        return [];
      },
    },
  );
  assert.strictEqual(extracted, ROOT_CONTEXT);

  const activeContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: 1,
    isRemote: false,
  });
  assert.doesNotThrow(() =>
    propagator.inject(
      activeContext,
      {},
      {
        set() {
          throw new Error("carrier write failed");
        },
      },
    ),
  );
});
