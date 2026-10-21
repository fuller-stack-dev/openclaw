import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as ownership from "../../agents/harness/session-runtime-ownership.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { preparePluginToolExecutionCapabilities } from "../../agents/plugin-tool-execution.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createFallbackSessionEntry } from "../../config/sessions/session-accessor.sqlite-normalize.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRequesterModels } from "../../plugins/requester-models.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatMetadataOwner } from "./chat-metadata-runtime.test-support.js";
import {
  createModelsListTestContext,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import { projectRequesterModelCatalog } from "./requester-model-catalog.js";
import type { GatewayClient, RespondFn } from "./types.js";

const ids = ["gpt-5.6-luna", "gpt-5.6-sol"];
afterEach(() => vi.restoreAllMocks());

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prepareProfileCatalog: true,
      env: WITHOUT_OPENAI_ENV_AUTH,
      prefix: "requester-models-",
    },
    async () => {
      const f = await setup();
      using profiles = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      void profiles;
      await run(f);
    },
  );
}

async function setup() {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-5.6-luna",
        models: Object.fromEntries(ids.map((id) => ["openai/" + id, {}])),
      },
      entries: { main: {} },
    },
    gateway: {
      roles: {
        default: "luna",
        definitions: Object.fromEntries(
          ids.map((id, i) => [
            i ? "sol" : "luna",
            {
              agents: "*",
              scopes: ["operator.read"],
              sessions: { others: "none" },
              modelPolicy: { allow: ["openai/" + id] },
            },
          ]),
        ),
      },
    },
  };
  const accountCatalog = createPreparedAccountCatalogAccess(() => true, undefined, config);
  const owner = Object.assign(
    createChatMetadataOwner(
      config,
      ids[0]!,
      { openai: { type: "api_key", key: "synthetic-private-key" } },
      "openai",
      "openai-responses",
    ),
    { accountCatalog },
  );
  const refreshAccount = () =>
    accountCatalog.acquire({
      profileId: "openai:prepared",
      credential: { type: "api_key", provider: "openai", key: "synthetic-private-key" },
      allowDiscovery: true,
      refresh: true,
      load: async () => [],
    });
  await refreshAccount();
  owner.modelCatalog.entries.push({
    ...owner.modelCatalog.entries[0]!,
    id: ids[1]!,
    name: ids[1]!,
  });
  owner.modelCatalog.routeVariants!.push(owner.modelCatalog.entries[1]!);
  const context = createModelsListTestContext({
    cfg: config,
    catalog: owner.modelCatalog.entries,
    preparedAuthModes: owner.authModes,
    preparedAuthStore: {
      version: 1,
      profiles: {
        "openai:prepared": { type: "api_key", provider: "openai", key: "synthetic-private-key" },
      },
    },
    metadataSnapshot: owner.metadataSnapshot,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
  });
  const requesters = await Promise.all(
    ids.map(async (id, i) => {
      const person = ensureProfileForEmail((i ? "sol" : "luna") + "@example.test");
      setUserProfileRole(person.id, i ? "sol" : "luna");
      const sessionKey = "agent:main:" + person.id;
      const scope = { agentId: "main", sessionKey };
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const save = async (sessionId = sessionKey) => {
        const patch = {
          sessionId,
          updatedAt: 1,
          providerOverride: "openai",
          authProfileOverride: "openai:prepared",
          authProfileOverrideSource: "user" as const,
          createdActor: { type: "human" as const, source: "profile" as const, id: person.id },
        };
        await patchSessionEntryCore(scope, () => patch, {
          skipMaintenance: true,
          fallbackEntry: createFallbackSessionEntry(patch),
        });
      };
      await save();
      const policy = prepareOperatorModelPolicy({
        cfg: config,
        policy: { allow: ["openai/" + id] },
        manifestPlugins: owner.metadataSnapshot,
      });
      let current = true;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: person.id,
        scopes: ["operator.read"],
        modelPolicy: policy,
        assertCurrent() {
          if (!current) {
            throw new Error("Requester revoked");
          }
        },
      });
      const readerParams = {
        config,
        agentId: "main",
        sessionKey,
        sessionId: sessionKey,
        authority,
        preparedModelRuntime: owner,
        assertCurrent() {},
      };
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({
        id: "requester-catalog",
        source: "/plugins/requester-catalog/index.js",
        origin: "config",
        enabled: true,
        configSchema: true,
      });
      record.status = "loaded";
      registry.plugins.push(record);
      const toolContext = createPluginToolFactoryContext({
        registry,
        entry: {
          pluginId: record.id,
          source: record.source,
          names: ["catalog"],
          factory: () => null,
          contextVersion: 2,
          optional: false,
        },
        context: { sessionKey, sessionId: sessionKey, agentId: "main" },
        assertInvocationCurrent() {},
        bindExecutionCapabilities: preparePluginToolExecutionCapabilities(readerParams),
      }) as OpenClawPluginToolContext<2>;
      const models = toolContext.runtimeContext!.models!;
      const unpreparedModels = () =>
        createPluginRequesterModels({ ...readerParams, preparedModelRuntime: undefined })!;
      const client: GatewayClient = {
        connId: person.id,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
          role: "operator",
          scopes: ["operator.read"],
          caps: [GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY],
        },
        authenticatedUserProfile: {
          profileId: person.id,
          displayName: person.displayName,
          hasAvatar: false,
          updatedAt: person.updatedAt,
        },
      };
      return {
        models,
        unpreparedModels,
        save,
        revoke: () => {
          current = false;
        },
        async gateway() {
          const respond = vi.fn<RespondFn>();
          const params = { sessionKey, preparedOnly: true, includeDefaultModels: false };
          await modelsHandlers["models.list"]!({
            req: { type: "req", id: "requester-catalog", method: "models.list", params },
            params,
            context,
            client,
            respond,
            isWebchatConnect: () => false,
          });
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return respond.mock.calls[0]![1] as ModelsListResult;
        },
      };
    }),
  );
  return { requesters, owner, accountCatalog, refreshAccount };
}

it("matches the safe models.list session projection for two differently restricted requesters", async () => {
  await fixture(async ({ requesters }) => {
    const catalogs = [];
    for (const [i, requester] of requesters.entries()) {
      const result = await requester.models.list();
      expect(result).toEqual(projectRequesterModelCatalog(await requester.gateway()));
      expect(result.models.map((model) => model.id)).toEqual([ids[i]]);
      expect(result.selectionPolicy).toEqual({
        restricted: true,
        defaultModel: "openai/" + ids[i],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-private-key|apiKeySupported|authProfile|credentials|refresh|family/,
      );
      catalogs.push(result);
    }
    expect(catalogs[0]!.revision).not.toBe(catalogs[1]!.revision);
  });
});

it("returns pending with no admitted models when no prepared owner is published", async () => {
  await fixture(async ({ requesters }) => {
    vi.spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockReturnValue(
      undefined,
    );
    await expect(requesters[0]!.unpreparedModels().list()).resolves.toEqual({
      revision: expect.any(String),
      state: "pending",
      models: [],
      selectionPolicy: { restricted: true, defaultModel: null },
    });
  });
});

it.each(["reset", "revocation", "retirement", "account publication"])(
  "does not publish after %s during an awaited native-owner read",
  async (change) => {
    await fixture(async ({ requesters, owner, accountCatalog, refreshAccount }) => {
      const requester = requesters[0]!;
      const original = ownership.readSessionRuntimeOwnershipAsync;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(ownership, "readSessionRuntimeOwnershipAsync").mockImplementationOnce(
        async (params) => {
          entered();
          await gate;
          return await original(params);
        },
      );
      const isOwnerCurrent = vi.spyOn(owner, "isCurrent");
      const acquired = vi.spyOn(accountCatalog, "acquire");
      const pending = requester.models.list();
      void pending.catch(() => {});
      await awaitGateBeforeSettlement(
        started,
        pending,
        "Catalog bypassed native-owner preparation",
      );
      try {
        if (change === "reset") {
          await requester.save("replacement-session");
        }
        if (change === "revocation") {
          requester.revoke();
        }
        if (change === "retirement") {
          isOwnerCurrent.mockReturnValue(false);
        }
        if (change === "account publication") {
          expect(acquired).toHaveBeenCalledWith(
            expect.objectContaining({ profileId: "openai:prepared", allowDiscovery: false }),
          );
          await refreshAccount();
          expect(owner.isCurrent()).toBe(true);
        }
      } finally {
        release();
      }
      await expect(pending).rejects.toThrow();
    });
  },
);

it("never represents unknown, unavailable or non-selectable rows as available, and drops credential-bearing fields", () => {
  const catalog = projectRequesterModelCatalog({
    models: [
      {
        id: "ready",
        provider: "test",
        name: "Ready",
        available: true,
        apiKeySupported: true,
        thinkingLevels: [{ id: "high", label: "High" }],
        supportsFastMode: true,
      },
      { id: "unknown", provider: "test", name: "Unknown" },
      { id: "offline", provider: "test", name: "Offline", available: false },
      {
        id: "hidden",
        provider: "test",
        name: "Hidden",
        available: true,
        manualSelectionAllowed: false,
      },
    ],
    pendingProviders: ["test"],
    accountSelection: {
      kind: "personal",
      label: "Private",
      authProfileId: "private-account",
      source: "user",
    },
  });
  expect(catalog).toEqual({
    revision: expect.any(String),
    state: "pending",
    models: [
      {
        id: "ready",
        provider: "test",
        name: "Ready",
        thinkingLevels: ["high"],
        fastModes: [false, true, "auto"],
      },
    ],
  });
});
