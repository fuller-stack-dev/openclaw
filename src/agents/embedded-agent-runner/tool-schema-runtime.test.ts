// Tool schema runtime tests cover provider plugin schema normalization and
// compact diagnostics for invalid provider-facing tool schemas.
import { Type, type TSchema } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Hoisted mocks let the module under test import logger/provider runtime once
  // while each case controls plugin diagnostics.
  inspectProviderToolSchemasWithPlugin: vi.fn(),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// mock-isolation: this unit owns log deduplication; provider inspection is supplied by the hook.
vi.mock("../../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: mocks.inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

// mock-isolation: capture warnings without writing process logs.
vi.mock("./logger.js", () => ({
  log: mocks.log,
}));

const { logProviderToolSchemaDiagnostics, normalizeProviderToolSchemas } =
  await import("./tool-schema-runtime.js");

describe("tool schema runtime diagnostics", () => {
  beforeEach(() => vi.resetAllMocks());
  it("stays quiet when a provider reports no diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it("passes through provider runtime loading policy for normalization", () => {
    const tools = [{ name: "alpha" }] as never;
    const runtimeHandle = { provider: "example", plugin: { id: "example-plugin" } } as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockReturnValueOnce(tools);

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
        runtimeHandle,
        allowRuntimePluginLoad: false,
      }),
    ).toBe(tools);

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "example",
        runtimeHandle,
        allowRuntimePluginLoad: false,
      }),
    );
  });

  it("deduplicates by schema identity, provider and tool name without hiding changed schemas", () => {
    const schema: TSchema = Type.Object({ payload: Type.Unsafe({ type: "object" }) });
    const tools = [
      {
        name: "dedup",
        label: "Dedup",
        description: "",
        parameters: schema,
        execute: async () => ({ content: [], details: {} }),
      },
    ];
    const diagnostics = [{ toolName: "dedup", toolIndex: 0, violations: ["payload"] }];
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValue(diagnostics);
    const warn = () => logProviderToolSchemaDiagnostics({ provider: "example", tools });
    warn();
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValue([
      { toolName: "dedup", violations: ["payload"] },
    ]);
    warn();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    tools[0]!.parameters = Type.Object({ payload: Type.Object({}) });
    warn();
    expect(mocks.log.warn).toHaveBeenCalledTimes(2);
    logProviderToolSchemaDiagnostics({ provider: "other", tools });
    expect(mocks.log.warn).toHaveBeenCalledTimes(3);
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValue([
      { ...diagnostics[0], toolName: "renamed" },
    ]);
    warn();
    expect(mocks.log.warn).toHaveBeenCalledTimes(4);
  });

  it("logs one summarized warning for provider tool schema diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([
      { toolName: "alpha", toolIndex: 0, violations: ["one", "two"] },
      { toolName: "beta", toolIndex: 1, violations: ["one"] },
    ]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 2 tools for example: alpha (2 violations), beta (1 violation)",
      {
        provider: "example",
        toolCount: 2,
        diagnosticCount: 2,
        tools: ["0:alpha", "1:beta"],
        diagnostics: [
          { index: 0, tool: "alpha", violations: ["one", "two"], violationCount: 2 },
          { index: 1, tool: "beta", violations: ["one"], violationCount: 1 },
        ],
      },
    );
  });
});
