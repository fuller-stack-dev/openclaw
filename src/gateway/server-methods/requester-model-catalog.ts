import { createHash } from "node:crypto";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { readSessionRuntimeOwnershipAsync } from "../../agents/harness/session-runtime-ownership.js";
import { resolvePublishedModelCatalogOwner } from "../../agents/prepared-model-catalog-owner.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot,
  materializePreparedModelCatalogOwner,
} from "../../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRequesterModelCatalog } from "../../plugins/model-catalog.types.js";
import { prepareOperatorModelPolicyPresentation } from "../operator-model-presentation.js";
import { readWorkerPlacementIdentity } from "../worker-environments/placement-projector.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { prepareChatMetadataSessionRead } from "./chat-metadata-session-read.js";
import { prepareModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

/** Allowlist, not a spread: credential locators and future Gateway fields cannot leak. */
export function projectRequesterModelCatalog(
  result: ModelsListResult,
  pending = false,
): PluginRequesterModelCatalog {
  const projection: Omit<PluginRequesterModelCatalog, "revision"> = {
    state: pending || result.pendingProviders?.length ? "pending" : "prepared",
    // Unknown/pending and explicitly non-selectable rows are never availability evidence.
    models: result.models
      .filter((model) => model.available === true && model.manualSelectionAllowed !== false)
      .map((model) => {
        const choice: PluginRequesterModelCatalog["models"][number] = {
          id: model.id,
          provider: model.provider,
          name: model.name,
        };
        if (model.thinkingLevels) {
          choice.thinkingLevels = model.thinkingLevels.map((level) => level.id);
        }
        if (model.supportsFastMode !== undefined) {
          choice.fastModes = model.supportsFastMode ? [false, true, "auto"] : [false];
        }
        return choice;
      }),
    ...(result.modelSelectionPolicy
      ? {
          selectionPolicy: {
            restricted: true,
            defaultModel: result.modelSelectionPolicy.defaultModel,
          },
        }
      : {}),
  };
  return {
    revision: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    ...projection,
  };
}

/** Same saved-session, prepared inventory and role projection as models.list; no Gateway client. */
export async function readRequesterModelCatalog(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  authority: AdmittedRunOperatorAuthority;
  assertCurrent: () => void;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  context?: GatewayRequestContext;
}): Promise<PluginRequesterModelCatalog> {
  const { config, authority } = params;
  const policy = authority.modelPolicy;
  const assertCurrent = () => {
    params.assertCurrent();
    if (authority.modelPolicy !== policy) {
      throw new PreparedModelRuntimePublicationSupersededError("Requester model policy changed.");
    }
  };
  assertCurrent();
  const read = await prepareChatMetadataSessionRead({
    cfg: config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    assertRequestCurrent: assertCurrent,
  });
  try {
    const session = read.selected;
    const assertSessionCurrent = () => {
      assertCurrent();
      read.assertCurrent();
      if (session.entry?.sessionId !== params.sessionId) {
        throw new PreparedModelRuntimePublicationSupersededError("Requester session changed.");
      }
    };
    assertSessionCurrent();
    const placement = params.context
      ? await readSessionWorkerPlacementAsync({
          context: params.context,
          sessionId: params.sessionId,
        })
      : undefined;
    assertSessionCurrent();
    const workerInference = placement
      ? readWorkerPlacementIdentity(placement, params.context?.workerEnvironmentService)?.inference
      : undefined;
    const scope: ChatMetadataReadParams = {
      agentId: params.agentId,
      sessionKey: session.canonicalKey,
      storePath: session.readSource?.path ?? session.storePath,
      sessionEntry: session.entry,
      requesterProfileId: authority.profileId,
      ...(workerInference ? { workerInference } : {}),
      assertCurrent: assertSessionCurrent,
      withCurrent: (consume) => read.withCurrent(consume),
      beforeRequest: assertSessionCurrent,
    };
    const snapshot =
      params.preparedModelRuntime ??
      getPublishedPreparedModelCatalogOwnerSnapshot({
        config,
        agentId: params.agentId,
      });
    if (!snapshot) {
      return await read.withCurrent(() => {
        assertSessionCurrent();
        return projectRequesterModelCatalog(
          {
            models: [],
            ...(policy ? { modelSelectionPolicy: { restricted: true, defaultModel: null } } : {}),
          },
          true,
        );
      });
    }
    const fullCatalog = snapshot.readFullModelCatalog?.();
    const prepared = fullCatalog
      ? materializePreparedModelCatalogOwner(snapshot, fullCatalog)
      : snapshot;
    const owner = resolvePublishedModelCatalogOwner(prepared);
    const assertPreparedCurrent = () => {
      assertSessionCurrent();
      if (!owner.isCurrent() || owner.agentId !== params.agentId) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Requester catalog owner changed.",
        );
      }
    };
    assertPreparedCurrent();
    const catalog = await prepareModelsListResult({
      source: {
        kind: "published",
        owner: {
          ...owner,
          authMaterializations: getPreparedModelRuntimeAuthMaterializations(prepared),
        },
      },
      agentId: params.agentId,
      requesterProfileId: authority.profileId,
      readScope: {
        ...scope,
        assertCurrent: assertPreparedCurrent,
        beforeRequest: assertPreparedCurrent,
      },
      params: { preparedOnly: true, includeDefaultModels: false },
      includeManualSelection: true,
    });
    assertPreparedCurrent();
    const ownership = await readSessionRuntimeOwnershipAsync({
      ...scope,
      config,
      assertCurrent: assertPreparedCurrent,
    });
    assertPreparedCurrent();
    return await read.withCurrent(() => {
      assertPreparedCurrent();
      if (!catalog.isCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Requester account catalog changed.",
        );
      }
      const result = catalog.read();
      const models = projectSessionModelCatalog(scope, result.models, config, ownership);
      const projected = { ...result, models };
      const presented =
        prepareOperatorModelPolicyPresentation({
          cfg: config,
          policy,
          metadataSnapshot: owner.metadataSnapshot,
        })
          ?.forAgent(params.agentId, models)
          .catalog(projected) ?? projected;
      return projectRequesterModelCatalog(
        presented,
        Boolean(snapshot.readFullModelCatalog && !fullCatalog),
      );
    });
  } finally {
    read.release();
  }
}
