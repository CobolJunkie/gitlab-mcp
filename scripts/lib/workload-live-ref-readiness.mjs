function responseStatus(error) {
  return error?.result?.status ?? error?.status;
}

function retryableRefLookup(error) {
  const status = responseStatus(error);
  return status === 400 || status === 404;
}

export async function waitForComparedBranchTip(
  session,
  base,
  source,
  expectedCommitId,
  { pollAttempts = 60, pollMs = 500 } = {},
) {
  if (typeof expectedCommitId !== "string" || !expectedCommitId) {
    throw new Error("Expected benchmark branch tip is required.");
  }

  let observedCommitId;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    try {
      const comparison = await session.call("compare_refs", {
        project: session.project,
        from: expectedCommitId,
        to: source,
        straight: true,
      });
      observedCommitId = comparison?.commit?.id;
      if (
        comparison?.compare_timeout !== true &&
        (comparison?.compare_same_ref === true ||
          observedCommitId === expectedCommitId)
      ) {
        return comparison;
      }
    } catch (error) {
      if (!retryableRefLookup(error)) throw error;
    }

    if (attempt + 1 < pollAttempts) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  throw new Error(
    `Benchmark refs ${base}..${source} did not resolve expected source tip before timeout; last observed tip ${observedCommitId ?? "missing"}.`,
  );
}
