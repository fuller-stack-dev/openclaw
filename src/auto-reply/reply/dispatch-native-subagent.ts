import { readChannelContextAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { getGatewayLocalUserIngress } from "../../gateway/local-user-ingress.js";
import { withNativeSubagentRequest } from "../../plugins/runtime/native-subagent-context.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { withRequesterNativeSubagents } from "./request-native-subagent.js";

type NativeSubagentDispatchState = Pick<
  PrepareDispatchOperationReadyState,
  | "cfg"
  | "ctx"
  | "sessionAgentId"
  | "sessionKey"
  | "getPreDispatchAbortSignal"
  | "assertProgressCurrent"
  | "assertCurrentBindingRoute"
  | "turnAdoption"
> & {
  params: Pick<PrepareDispatchOperationReadyState["params"], "replyOptions">;
  sessionStoreEntry: Pick<
    PrepareDispatchOperationReadyState["sessionStoreEntry"],
    "sessionKey" | "entry"
  >;
};

function requesterState(state: NativeSubagentDispatchState) {
  return {
    cfg: state.cfg,
    ctx: state.ctx,
    sessionAgentId: state.sessionAgentId,
    sessionKey: state.sessionStoreEntry.sessionKey ?? state.sessionKey,
    entry: state.sessionStoreEntry.entry,
    replyOptions: state.params.replyOptions,
    getAbortSignal: state.getPreDispatchAbortSignal,
    assertCurrent: () => {
      state.assertProgressCurrent();
      state.turnAdoption?.assertCurrent();
    },
    assertCurrentBindingRoute: state.assertCurrentBindingRoute,
    adoptTurn: async () => {
      await state.turnAdoption?.adopt();
    },
    ingress: {
      ingressKind: "channel" as const,
      boundary: "auto-reply.reply-dispatch",
      evidence: readChannelContextAdmissionEvidence(state.ctx),
      gatewayLocalUserIngress: getGatewayLocalUserIngress(state.ctx),
    },
  };
}

/** Legacy hook and command invocations share the same requester/admission producer. */
export async function runWithReplyNativeSubagents<T>(
  state: NativeSubagentDispatchState,
  run: () => Promise<T>,
): Promise<T> {
  return await withRequesterNativeSubagents(requesterState(state), (create) =>
    withNativeSubagentRequest(async (guard) => {
      const runtime = await create(guard);
      if (!runtime) {
        throw new Error("Native subagents are unavailable for this requester.");
      }
      return runtime;
    }, run),
  );
}

export const runWithCommandNativeSubagents = async <T>(
  state: NativeSubagentDispatchState & { getDispatchAbortSignal: () => AbortSignal | undefined },
  binding: {
    agentId: string;
    sessionKey: string;
    entry: import("../../config/sessions/types.js").SessionEntry;
  },
  run: (
    create:
      | import("../../plugins/runtime/native-subagent-context.js").NativeSubagentCommandFactory
      | undefined,
  ) => Promise<T>,
): Promise<T> => {
  // Internal/suggested text is not a fresh external command, even if it resembles one.
  const provenance = state.ctx.InputProvenance;
  if (
    (provenance && provenance.kind !== "external_user") ||
    !state.params.replyOptions?.operatorAuthority ||
    !state.params.replyOptions?.runId ||
    !state.params.replyOptions?.userTurnTranscriptRecorder ||
    binding.agentId !== state.sessionAgentId ||
    binding.sessionKey !== state.sessionKey
  ) {
    return await run(undefined);
  }
  const requester = requesterState(state);
  return await withRequesterNativeSubagents(
    {
      ...requester,
      sessionAgentId: binding.agentId,
      sessionKey: binding.sessionKey,
      entry: binding.entry,
      getAbortSignal: state.getDispatchAbortSignal,
      ingress: { ...requester.ingress, boundary: "auto-reply.plugin-command" },
      commitBeforeUse: true,
    },
    run,
  );
};
