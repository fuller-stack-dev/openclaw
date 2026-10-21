import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import {
  gateAgentToolExecution,
  finalizeAgentToolAvailability,
} from "../../agent-tool-availability.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  createSpawnOperatorSource,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerNativePluginPolicyCases(options: NativePluginSpawnTestOptions) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    throwBoundFailures,
    runEmbeddedAgent,
  } = options;
  it.each([
    { allowlist: ["read"], unavailable: "sessions_spawn", reader: "absent" },
    { allowlist: ["sessions_spawn"], unavailable: "agents_wait", reader: "absent" },
    { allowlist: ["sessions_spawn", "agents_wait"], unavailable: "agents_wait", reader: "gated" },
    {
      allowlist: ["sessions_spawn", "agents_wait"],
      unavailable: "agents_wait",
      reader: "shadowed",
    },
  ])(
    "native plugin facade refuses a denied $unavailable ($reader reader) before preparing or creating a child",
    async ({ allowlist, unavailable, reader }) => {
      const source = createSpawnOperatorSource();
      const bound = await createBoundParent(source.authority);
      const { parentSessionKey, parentRunId } = bound;
      const { context, runtime } = await createBoundGateway(bound);
      const failures: unknown[] = [];
      const agentTools = await import("../../agent-tools.js");
      const original = agentTools.createOpenClawCodingToolsInternalAsync;
      const preparation =
        reader === "absent"
          ? undefined
          : vi
              .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
              .mockImplementation(async (...args) => {
                const surface = await original(...args);
                const index = surface.findIndex((tool) => tool.name === "agents_wait");
                const wait = expectDefined(surface[index], "native agents_wait");
                // A same-named definition without the native reader binding shadows it.
                const replacement =
                  reader === "gated"
                    ? gateAgentToolExecution(wait, "denied requester")
                    : Object.assign({}, wait);
                return finalizeAgentToolAvailability(surface.with(index, replacement));
              });
      try {
        await withPluginRuntimeGatewayRequestScope(
          { context, isWebchatConnect: () => false },
          async () => {
            const { createRequestNativeSubagentRuntime } =
              await import("../../plugin-native-subagent.js");
            const prepareSpawn = vi.fn(async () => bound.admitted);
            const native = createRequestNativeSubagentRuntime(
              {
                options: {
                  config: bound.cfg,
                  agentId: "main",
                  sessionKey: parentSessionKey,
                  sessionId: "parent-session",
                  runId: parentRunId,
                  workspaceDir: resolveAgentWorkspaceDir(bound.cfg, "main"),
                  senderIsOwner: true,
                  runtimeToolAllowlist: allowlist,
                  inheritRuntimeToolAllowlist: true,
                },
                operatorAuthority: source.authority,
                assertCurrent: source.authority.assertCurrent,
                prepareSpawn,
              },
              { pluginId: "native-test", assertCurrent: source.authority.assertCurrent },
            );
            await expect(expectDefined(native.list, "denied native listing")()).rejects.toThrow(
              "agents_wait is not available",
            );
            await expect(
              native.collect({ ids: ["not-readable"], timeoutSeconds: 0 }),
            ).rejects.toThrow("agents_wait is not available");
            await expect(native.spawn({ requestId: "denied", task: "Do not run" })).rejects.toThrow(
              unavailable + " is not available",
            );
            expect(prepareSpawn).not.toHaveBeenCalled();
            expect(subagentRuns.size).toBe(0);
            expect(runEmbeddedAgent).not.toHaveBeenCalled();
          },
        );
      } catch (error) {
        failures.push(error);
      } finally {
        preparation?.mockRestore();
        source.closeRequest();
        failures.push(...(await closeBoundGateway(bound, runtime)));
        throwBoundFailures(failures);
      }
    },
  );
}
