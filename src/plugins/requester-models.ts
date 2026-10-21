import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRequesterModels } from "./model-catalog.types.js";
import { getInProcessGatewayRequestContext } from "./runtime/gateway-request-scope.js";

/** Host-only minting: callers cannot supply selectors through the plugin-facing reader. */
export function createPluginRequesterModels(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  authority?: AdmittedRunOperatorAuthority;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): PluginRequesterModels | undefined {
  const { authority, config, agentId, sessionKey, sessionId } = params;
  if (!authority || !config || !agentId || !sessionKey || !sessionId) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  // Capture this owner now, never borrow a later request's client or Gateway context.
  const context = getInProcessGatewayRequestContext();
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    authority.signal?.throwIfAborted();
    params.assertCurrent();
    authority.assertCurrent();
  };
  return Object.freeze({
    async list() {
      assertCurrent();
      const { readRequesterModelCatalog } =
        await import("../gateway/server-methods/requester-model-catalog.js");
      assertCurrent();
      const result = await readRequesterModelCatalog({
        config,
        agentId,
        sessionKey,
        sessionId,
        authority,
        preparedModelRuntime: params.preparedModelRuntime,
        context,
        assertCurrent,
      });
      assertCurrent();
      return result;
    },
  });
}
