import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestNativeSubagentRuntime } from "../../agents/plugin-native-subagent.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createRestartSafeChatRequest,
  resolveRestartSafeChatAdmission,
} from "../../gateway/server-methods/chat-restart-recovery.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import {
  createPluginCommandRuntime,
  matchPluginCommandInvocation,
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandDispatchContext,
} from "../../plugins/plugin-command-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { NativeSubagentCommandFactory } from "../../plugins/runtime/native-subagent-context.js";
import type { NativeSubagentRuntime } from "../../plugins/runtime/types-native-subagent.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { buildPluginCommandContext } from "./commands-context.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { runWithCommandNativeSubagents } from "./dispatch-native-subagent.js";
import { finalizeInboundContext } from "./inbound-context.js";

const pluginId = "command-controller";
const spawnRequest = { requestId: "review", task: "Review the synthetic change" };
type Handler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
type CommandMetadata = {
  name: string;
  requireAuth?: boolean;
  runtimeCapabilities?: unknown;
  channels?: string[];
};
const declaredCommand: CommandMetadata = {
  name: "review-panel",
  requireAuth: true,
  runtimeCapabilities: ["subagents"],
};

type Fixture = {
  cfg: OpenClawConfig;
  registry: PluginRegistry;
  params: (body?: string) => HandleCommandsParams;
  handler: ReturnType<typeof vi.fn<Handler>>;
  createSubagents: NativeSubagentCommandFactory;
  bindings: string[];
  prepareSpawn: ReturnType<typeof vi.fn>;
  revokeOwner: () => void;
};

// The fixture is a third-party plugin loaded from disk, not an injected registry record.
// Only its application handler crosses this bridge; registration, selection, authority,
// native tool policy, and command lifetime all use their production owners.
async function withCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  options: { commands?: CommandMetadata[]; manifestCapabilities?: unknown } = {},
) {
  await withAdminIngress(async ({ cfg, state, admins, context, gateway }) => {
    const bridge = Symbol.for(`openclaw.command-native-test.${randomUUID()}`);
    const handler = vi.fn<Handler>((ctx) => ({
      text: JSON.stringify({
        subagents: ctx.runtimeContext?.subagents !== undefined,
        args: ctx.args,
      }),
    }));
    Reflect.set(globalThis, bridge, handler);
    const pluginDir = state.path("controller-plugin");
    await fs.mkdir(pluginDir);
    const pluginFile = path.join(pluginDir, "index.cjs");
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: {
          commandRuntimeCapabilities:
            options.manifestCapabilities === undefined
              ? ["subagents"]
              : options.manifestCapabilities,
        },
      }),
    );
    const commands = options.commands ?? [declaredCommand, { name: "ordinary" }];
    await fs.writeFile(
      pluginFile,
      `module.exports = { id: ` +
        JSON.stringify(pluginId) +
        `, register(api) {
        for (const command of ` +
        JSON.stringify(commands) +
        `) {
          api.registerCommand({ ...command, description: "Synthetic review command", acceptsArgs: true,
            handler(ctx) { return globalThis[Symbol.for(` +
        JSON.stringify(Symbol.keyFor(bridge)) +
        `)](ctx); }
          });
        }
      } };`,
    );
    cfg.agents = { defaults: { workspace: state.workspaceDir } };
    cfg.commands = { ...cfg.commands, text: true };
    cfg.plugins = {
      allow: [pluginId],
      load: { paths: [pluginFile] },
      entries: { [pluginId]: { enabled: true } },
    };
    const inbound = await context(admins[0]!.identity.senderId);
    const operatorAuthority = expectDefined(
      getCommandOwnerAuthority(inbound)?.operatorAuthority,
      "real ingress operator authority",
    );
    const params = (body = "/review-panel") => {
      const value = buildCommandTestParams(body, cfg, inbound, {
        workspaceDir: state.workspaceDir,
      });
      value.sessionEntry = {
        sessionId: "command-parent",
        lifecycleRevision: "revision-1",
        updatedAt: 1,
      };
      return value;
    };
    const bindings: string[] = [];
    // A denied native tool must never reach turn commitment or any child launch.
    const prepareSpawn = vi.fn(async () => {
      throw new Error("A denied command must not prepare a child admission");
    });
    const createSubagents: NativeSubagentCommandFactory = async (guard) => {
      bindings.push(guard.pluginId);
      return createRequestNativeSubagentRuntime(
        {
          options: {
            config: cfg,
            agentId: "main",
            sessionKey: params().sessionKey,
            sessionId: "command-parent",
            runId: "command-turn",
            workspaceDir: state.workspaceDir,
            senderIsOwner: true,
            runtimeToolAllowlist: ["read"],
            inheritRuntimeToolAllowlist: true,
            abortSignal: guard.signal,
          },
          lifecycleRevision: "revision-1",
          operatorAuthority,
          assertCurrent: operatorAuthority.assertCurrent,
          prepareSpawn,
        },
        guard,
      );
    };
    let registry: PluginRegistry | undefined;
    try {
      registry = loadOpenClawPlugins({
        config: cfg,
        workspaceDir: state.workspaceDir,
        cache: false,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      setActivePluginRegistry(registry);
      if (options.commands === undefined) {
        expect(
          registry.diagnostics.filter((diagnostic) => diagnostic.pluginId === pluginId),
          "the valid declaring plugin must load without registration refusals",
        ).toEqual([]);
      }
      await withPluginRuntimeGatewayRequestScope(
        {
          context: gateway,
          resolveGatewayContext: () => gateway,
          pluginRegistry: registry,
          isWebchatConnect: () => false,
        },
        () =>
          run({
            cfg,
            registry: expectDefined(registry, "loaded registry"),
            params,
            handler,
            createSubagents,
            bindings,
            prepareSpawn,
            revokeOwner: () => setUserProfileRole(admins[0]!.profile.id, "member"),
          }),
      );
    } finally {
      Reflect.deleteProperty(globalThis, bridge);
      resetGlobalHookRunner();
      resetPluginRuntimeStateForTest();
      if (registry) {
        await expect(disposePluginRegistryInstances(registry)).resolves.toMatchObject({
          failures: [],
        });
      }
      await expect(waitForPluginCacheRetirement()).resolves.toMatchObject({ failures: [] });
    }
  });
}

function select(body: string) {
  return matchPluginCommandInvocation(createPluginCommandRuntime(), body, { channel: "discord" });
}

async function execute(
  fixture: Fixture,
  body = "/review-panel",
  factory: NativeSubagentCommandFactory | undefined = fixture.createSubagents,
  overrides: Partial<PluginCommandDispatchContext> = {},
) {
  const params = fixture.params(body);
  const selection = expectDefined(select(body), "selected registered command");
  return selection.dispatch.execute({
    ...buildPluginCommandContext(params),
    commandBody: body,
    sessionId: params.sessionEntry?.sessionId,
    runtimeContext: factory ? { createSubagents: factory } : undefined,
    ...overrides,
  });
}

function commandDispatchState(
  params: HandleCommandsParams,
): Parameters<typeof runWithCommandNativeSubagents>[0] {
  const entry = expectDefined(params.sessionEntry, "command session");
  return {
    cfg: params.cfg,
    ctx: finalizeInboundContext(params.ctx),
    sessionAgentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionStoreEntry: { sessionKey: params.sessionKey, entry },
    params: {
      replyOptions: {
        runId: "command-turn",
        operatorAuthority: getCommandOwnerAuthority(params.ctx)?.operatorAuthority,
        toolsAllow: ["read"],
        userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
          input: { text: params.command.commandBodyNormalized },
          target: {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: entry.sessionId,
            sessionEntry: entry,
            config: params.cfg,
          },
        }),
      },
    },
    turnAdoption: undefined,
    getPreDispatchAbortSignal: () => undefined,
    getDispatchAbortSignal: () => params.opts?.abortSignal,
    assertProgressCurrent: () => {},
    assertCurrentBindingRoute: async () => {},
  };
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("command-scoped native subagent boundary", () => {
  it.each([
    {
      name: "missing manifest grant",
      manifestCapabilities: [],
      command: declaredCommand,
      reason: "commandRuntimeCapabilities",
    },
    {
      name: "public command",
      command: { ...declaredCommand, requireAuth: false },
      reason: "requireAuth",
    },
    {
      name: "implicit authorization default",
      command: { ...declaredCommand, requireAuth: undefined },
      reason: "requireAuth",
    },
    {
      name: "unknown runtime capability",
      command: { ...declaredCommand, runtimeCapabilities: ["models"] },
      reason: "runtimeCapabilities",
    },
    {
      name: "malformed runtime capability",
      command: { ...declaredCommand, runtimeCapabilities: "subagents" },
      reason: "runtimeCapabilities",
    },
  ])(
    "refuses $name at the real loader registration boundary",
    async ({ command, manifestCapabilities, reason }) => {
      await withCommandPlugin(
        async (fixture) => {
          expect(select("/review-panel")).toBeNull();
          expect(
            fixture.registry.diagnostics.some((diagnostic) => diagnostic.message.includes(reason)),
          ).toBe(true);
          expect(await handlePluginCommand(fixture.params(), true)).toBeNull();
          expect(fixture.handler).not.toHaveBeenCalled();
          expect(fixture.bindings).toEqual([]);
        },
        { commands: [command], manifestCapabilities },
      );
    },
  );

  it("exposes a host-bound runtime only to the selected declaring command", async () => {
    await withCommandPlugin(async (fixture) => {
      expect(fixture.registry.plugins.find((plugin) => plugin.id === pluginId)?.status).toBe(
        "loaded",
      );
      expect(await execute(fixture)).toEqual({ text: JSON.stringify({ subagents: true }) });
      expect(fixture.bindings).toEqual([pluginId]);
      expect(await execute(fixture, "/ordinary /review-panel")).toEqual({
        text: JSON.stringify({ subagents: false, args: "/review-panel" }),
      });
      // Older/unsupported command surfaces do not inherit the ambient hook facade.
      expect(
        await execute(fixture, "/review-panel", undefined, { runtimeContext: undefined }),
      ).toEqual({
        text: JSON.stringify({ subagents: false }),
      });
      expect(fixture.bindings).toEqual([pluginId]);
    });
  });

  it.each([
    "> /review-panel",
    "Please run /review-panel",
    "`/review-panel`",
    "/foreign /review-panel",
  ])("does not turn quoted or foreign text into a native command: %s", async (body) => {
    await withCommandPlugin(async (fixture) => {
      expect(select(body)).toBeNull();
      expect(await handlePluginCommand(fixture.params(body), true)).toBeNull();
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.bindings).toEqual([]);
    });
  });

  it("does not rematch a non-plugin catalog decision from command-looking text", async () => {
    await withCommandPlugin(async (fixture) => {
      const params = fixture.params();
      params.opts = { [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" } };
      expect(await handlePluginCommand(params, true)).toBeNull();
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.bindings).toEqual([]);
    });
  });

  it("does not bind native authority for an unauthorized sender", async () => {
    await withCommandPlugin(async (fixture) => {
      expect(
        await execute(fixture, "/review-panel", fixture.createSubagents, {
          isAuthorizedSender: false,
        }),
      ).toEqual({
        text: "⚠️ This command requires authorization.",
      });
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.bindings).toEqual([]);
    });
  });

  it("offers the real dispatch factory only for external input and withholds policy-denied capabilities", async () => {
    await withCommandPlugin(async (fixture) => {
      const offeredFactories: boolean[] = [];
      for (const kind of ["external_user", "internal_system", "inter_session"] as const) {
        const params = fixture.params();
        params.ctx.InputProvenance = { kind, sourceTool: "task_suggestion" };
        const state = commandDispatchState(params);
        params.opts = {
          withCommandNativeSubagents: (binding, run) =>
            runWithCommandNativeSubagents(state, binding, (create) => {
              offeredFactories.push(create !== undefined);
              return run(create);
            }),
        };
        expect(await handlePluginCommand(params, true)).toEqual({
          shouldContinue: false,
          reply: { text: JSON.stringify({ subagents: false }) },
        });
      }
      expect(offeredFactories).toEqual([true, false, false]);
      expect(fixture.handler).toHaveBeenCalledTimes(3);
      expect(fixture.prepareSpawn).not.toHaveBeenCalled();
    });
  });

  it("returns a real native tool-policy denial without agent continuation or child admission", async () => {
    await withCommandPlugin(async (fixture) => {
      fixture.handler.mockImplementation(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.subagents, "command native capability");
        try {
          await native.spawn(spawnRequest);
          return { text: "unexpected child" };
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error) };
        }
      });
      const params = fixture.params();
      params.opts = {
        withCommandNativeSubagents: async (_binding, run) => run(fixture.createSubagents),
      };
      expect(await handlePluginCommand(params, true)).toEqual({
        shouldContinue: false,
        reply: { text: "sessions_spawn is not available to the current requester." },
      });
      expect(fixture.prepareSpawn).not.toHaveBeenCalled();
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    });
  });

  it("closes retained spawn and collect references when the command settles", async () => {
    await withCommandPlugin(async (fixture) => {
      let native: NativeSubagentRuntime | undefined;
      fixture.handler.mockImplementation((ctx) => {
        native = ctx.runtimeContext?.subagents;
        return { text: "saved" };
      });
      expect(await execute(fixture)).toEqual({ text: "saved" });
      const retained = expectDefined(native, "retained native capability");
      await expect(retained.spawn(spawnRequest)).rejects.toSatisfy((error: unknown) =>
        String(error).includes("command invocation closed"),
      );
      await expect(retained.collect({ ids: ["child"], timeoutSeconds: 0 })).rejects.toSatisfy(
        (error: unknown) => String(error).includes("command invocation closed"),
      );
      expect(fixture.prepareSpawn).not.toHaveBeenCalled();
    });
  });

  it.each(["owner", "registry"] as const)(
    "revokes %s authority while a command awaits",
    async (change) => {
      await withCommandPlugin(async (fixture) => {
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        let native: NativeSubagentRuntime | undefined;
        fixture.handler.mockImplementation(async (ctx) => {
          native = ctx.runtimeContext?.subagents;
          entered.resolve();
          await resume.promise;
          try {
            await expectDefined(native, "native capability").spawn(spawnRequest);
            return { text: "unexpected child" };
          } catch (error) {
            return { text: String(error) };
          }
        });
        const pending = execute(fixture);
        try {
          expect(
            await Promise.race([
              entered.promise.then(() => "entered"),
              pending.then(() => "finished"),
            ]),
          ).toBe("entered");
          if (change === "owner") {
            fixture.revokeOwner();
          } else {
            setActivePluginRegistry(createEmptyPluginRegistry());
          }
          resume.resolve();
          const result = await pending;
          expect(result.text).toMatch(
            change === "owner"
              ? /authority.*changed|authority.*revoked/i
              : /registry.*no longer active/i,
          );
          expect(result.continueAgent).not.toBe(true);
          expect(fixture.prepareSpawn).not.toHaveBeenCalled();
        } finally {
          resume.resolve();
          await pending;
        }
      });
    },
  );

  it.each(["owner", "registry"] as const)(
    "rejects %s changes during native runtime preparation before entering the handler",
    async (change) => {
      await withCommandPlugin(async (fixture) => {
        const prepared = createDeferredCore();
        const release = createDeferredCore();
        const factory: NativeSubagentCommandFactory = async (guard) => {
          const native = await fixture.createSubagents(guard);
          prepared.resolve();
          await release.promise;
          return native;
        };
        const pending = execute(fixture, "/review-panel", factory);
        try {
          expect(
            await Promise.race([
              prepared.promise.then(() => "prepared"),
              pending.then(() => "finished"),
            ]),
          ).toBe("prepared");
          if (change === "owner") {
            fixture.revokeOwner();
          } else {
            setActivePluginRegistry(createEmptyPluginRegistry());
          }
          release.resolve();
          const result = await pending;
          expect(result.continueAgent).not.toBe(true);
          expect(result.text).toBe("⚠️ Command failed. Please try again later.");
          expect(fixture.handler).not.toHaveBeenCalled();
          expect(fixture.prepareSpawn).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await pending;
        }
      });
    },
  );

  it("rejects a selected command after its registry is replaced", async () => {
    await withCommandPlugin(async (fixture) => {
      const selection = expectDefined(select("/review-panel"), "original selection");
      const replacement = createEmptyPluginRegistry();
      setActivePluginRegistry(replacement);
      const result = await selection.dispatch.execute({
        ...buildPluginCommandContext(fixture.params()),
        commandBody: "/review-panel",
        runtimeContext: { createSubagents: fixture.createSubagents },
      });
      expect(result.text).toContain("registry changed");
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.bindings).toEqual([]);
    });
  });

  it("keeps restart-safe normal and literal Goal requests admissible with the declaring plugin loaded", async () => {
    await withCommandPlugin(async (fixture) => {
      initializeGlobalHookRunner(fixture.registry);
      const params = fixture.params();
      const entry = expectDefined(params.sessionEntry, "direct parent session");
      for (const goalRequestFingerprint of [
        undefined,
        "goal-start-receipt",
        "goal-resume-receipt",
      ]) {
        const request = await createRestartSafeChatRequest({
          eligible: true,
          senderIsOwner: true,
          message: goalRequestFingerprint
            ? "/review-panel is literal Goal objective text"
            : "Continue the review",
          cfg: fixture.cfg,
          goalRequestFingerprint,
        });
        expect(request).toBeDefined();
        expect(
          resolveRestartSafeChatAdmission({
            cfg: fixture.cfg,
            agentId: "main",
            sessionKey: params.sessionKey,
            sessionId: entry.sessionId,
            storePath: path.join(params.workspaceDir, "restart-sessions.json"),
            clientRunId: "restart-safe-request",
            context: {},
            entry,
            initialSessionEntry: entry,
            acpMeta: null,
            now: Date.now(),
            placement: undefined,
            request,
          }),
        ).toMatchObject({ requestFingerprint: request?.fingerprint });
      }
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.bindings).toEqual([]);
    });
  });
});
