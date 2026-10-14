import type { SessionEntry } from "../config/sessions/types.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";

/** Snapshot owned by admission, never the post-run cache. */
export type PendingFinalRecoverySource = Readonly<
  Pick<
    SessionEntry,
    | "sessionId"
    | "lifecycleRevision"
    | "restartRecoveryDeliveryRunId"
    | "restartRecoveryDeliverySourceRunId"
    | "restartRecoveryDeliveryContext"
    | "restartRecoveryHarnessCompletion"
  >
>;

export function capturePendingFinalRecoverySource(
  entry: SessionEntry | undefined,
): PendingFinalRecoverySource | undefined {
  if (!entry) {
    return undefined;
  }
  return freezeJsonSnapshot(
    structuredClone({
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryDeliveryContext: entry.restartRecoveryDeliveryContext,
      restartRecoveryHarnessCompletion: entry.restartRecoveryHarnessCompletion,
    }),
  );
}
