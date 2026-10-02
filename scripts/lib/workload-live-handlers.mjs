import { applyGovernanceWorkloadOverrides } from "./workload-live-governance-overrides.mjs";
import { createBaseLiveWorkloadHandlers } from "./workload-live-base-handlers.mjs";
import { applyLiveWorkloadOverrides } from "./workload-live-overrides.mjs";
import { applyVerifiedReadWorkloadOverrides } from "./workload-live-read-overrides.mjs";
import { applyRepositoryWorkloadOverrides } from "./workload-live-repository-overrides.mjs";
import { applyVerificationWorkloadOverrides } from "./workload-live-verification-overrides.mjs";

export function createLiveWorkloadHandlers(session) {
  return applyVerificationWorkloadOverrides(
    session,
    applyRepositoryWorkloadOverrides(
      session,
      applyGovernanceWorkloadOverrides(
        session,
        applyVerifiedReadWorkloadOverrides(
          session,
          applyLiveWorkloadOverrides(
            session,
            createBaseLiveWorkloadHandlers(session),
          ),
        ),
      ),
    ),
  );
}
