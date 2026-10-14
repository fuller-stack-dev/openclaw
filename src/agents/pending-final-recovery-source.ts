import { isDeepStrictEqual } from "node:util";
import type { SessionAdmissionTransition } from "../config/sessions/session-accessor.sqlite-entry-admission.js";
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

/** Advance only identity, through the exact committed chain; original source/route stay frozen. */
export function matchesPendingFinalRecoverySource(
  current: SessionEntry,
  admitted: PendingFinalRecoverySource,
  transitions: readonly SessionAdmissionTransition[] = [],
): boolean {
  let { sessionId, lifecycleRevision } = admitted;
  for (const transition of transitions) {
    if (
      !transition.previous ||
      transition.previous.sessionId !== sessionId ||
      transition.previous.lifecycleRevision !== lifecycleRevision
    ) {
      return false;
    }
    ({ sessionId, lifecycleRevision } = transition.current);
  }
  return isDeepStrictEqual(capturePendingFinalRecoverySource(current), {
    ...admitted,
    sessionId,
    lifecycleRevision,
  });
}
