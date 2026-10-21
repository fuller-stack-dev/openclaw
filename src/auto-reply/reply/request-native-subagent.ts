import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveStoredSessionPermissionPolicy } from "../../agents/tool-fs-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { NativeSubagentCommandFactory } from "../../plugins/runtime/native-subagent-context.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority-inbound.js";

export type NativeSubagentRequesterState = {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
  sessionAgentId: string;
  sessionKey: string | undefined;
  entry: SessionEntry | undefined;
  replyOptions?: InternalGetReplyOptions;
  getAbortSignal: () => AbortSignal | undefined;
  assertCurrent: () => void;
  assertCurrentBindingRoute: () => Promise<void>;
  adoptTurn: () => Promise<void>;
  ingress: Pick<
    Parameters<typeof prepareChannelRunAdmission>[0],
    "ingressKind" | "boundary" | "evidence" | "gatewayLocalUserIngress"
  >;
  commitBeforeUse?: boolean;
};

/** Ingress owners bind the current requester, recorder and authority; never plugin arguments.
 * Live and future scheduled command ingress share this producer and must reauthorize each run.
 */
export async function withRequesterNativeSubagents<T>(
  state: NativeSubagentRequesterState,
  run: (create: NativeSubagentCommandFactory) => Promise<T>,
): Promise<T> {
  let admission: PreparedAgentRunAdmission | undefined;
  const invocation = new AbortController();
  try {
    const create: NativeSubagentCommandFactory = async (guard) => {
      const { cfg, ctx, replyOptions, sessionAgentId, sessionKey, entry } = state;
      const runId = replyOptions?.runId;
      const operatorAuthority = replyOptions?.operatorAuthority;
      const signals = [
        state.getAbortSignal(),
        replyOptions?.abortSignal,
        guard.signal,
        invocation.signal,
      ].filter((value): value is AbortSignal => value !== undefined);
      const signal = AbortSignal.any(signals);
      if (!sessionKey || !entry?.sessionId || !runId || !operatorAuthority) {
        throw new Error(
          "Native subagents require an admitted requester session, turn, and operator authority.",
        );
      }
      const assertCurrent = () => {
        guard.assertCurrent();
        signal?.throwIfAborted();
        operatorAuthority.assertCurrent();
        state.assertCurrent();
      };
      assertCurrent();
      const owner = await resolveCommandAuthorizationAsync({
        ctx,
        cfg,
        commandAuthorized: ctx.CommandAuthorized,
      });
      assertCurrent();
      if (state.commitBeforeUse && !owner.isAuthorizedSender) {
        return undefined;
      }
      const workspaceDir =
        entry.spawnedWorkspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
      const overlay = resolveInboundReplyToolAuthorityOverlay({
        ctx,
        sessionEntry: entry,
        senderIsOwner: owner.senderIsOwner,
        operatorAuthority,
        toolsAllow: replyOptions?.toolsAllow,
        disableTools: replyOptions?.disableTools === true,
      });
      const model = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const options = {
        ...overlay,
        config: cfg,
        agentId: sessionAgentId,
        sessionKey,
        sessionId: entry.sessionId,
        runId,
        workspaceDir,
        cwd: entry.spawnedCwd ?? workspaceDir,
        sessionPermissionPolicy: resolveStoredSessionPermissionPolicy(entry, workspaceDir),
        runtimeToolAllowlist: overlay.disableTools ? [] : overlay.toolsAllow,
        inheritRuntimeToolAllowlist: true,
        modelProvider: model.provider,
        modelId: model.model,
        requesterModel: model,
        abortSignal: signal,
        allowGatewaySubagentBinding: true,
        messageChannel: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
        messageTo: ctx.OriginatingTo ?? ctx.To,
      };
      const { prepareConversationCapabilityProfile } =
        await import("../../agents/conversation-capability-profile.js");
      const { createRequestNativeSubagentRuntime } =
        await import("../../agents/plugin-native-subagent.js");
      assertCurrent();
      const sandbox = resolvePreparedSandboxRuntimeStatus({
        cfg,
        agentId: sessionAgentId,
        sessionKey,
        preparedSessionEntry: entry,
      });
      const conversationCapabilityProfile = await prepareConversationCapabilityProfile({
        ...options,
        sandboxToolPolicy: sandbox.sandboxed ? sandbox.toolPolicy : undefined,
        preparedSessionEntry: { sessionKey, entry },
      });
      assertCurrent();
      const runtime = createRequestNativeSubagentRuntime(
        {
          options: { ...options, conversationCapabilityProfile },
          lifecycleRevision: entry.lifecycleRevision,
          operatorAuthority,
          assertCurrent: () => {
            assertCurrent();
            owner.assertOwnerCurrent?.();
          },
          async prepareSpawn(assertSpawnCurrent) {
            await state.assertCurrentBindingRoute();
            assertSpawnCurrent();
            await state.adoptTurn();
            assertSpawnCurrent();
            const recorder = replyOptions?.userTurnTranscriptRecorder;
            if (!recorder || !(await recorder.resolveMessage())) {
              throw new Error(
                "Native subagent spawn requires the current user-turn transcript recorder.",
              );
            }
            assertSpawnCurrent();
            await recorder.persistApproved({
              expectedSessionId: entry.sessionId,
              beforeFreshMessageCommit: assertSpawnCurrent,
            });
            assertSpawnCurrent();
            const receipt = recorder.getAdmissionReceipt();
            if (
              !receipt ||
              receipt.sessionId !== entry.sessionId ||
              receipt.sessionKey !== sessionKey ||
              receipt.agentId !== sessionAgentId
            ) {
              throw new Error("Native subagent spawn requires committed user-turn input.");
            }
            if (!admission) {
              const scope = getPluginRuntimeGatewayRequestScope();
              const resolveGatewayContext =
                scope?.resolveGatewayContext ?? scope?.context?.resolveGatewayContext;
              if (!resolveGatewayContext) {
                throw new Error("Native subagent controller requires its Gateway binding.");
              }
              admission = prepareChannelRunAdmission({
                cfg,
                runId,
                agentId: sessionAgentId,
                ...state.ingress,
                operatorAuthority,
                // Accepted children retain the operator source, not this invocation.
                assertSourceCurrent: () => {
                  operatorAuthority.assertCurrent();
                  owner.assertOwnerCurrent?.();
                },
                onAdmitted: (context) => bindGatewayContextResolver(context, resolveGatewayContext),
              });
            }
            return await admission.admit("plugin-harness", guard.pluginId);
          },
        },
        guard,
      );
      if (state.commitBeforeUse && !(await runtime.prepareCommand())) {
        return undefined;
      }
      assertCurrent();
      return {
        spawn: (params) => runtime.spawn(params),
        collect: (params) => runtime.collect(params),
      };
    };
    return await run(create);
  } finally {
    invocation.abort("native subagent invocation closed");
    admission?.close();
  }
}
