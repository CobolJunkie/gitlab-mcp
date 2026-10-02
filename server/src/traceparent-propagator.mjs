import { isSpanContextValid, trace } from "@opentelemetry/api";

const TRACEPARENT_HEADER = "traceparent";
const TRACE_FLAGS_SUPPORTED = 0x03;
const TRACEPARENT_PATTERN =
  /^\s?([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?\s?$/u;

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseTraceparent(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match || match[1] === "ff" || (match[1] === "00" && match[5])) {
    return undefined;
  }
  const spanContext = {
    traceId: match[2],
    spanId: match[3],
    traceFlags: Number.parseInt(match[4], 16) & TRACE_FLAGS_SUPPORTED,
    isRemote: true,
  };
  return isSpanContextValid(spanContext) ? spanContext : undefined;
}

/**
 * W3C traceparent-only propagator for OBS-02.
 *
 * The default NodeSDK propagator also accepts/emits tracestate and baggage.
 * Those fields are intentionally excluded because they may contain arbitrary
 * vendor/user-controlled values outside the OBS-02 telemetry allowlist.
 */
export function createTraceparentOnlyPropagator() {
  return Object.freeze({
    extract(baseContext, carrier, getter) {
      try {
        const spanContext = parseTraceparent(
          firstHeaderValue(getter.get(carrier, TRACEPARENT_HEADER)),
        );
        return spanContext
          ? trace.setSpanContext(baseContext, spanContext)
          : baseContext;
      } catch {
        return baseContext;
      }
    },
    inject(activeContext, carrier, setter) {
      try {
        const spanContext = trace.getSpanContext(activeContext);
        if (!spanContext || !isSpanContextValid(spanContext)) {
          return;
        }
        const flags = (Number(spanContext.traceFlags) & TRACE_FLAGS_SUPPORTED)
          .toString(16)
          .padStart(2, "0");
        setter.set(
          carrier,
          TRACEPARENT_HEADER,
          `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
        );
      } catch {
        // Propagation is telemetry-only and must never alter product behavior.
      }
    },
    fields() {
      return [TRACEPARENT_HEADER];
    },
  });
}
