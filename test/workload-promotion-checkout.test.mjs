import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLiveBenchmarkCheckoutProvenance,
  assertPromotionCheckoutProvenance,
} from "../scripts/lib/workload-promotion-checkout.mjs";

const REPORT_SHA = "a".repeat(40);

test("baseline promotion checkout guard accepts the exact clean report commit", () => {
  assert.equal(
    assertPromotionCheckoutProvenance({
      reportCommitSha: REPORT_SHA,
      checkoutCommitSha: REPORT_SHA.toUpperCase(),
      trackedChanges: "",
    }),
    true,
  );
});

test("baseline promotion checkout guard rejects stale, dirty, or invalid source state", () => {
  assert.throws(
    () =>
      assertPromotionCheckoutProvenance({
        reportCommitSha: REPORT_SHA,
        checkoutCommitSha: "b".repeat(40),
        trackedChanges: "",
      }),
    /checkout HEAD to match the benchmark report commit exactly/,
  );
  assert.throws(
    () =>
      assertPromotionCheckoutProvenance({
        reportCommitSha: REPORT_SHA,
        checkoutCommitSha: REPORT_SHA,
        trackedChanges: " M scripts/lib/workload-live-handlers.mjs",
      }),
    /clean tracked checkout/,
  );
  assert.throws(
    () =>
      assertPromotionCheckoutProvenance({
        reportCommitSha: "g".repeat(40),
        checkoutCommitSha: REPORT_SHA,
        trackedChanges: "",
      }),
    /full 40-character Git SHA/,
  );
});

test("live benchmark checkout guard accepts only the exact clean attributed commit", () => {
  assert.equal(
    assertLiveBenchmarkCheckoutProvenance({
      benchmarkCommitSha: REPORT_SHA,
      checkoutCommitSha: REPORT_SHA.toUpperCase(),
      trackedChanges: "",
    }),
    true,
  );

  assert.throws(
    () =>
      assertLiveBenchmarkCheckoutProvenance({
        benchmarkCommitSha: REPORT_SHA,
        checkoutCommitSha: "b".repeat(40),
        trackedChanges: "",
      }),
    /checkout HEAD to match the attributed benchmark commit exactly/,
  );
  assert.throws(
    () =>
      assertLiveBenchmarkCheckoutProvenance({
        benchmarkCommitSha: REPORT_SHA,
        checkoutCommitSha: REPORT_SHA,
        trackedChanges: " M scripts/benchmark-workload-live.mjs",
      }),
    /clean tracked checkout/,
  );
});
