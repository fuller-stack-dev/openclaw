import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { log } from "../logger.js";

/** The hidden follow-up that asks a run to reconcile its unfinished saved plan. */
export function createPlanCompletionCheckMessage() {
  return {
    customType: "openclaw.plan-completion-check",
    display: false,
    content: `This run’s latest successfully saved plan still has unfinished steps. Before ending, check whether those steps remain required and authorized under the latest user instructions. Continue feasible work from the current transcript; do not repeat completed actions, and reconcile uncertain effects before retrying. If work is complete, reconcile the plan. If user input, approval, an external dependency, or an explicit pause prevents further work, report that concrete limitation; if your previous reply already reported it, end with only ${SILENT_REPLY_TOKEN}. Do not invent completion or new authority.`,
  };
}

/**
 * Whether a pending plan check should wait for children this run spawned. A turn
 * that ends while its own children still run has handed the remaining steps to
 * them; reopening it would only repeat the wait. A registry failure keeps the check.
 */
export async function deferPlanCheckToRunningChildren(
  completionCheck: { unfinishedPlan: boolean; checked: boolean } | undefined,
  runId: string,
): Promise<boolean> {
  if (!completionCheck?.unfinishedPlan || completionCheck.checked) {
    return false;
  }
  try {
    // Load the registry only for a turn that would otherwise reopen an unfinished plan.
    const { hasRunningRequesterTurnChild } =
      await import("../../subagents/registry/subagent-registry.js");
    return await hasRunningRequesterTurnChild(runId);
  } catch (error) {
    log.warn(`plan-completion child check failed; keeping the check: ${String(error)}`);
    return false;
  }
}
