import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import { collectPluginLoadHealthFindings } from "../commands/doctor-workspace-status.js";
import { withPluginLoadDiagnostics } from "./load-diagnostics.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { buildPluginInspectReport } from "./status.js";

it.each(["static", "factory", "versioned factory"] as const)(
  "surfaces one %s schema warning in inspect and doctor without rejecting the tool",
  (kind) =>
    withPluginLoadDiagnostics((observed) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "schema-owner",
        source: "/synthetic/schema-owner.ts",
        origin: "global",
        enabled: true,
        configSchema: false,
        contracts: { tools: ["metadata"] },
      });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {} });
      onTestFinished(async () => {
        await getPluginInstance(record)?.dispose();
      });
      const tool = {
        name: "metadata",
        label: "Metadata",
        description: "Store metadata",
        parameters: Type.Object({ payload: Type.Unsafe({ type: "object" }) }),
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
      };
      api.registerTool(
        kind === "static"
          ? tool
          : kind === "factory"
            ? () => tool
            : {
                contextVersion: 2,
                create: () => tool,
              },
        { name: "metadata" },
      );
      expect(builder.registry.diagnostics).toHaveLength(kind === "static" ? 1 : 0);
      const factory = builder.registry.tools[0]!.factory;
      expect(factory({ assertInvocationCurrent() {} })).toMatchObject({ name: "metadata" });
      factory({ assertInvocationCurrent() {} });
      expect(builder.registry.diagnostics).toEqual([
        expect.objectContaining({
          level: "warn",
          pluginId: record.id,
          message: expect.stringContaining("metadata.parameters.properties.payload"),
        }),
      ]);
      const inspect = buildPluginInspectReport({
        id: record.id,
        config: {},
        report: builder.registry,
      });
      expect(inspect?.diagnostics).toEqual(builder.registry.diagnostics);
      expect(observed).toEqual(builder.registry.diagnostics);
      expect(collectPluginLoadHealthFindings(observed)).toEqual([
        expect.objectContaining({
          severity: "warning",
          target: record.id,
          message: expect.stringContaining("will be closed on strict-compat providers"),
        }),
      ]);
    }),
);
