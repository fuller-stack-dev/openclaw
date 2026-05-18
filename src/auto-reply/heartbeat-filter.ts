import { HEARTBEAT_RESPONSE_TOOL_NAME } from "./heartbeat-tool-response.js";
import {
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  HEARTBEAT_TRANSCRIPT_PROMPT,
  resolveHeartbeatPromptForResponseTool,
  stripHeartbeatToken,
} from "./heartbeat.js";

const HEARTBEAT_TASK_PROMPT_PREFIX =
  "Run the following periodic tasks (only those due based on their intervals):";
const HEARTBEAT_TASK_PROMPT_ACK = "After completing all due tasks, reply HEARTBEAT_OK.";
const TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "functionCall",
  "toolUse",
  "tool_call",
  "function_call",
  "tool_use",
]);
const TOOL_RESULT_BLOCK_TYPES = new Set(["toolResult", "tool_result", "function_call_output"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNestedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value.name);
}

function collectToolCallBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && TOOL_CALL_BLOCK_TYPES.has(String(block.type ?? "")),
  );
}

function readToolCallName(block: Record<string, unknown>): string | undefined {
  return readString(block.name) ?? readNestedString(block, "function");
}

function isHeartbeatResponseToolCall(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (isRecord(message)) {
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (!isRecord(call)) {
        continue;
      }
      const name = readToolCallName(call);
      if (name === HEARTBEAT_RESPONSE_TOOL_NAME) {
        return true;
      }
    }
  }
  return collectToolCallBlocks(message.content).some(
    (block) => readToolCallName(block) === HEARTBEAT_RESPONSE_TOOL_NAME,
  );
}

function isEmbeddedToolResultContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) => isRecord(block) && TOOL_RESULT_BLOCK_TYPES.has(String(block.type ?? "")),
    )
  );
}

function isToolResultMessage(message: { role: string; content?: unknown }): boolean {
  return (
    message.role === "toolResult" ||
    message.role === "tool" ||
    (message.role === "user" && isEmbeddedToolResultContent(message.content))
  );
}

function isRealNonHeartbeatUserMessage(
  message: { role: string; content?: unknown },
  heartbeatPrompt?: string,
): boolean {
  return (
    message.role === "user" &&
    !isEmbeddedToolResultContent(message.content) &&
    !isHeartbeatUserMessage(message, heartbeatPrompt)
  );
}

function matchesHeartbeatPromptText(text: string, prompt: string | undefined): boolean {
  const normalized = prompt?.trim();
  return Boolean(normalized) && (text === normalized || text.startsWith(`${normalized}\n`));
}

function resolveMessageText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  let text = "";
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      hasNonTextContent = true;
      continue;
    }
    if (block.type !== "text") {
      hasNonTextContent = true;
      continue;
    }
    const blockText = (block as { text?: unknown }).text;
    if (typeof blockText !== "string") {
      hasNonTextContent = true;
      continue;
    }
    text += blockText;
  }
  return { text, hasNonTextContent };
}

export function isHeartbeatUserMessage(
  message: { role: string; content?: unknown },
  heartbeatPrompt?: string,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalizedHeartbeatPrompt = heartbeatPrompt?.trim();
  if (trimmed === HEARTBEAT_TRANSCRIPT_PROMPT) {
    return true;
  }
  if (matchesHeartbeatPromptText(trimmed, normalizedHeartbeatPrompt)) {
    return true;
  }
  if (matchesHeartbeatPromptText(trimmed, HEARTBEAT_RESPONSE_TOOL_PROMPT)) {
    return true;
  }
  if (
    normalizedHeartbeatPrompt &&
    matchesHeartbeatPromptText(
      trimmed,
      resolveHeartbeatPromptForResponseTool(normalizedHeartbeatPrompt),
    )
  ) {
    return true;
  }
  return (
    trimmed.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX) && trimmed.includes(HEARTBEAT_TASK_PROMPT_ACK)
  );
}

export function isHeartbeatOkResponse(
  message: { role: string; content?: unknown },
  ackMaxChars?: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  return stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars: ackMaxChars }).shouldSkip;
}

function advancePastAdjacentToolResults<T extends { role: string; content?: unknown }>(
  messages: T[],
  startIndex: number,
): number {
  let index = startIndex;
  while (index < messages.length && isToolResultMessage(messages[index])) {
    index++;
  }
  return index;
}

export function filterHeartbeatTranscriptArtifacts<T extends { role: string; content?: unknown }>(
  messages: T[],
  ackMaxChars?: number,
  heartbeatPrompt?: string,
): T[] {
  if (messages.length === 0) {
    return messages;
  }

  const result: T[] = [];
  let i = 0;
  while (i < messages.length) {
    if (!isHeartbeatUserMessage(messages[i], heartbeatPrompt)) {
      result.push(messages[i]);
      i++;
      continue;
    }

    let next = i + 1;
    while (next < messages.length) {
      const message = messages[next];
      if (isRealNonHeartbeatUserMessage(message, heartbeatPrompt)) {
        break;
      }
      if (isHeartbeatOkResponse(message, ackMaxChars)) {
        next = advancePastAdjacentToolResults(messages, next + 1);
        continue;
      }
      if (isHeartbeatResponseToolCall(message)) {
        next = advancePastAdjacentToolResults(messages, next + 1);
        continue;
      }
      // Keep walking heartbeat-owned helper tool calls/results, assistant text,
      // and consecutive heartbeat prompts, but never cross a real user message.
      next++;
    }

    i = next;
  }

  return result;
}
