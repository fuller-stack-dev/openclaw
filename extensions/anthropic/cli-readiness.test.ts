import type { CliBackendModelCatalogContext } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeInstallationFixture } from "./cli-installation.test-helpers.js";
import { createClaudeCliReadiness } from "./cli-readiness.js";

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
const model = "claude-opus-5-5";

async function fixture(signal = new AbortController().signal) {
  const installation = await createClaudeInstallationFixture(temps.make("claude-readiness-"));
  const api = createTestPluginApi();
  Object.assign(api.runtime, {
    state: {
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
        expect(options.env?.OPENCLAW_STATE_DIR).toBe(installation.context.env.OPENCLAW_STATE_DIR);
        return createPluginStateKeyedStoreForTests<T>("anthropic", options);
      },
    },
  });
  const invalidate = vi.fn();
  const create = () => createClaudeCliReadiness(api, invalidate);
  const context: CliBackendModelCatalogContext = {
    ...installation.context,
    cwd: installation.home,
    signal,
    modelIds: [model],
    reason: "discovery",
    withMaintenance: (update) => update(),
  };
  return {
    ...installation,
    context,
    invalidate,
    create,
    updates: async () => (await installation.calls()).filter(({ args }) => args[0] === "update"),
  };
}

// These executable fixtures cover the supported macOS/Linux automatic update path.
describe.skipIf(process.platform === "win32")("Claude CLI readiness", () => {
  it("cancels a waiting caller without interrupting shared repair or repeating CLI work", async ({
    signal,
  }) => {
    const lifetime = new AbortController();
    const f = await fixture(AbortSignal.any([signal, lifetime.signal]));
    const prepare = f.create();
    const completed = createDeferred<void>();
    const release = createDeferred<void>();
    const owner = prepare({
      ...f.context,
      withMaintenance: async (update) => {
        const result = await update();
        completed.resolve();
        await release.promise;
        return result;
      },
    });
    const controller = new AbortController();
    const waiters: ReturnType<typeof prepare>[] = [];
    try {
      await withinTest(
        awaitGateBeforeSettlement(completed.promise, owner, "Repair did not reach settlement"),
        signal,
      );
      const cancelled = prepare({ ...f.context, signal: controller.signal });
      const survivor = prepare(f.context);
      waiters.push(cancelled, survivor);
      let waiterSettled = false;
      const failure = cancelled
        .catch((error: unknown) => error)
        .finally(() => {
          waiterSettled = true;
        });
      controller.abort(new Error("Waiting turn cancelled"));
      // Abort rejection is local: drain promise reactions before releasing the owner.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(waiterSettled).toBe(true);
      expect(await failure).toMatchObject({ name: "AbortError" });
      expect(f.context.signal.aborted).toBe(false);
      release.resolve();
      for (const result of await Promise.all([owner, survivor])) {
        expect(result.models[model]).toEqual({ available: true });
        expect(result.runtimeVersion).toBe("2.1.286");
      }
      expect(await f.updates()).toHaveLength(1);
      expect(f.invalidate).toHaveBeenCalledOnce();
      const invocations = (await f.calls()).length;
      expect((await prepare({ ...f.context, reason: "routine" })).models[model]?.available).toBe(
        true,
      );
      expect((await f.calls()).length).toBe(invocations);
      const unknown = await prepare({ ...f.context, modelIds: ["claude-future-99"] });
      expect(unknown.models["claude-future-99"]).toMatchObject({
        available: false,
        compatibility: "unknown",
        reason: expect.stringContaining("not known"),
      });
      expect(await f.updates()).toHaveLength(1);
    } finally {
      lifetime.abort(new Error("Readiness test finished"));
      release.resolve();
      await Promise.allSettled([owner, ...waiters]);
    }
  });

  it("keeps failed attempts across owner restart and lets an explicit manual refresh repair them", async () => {
    const f = await fixture();
    await f.change({ fail: true });
    expect((await f.create()(f.context)).models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(1);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await f.change({ fail: false });
    const restarted = f.create();
    expect((await restarted(f.context)).models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(1);
    expect((await restarted({ ...f.context, reason: "manual" })).models[model]?.available).toBe(
      true,
    );
    expect(await f.updates()).toHaveLength(2);
  });

  it.for([
    { automaticReady: false, manualReady: true },
    { automaticReady: false, manualReady: false },
    { automaticReady: true, manualReady: true },
  ])(
    "honors pending manual refreshes after automatic readiness=$automaticReady, manual readiness=$manualReady",
    async ({ automaticReady, manualReady }, { signal }) => {
      const lifetime = new AbortController();
      const f = await fixture(AbortSignal.any([signal, lifetime.signal]));
      await f.change({ fail: !automaticReady });
      const prepare = f.create();
      const completed = createDeferred<void>();
      const release = createDeferred<void>();
      const automatic = prepare({
        ...f.context,
        withMaintenance: async (update) => {
          const result = await update();
          completed.resolve();
          await release.promise;
          return result;
        },
      });
      const waiters: ReturnType<typeof prepare>[] = [];
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            completed.promise,
            automatic,
            "Automatic update did not reach settlement",
          ),
          signal,
        );
        await f.change({ fail: !manualReady });
        const invocations = (await f.calls()).length;
        const enteredMaintenance = vi.fn();
        const manualContext: CliBackendModelCatalogContext = {
          ...f.context,
          reason: "manual",
          withMaintenance: (update) => {
            enteredMaintenance();
            return f.context.withMaintenance!(update);
          },
        };
        waiters.push(prepare(manualContext), prepare(manualContext), prepare(f.context));
        release.resolve();
        const [automaticResult, firstManual, secondManual, discovery] = await Promise.all([
          automatic,
          ...waiters,
        ]);
        expect(automaticResult.models[model]?.available).toBe(automaticReady);
        expect(discovery?.models[model]?.available).toBe(automaticReady);
        expect(firstManual?.models[model]?.available).toBe(manualReady);
        expect(secondManual?.models[model]?.available).toBe(manualReady);
        expect(enteredMaintenance).toHaveBeenCalledTimes(automaticReady ? 0 : 1);
        expect(await f.updates()).toHaveLength(automaticReady ? 1 : 2);
        if (automaticReady) {
          expect((await f.calls()).length).toBe(invocations);
        }
      } finally {
        lifetime.abort(new Error("Readiness test finished"));
        release.resolve();
        await Promise.allSettled([automatic, ...waiters]);
      }
    },
  );

  it("serves a durable failure cooldown without entering maintenance or repeating probes", async () => {
    const f = await fixture();
    await f.change({ fail: true });
    await f.create()(f.context);
    const enteredMaintenance = vi.fn();
    const restarted = f.create();
    const context: CliBackendModelCatalogContext = {
      ...f.context,
      runtimeGeneration: 1,
      withMaintenance: (update) => {
        enteredMaintenance();
        return f.context.withMaintenance!(update);
      },
    };
    expect((await restarted(context)).models[model]?.available).toBe(false);
    expect(enteredMaintenance).not.toHaveBeenCalled();
    const invocations = (await f.calls()).length;
    expect((await restarted(context)).models[model]?.available).toBe(false);
    expect((await f.calls()).length).toBe(invocations);
    expect(await f.updates()).toHaveLength(1);
  });

  it("preserves supported Haiku aliases and dated snapshots while inheriting version requirements", async () => {
    const f = await fixture();
    await f.change({ noChange: true });
    const ids = [
      "haiku",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5-20261001",
      "claude-opus-99-20261001",
    ];
    const result = await f.create()({ ...f.context, modelIds: ids });
    for (const id of ids.slice(0, 3)) {
      expect(result.models[id]).toEqual({ available: true });
    }
    expect(result.models[ids[3]!]).toMatchObject({
      available: false,
      reason: expect.stringContaining("requires 2.1.280"),
    });
    expect(result.models[ids[3]!]).not.toHaveProperty("compatibility");
    expect(result.models[ids[4]!]).toMatchObject({
      available: false,
      reason: expect.stringContaining("not known"),
    });
    expect(await f.updates()).toHaveLength(1);
  });

  it("does not publish an ineffective update as ready or retry it before the daily deadline", async () => {
    const f = await fixture();
    await f.change({ noChange: true });
    const prepare = f.create();
    const result = await prepare(f.context);
    expect(result.models[model]).toMatchObject({
      available: false,
      reason: expect.stringContaining("requires 2.1.280"),
    });
    expect((await prepare(f.context)).models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(1);
    await f.change({ noChange: false });
    vi.spyOn(Date, "now").mockReturnValue(result.nextCheckAt! + 1);
    expect((await prepare({ ...f.context, reason: "routine" })).models[model]?.available).toBe(
      true,
    );
    expect(await f.updates()).toHaveLength(2);
  });

  it("preserves unknown configured IDs without verifying them or bypassing a newly discovered requirement", async () => {
    const f = await fixture();
    const prepare = f.create();
    const result = await prepare({
      ...f.context,
      modelIds: ["claude-opus-5", "claude-future-99"],
    });
    expect(result.models["claude-opus-5"]?.available).toBe(true);
    expect(result.models["claude-future-99"]).toMatchObject({
      available: false,
      compatibility: "unknown",
    });
    expect(result.runtimeVersion).toBe("2.1.269");
    expect(await f.updates()).toHaveLength(0);
    expect((await prepare(f.context)).models[model]?.available).toBe(true);
    expect(await f.updates()).toHaveLength(1);
  });

  it("defers repair during active use and repairs when maintenance is admitted without a cooldown", async () => {
    const f = await fixture();
    const prepare = f.create();
    const blocked = await prepare({ ...f.context, withMaintenance: async () => undefined });
    expect(blocked.models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(0);
    expect(blocked.nextCheckAt).toBeLessThan(Date.now() + 60_000);
    vi.spyOn(Date, "now").mockReturnValue(blocked.nextCheckAt! + 1);
    expect((await prepare(f.context)).models[model]?.available).toBe(true);
    expect(await f.updates()).toHaveLength(1);
  });
});
