/**
 * Maximum bytes to consume when probing the readiness endpoint for
 * a bounded JSON sanity check.  Keeps the probe safe against
 * misrouted HTML pages, WAF responses, or oversized gateway bodies.
 */
const READINESS_PROBE_MAX_BYTES = 4096;

export async function checkGitLabReadiness({ gitlabUrl }) {
  const apiUrl = new URL(`${gitlabUrl}/api/v4/user`);
  const response = await fetch(apiUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });

  if (![200, 401, 403].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }

  // Consume a bounded prefix and verify valid JSON.  This rejects HTML,
  // malformed JSON, and unexpected non-object bodies from proxies or WAFs.
  try {
    const chunks = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) {
      return false;
    }
    try {
      while (totalBytes < READINESS_PROBE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = READINESS_PROBE_MAX_BYTES - totalBytes;
        if (value.length > remaining) {
          await reader.cancel().catch(() => undefined);
          return false;
        }
        chunks.push(value);
        totalBytes += value.length;
      }
    } finally {
      // Discard remaining body to avoid back-pressure stalls
      reader.cancel().catch(() => undefined);
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = JSON.parse(new TextDecoder().decode(combined));
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
}
