import assert from "node:assert/strict";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForMergeRequestPrepared(
  session,
  fixture,
  { timeoutMs = 30_000, pollMs = 500 } = {},
) {
  const mergeRequestIid = fixture?.mergeRequest?.iid;
  const expectedHeadSha = fixture?.commit?.id;
  assert.ok(
    mergeRequestIid,
    "Benchmark merge-request fixture must have an IID.",
  );
  assert.ok(
    expectedHeadSha,
    "Benchmark merge-request fixture must have a head commit.",
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mergeRequest = await session.call("get_merge_request", {
      project: session.project,
      merge_request_iid: mergeRequestIid,
    });

    if (
      mergeRequest?.source_branch &&
      mergeRequest.source_branch !== fixture.source
    ) {
      throw new Error(
        "Prepared benchmark merge request changed source branch.",
      );
    }
    if (
      mergeRequest?.target_branch &&
      mergeRequest.target_branch !== fixture.base
    ) {
      throw new Error(
        "Prepared benchmark merge request changed target branch.",
      );
    }

    const prepared = Boolean(mergeRequest?.prepared_at);
    const branchIdentityReady =
      mergeRequest?.source_branch === fixture.source &&
      mergeRequest?.target_branch === fixture.base;
    const headIdentityReady =
      mergeRequest?.sha === expectedHeadSha &&
      mergeRequest?.diff_refs?.head_sha === expectedHeadSha;

    if (prepared && branchIdentityReady && headIdentityReady) {
      fixture.mergeRequest = mergeRequest;
      return mergeRequest;
    }
    if (pollMs > 0) await delay(pollMs);
  }

  throw new Error(
    `Timed out waiting for benchmark merge request !${mergeRequestIid} to finish preparation at its expected head.`,
  );
}
