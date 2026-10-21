import {
  SCHEMA_MAP_KEYS,
  SCHEMA_NESTED_KEYS,
  truncateToolSchemaDepth,
} from "@openclaw/ai/internal/tool-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ProviderToolSchemaDiagnostic } from "./provider-replay.types.js";

/** Inspect schema-bearing slots only; defaults and examples are literal data. */
function findBareNestedObjects(schema: unknown, path: string, nested = false): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      findBareNestedObjects(entry, `${path}[${index}]`, true),
    );
  }
  if (!isRecord(schema)) {
    return [];
  }
  const violations =
    nested &&
    schema.type === "object" &&
    !("properties" in schema) &&
    !("additionalProperties" in schema)
      ? [path]
      : [];
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        violations.push(...findBareNestedObjects(child, `${path}.${key}.${name}`, true));
      }
    } else if (SCHEMA_NESTED_KEYS.has(key)) {
      violations.push(...findBareNestedObjects(value, `${path}.${key}`, true));
    }
  }
  return violations;
}

/** One warning per tool, shared by registration and provider inspection. */
export function inspectOpenDictionaryToolSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
): ProviderToolSchemaDiagnostic[] {
  return tools.flatMap((tool, toolIndex) => {
    const violations = findBareNestedObjects(
      truncateToolSchemaDepth(tool.parameters),
      `${tool.name}.parameters`,
    );
    return violations.length ? [{ toolName: tool.name, toolIndex, violations }] : [];
  });
}
