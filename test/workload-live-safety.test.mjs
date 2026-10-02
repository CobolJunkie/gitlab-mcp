import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdmissionLimitBenchmarkHandler,
  createReadOnlyMutationBenchmarkHandler,
} from "../scripts/lib/workload-live-safety.mjs";

test("read-only mutation benchmark proves GitLab is never reached", async () => {
  let fetchCalls = 0;
  const handler = createReadOnlyMutationBenchmarkHandler({
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ message: "unexpected request" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await handler.prepare();
  try {
    await handler.setup();
    await handler.execute({ observe: () => {} });
    const verification = await handler.verifyFinalState();

    assert.equal(fetchCalls, 0);
    assert.deepEqual(verification, {
      verified: true,
      forbiddenEffectsObserved: [],
    });
  } finally {
    await handler.cleanup();
    await handler.finalize();
  }
});

test(
  "admission-limit benchmark releases responses across the full benchmark profile",
  { timeout: 10_000 },
  async () => {
    const handler = createAdmissionLimitBenchmarkHandler();

    await handler.prepare();
    try {
      for (let iteration = 0; iteration < 33; iteration += 1) {
        await handler.setup();
        try {
          await handler.execute({ observe: () => {} });
          assert.deepEqual(await handler.verifyFinalState(), {
            verified: true,
            forbiddenEffectsObserved: [],
          });
        } finally {
          await handler.cleanup();
        }
      }
    } finally {
      await handler.finalize();
    }
  },
);
