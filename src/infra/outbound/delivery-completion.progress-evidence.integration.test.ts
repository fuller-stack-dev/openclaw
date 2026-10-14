import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import { capturePendingFinalRecoverySource } from "../../agents/pending-final-recovery-source.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import type { ChannelMessageSendResult } from "../../channels/message/types.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

function receipt(): ChannelMessageSendResult {
  return {
    messageId: "m",
    receipt: {
      platformMessageIds: ["m"],
      parts: [{ platformMessageId: "m", kind: "text", index: 0 }],
      sentAt: 1,
    },
  };
}

describe("final receipt reported progress evidence", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it.each(
    (["live", "recovery"] as const).flatMap((mode) =>
      (
        [
          "omitted",
          "enriched",
          "normalized",
          "target",
          "receipt-thread",
          "part-thread",
          "nested-target",
          "nested-thread",
          "mutated-target",
          "callback-mutation",
        ] as const
      ).map((placement) => ({ mode, placement })),
    ),
  )(
    "retains reported placement across same-ID final replacement ($mode, $placement)",
    async ({ mode, placement }) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:progress-evidence",
        storePath: path.join(tmpDir, "sessions.json"),
      };
      const context = { channel: "matrix", to: "!original:example", threadId: "thread" };
      await replaceSessionEntry(scope, {
        sessionId: "session",
        updatedAt: 1,
        restartRecoveryDeliveryRunId: "run",
        restartRecoveryDeliverySourceRunId: "source",
        restartRecoveryDeliveryContext: context,
      });
      const entry = loadSessionEntry(scope);
      if (!entry) {
        throw new Error("missing fixture session");
      }
      const payloads = [{ text: "final" }];
      await persistPendingFinalDeliveryMarker({
        ...scope,
        deliver: true,
        sessionEntry: entry,
        sessionStore: { [scope.sessionKey]: entry },
        admittedRecoverySource: capturePendingFinalRecoverySource(entry),
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: context,
        runOwnedSessionId: entry.sessionId,
      });
      const completion = resolvePendingFinalDeliveryCompletion(payloads);
      if (!completion) {
        throw new Error("missing final custody");
      }
      const progress = receipt();
      if (["target", "mutated-target", "callback-mutation"].includes(placement)) {
        progress.target = { kind: "room", id: "!other:example" };
      }
      if (placement === "normalized") {
        progress.target = { kind: "room", id: "matrix:!original:example" };
      }
      if (placement === "receipt-thread") {
        progress.receipt.threadId = "wrong";
      }
      if (placement === "part-thread") {
        progress.receipt.parts[0]!.threadId = "wrong";
      }
      if (placement === "nested-target") {
        progress.receipt.raw = [{ roomId: "!other:example" }];
      }
      if (placement === "nested-thread") {
        const nested = {
          messageId: "nested",
          receipt: { ...receipt().receipt, threadId: "wrong" },
        };
        progress.receipt.parts[0]!.raw = nested;
      }
      const committed = vi.fn();
      const send = vi.fn(
        async (ctx: {
          onDeliveryResult?: (result: ChannelMessageSendResult) => Promise<void> | void;
        }) => {
          await ctx.onDeliveryResult?.(progress);
          if (placement === "mutated-target") {
            progress.target!.id = context.to;
          }
          const final = receipt();
          if (placement === "enriched") {
            final.target = { kind: "room", id: context.to };
            final.receipt.threadId = context.threadId;
          }
          return final;
        },
      );
      const plugin = createOutboundTestPlugin({
        id: "matrix",
        outbound: matrixOutboundForQueueTest,
        messaging: { normalizeTarget: (raw) => raw.replace(/^matrix:/, "") },
      });
      plugin.message = {
        send: { text: send, lifecycle: { afterCommit: committed } },
        durableFinal: { capabilities: { text: true, thread: true, afterCommit: true } },
      };
      setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
      const seen: string[] = [];
      const runDelivery: typeof deliverOutboundPayloads = (params) =>
        deliverOutboundPayloads({
          ...params,
          onDeliveryResult: async (result) => {
            seen.push(result.messageId);
            if (placement === "callback-mutation" && result.target) {
              result.target.id = context.to;
            }
            await params.onDeliveryResult?.(result);
          },
        });
      const recover = () =>
        recoverPendingDeliveries({
          cfg: {},
          stateDir: tmpDir,
          log: createRecoveryLog(),
          deliver: runDelivery,
        });
      const params = {
        cfg: {},
        ...context,
        payloads,
        deliveryCompletion: completion,
        deliveryIntentId: completion.deliveryId,
        queuePolicy: "required" as const,
      };
      if (mode === "live") {
        await runDelivery(params);
      } else {
        await enqueueDeliveryOnce(params, completion.deliveryId, tmpDir);
        await recover();
      }
      const evidence = getRestartRecoveryTerminalDeliveryEvidence(
        loadSessionEntry(scope),
        "source",
      );
      if (placement === "omitted" || placement === "normalized" || placement === "enriched") {
        expect(evidence).toMatchObject({
          deliveryStatus: { status: "sent", resultCount: 1 },
          durableFinalReceipt: { platformMessageId: "m" },
        });
      } else {
        expect(evidence).toBeUndefined();
      }
      expect(seen).toEqual(["m"]);
      expect(committed).toHaveBeenCalledOnce();
      await recover();
      expect(send).toHaveBeenCalledOnce();
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );
});
