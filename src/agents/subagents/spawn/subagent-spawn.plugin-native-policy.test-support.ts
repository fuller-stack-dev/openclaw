import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
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
    { allowlist: ["read"], unavailable: "sessions_spawn" },
    { allowlist: ["sessions_spawn"], unavailable: "agents_wait" },
  ])(
    "native plugin facade refuses a denied $unavailable before preparing or creating a child",
    async ({ allowlist, unavailable }) => {
      const source = createSpawnOperatorSource();
      const bound = await createBoundParent(source.authority);
      const { parentSessionKey, parentRunId } = bound;
      const { context, runtime } = await createBoundGateway(bound);
      const failures: unknown[] = [];
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
        failures.push(...(await closeBoundGateway(bound, runtime)));
        throwBoundFailures(failures);
      }
    },
  );
}
