import { describe, expect, it } from "vitest";
import {
  filterHeartbeatTranscriptArtifacts,
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "./heartbeat-filter.js";
import {
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TRANSCRIPT_PROMPT,
  resolveHeartbeatPromptForResponseTool,
} from "./heartbeat.js";

describe("isHeartbeatUserMessage", () => {
  it("matches heartbeat prompts", () => {
    expect(
      isHeartbeatUserMessage(
        {
          role: "user",
          content: `${HEARTBEAT_PROMPT}\nWhen reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md (exact case). Do not read docs/heartbeat.md.`,
        },
        HEARTBEAT_PROMPT,
      ),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        role: "user",
        content:
          "Run the following periodic tasks (only those due based on their intervals):\n\n- email-check: Check for urgent unread emails\n\nAfter completing all due tasks, reply HEARTBEAT_OK.",
      }),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: HEARTBEAT_TRANSCRIPT_PROMPT,
      }),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: HEARTBEAT_RESPONSE_TOOL_PROMPT,
      }),
    ).toBe(true);

    const customHeartbeatPrompt = "Check the handoff queue.";
    expect(
      isHeartbeatUserMessage(
        {
          role: "user",
          content: `${resolveHeartbeatPromptForResponseTool(customHeartbeatPrompt)}\n\nUse workspace notes only.`,
        },
        customHeartbeatPrompt,
      ),
    ).toBe(true);
  });

  it("ignores quoted or non-user token mentions", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "Please reply HEARTBEAT_OK so I can test something.",
      }),
    ).toBe(false);

    expect(
      isHeartbeatUserMessage({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(false);
  });
});

describe("isHeartbeatOkResponse", () => {
  it("matches no-op heartbeat acknowledgements", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "**HEARTBEAT_OK**",
      }),
    ).toBe(true);

    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "You have 3 unread urgent emails. HEARTBEAT_OK",
      }),
    ).toBe(true);
  });

  it("preserves meaningful or non-text responses", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "Status HEARTBEAT_OK due to watchdog failure",
      }),
    ).toBe(false);

    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }],
      }),
    ).toBe(false);
  });

  it("respects ackMaxChars overrides", () => {
    expect(
      isHeartbeatOkResponse(
        {
          role: "assistant",
          content: "HEARTBEAT_OK all good",
        },
        0,
      ),
    ).toBe(false);
  });
});

describe("filterHeartbeatTranscriptArtifacts", () => {
  it("removes no-op heartbeat pairs", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ]);
  });

  it("removes heartbeat response-tool spans and preserves the next real user message", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bash", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked HEARTBEAT.md" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes full default response-tool prompt spans", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_RESPONSE_TOOL_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes native OpenAI Responses heartbeat function-call spans", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "call_bash",
            name: "bash",
            arguments: '{"command":"cat HEARTBEAT.md"}',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "function_call_output",
            call_id: "call_bash",
            output: "checked HEARTBEAT.md",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: '{"notify":false}',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "function_call_output",
            call_id: "call_heartbeat",
            output: '{"notify":false}',
          },
        ],
      },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes assistant continuations after heartbeat response-tool results", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      { role: "assistant", content: "No visible update. notify=false" },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("does not remove across a real user message", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bash", name: "bash", arguments: {} }],
      },
      { role: "user", content: "what model are you" },
      { role: "assistant", content: "notify=false" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
      { role: "assistant", content: "notify=false" },
    ]);
  });

  it("removes heartbeat-owned meaningful results and non-text assistant turns", () => {
    const meaningfulMessages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "Status HEARTBEAT_OK due to watchdog failure" },
    ];
    expect(
      filterHeartbeatTranscriptArtifacts(meaningfulMessages, undefined, HEARTBEAT_PROMPT),
    ).toEqual([]);

    const nonTextMessages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }],
      },
    ];
    expect(
      filterHeartbeatTranscriptArtifacts(nonTextMessages, undefined, HEARTBEAT_PROMPT),
    ).toEqual([]);
  });

  it("keeps ordinary chats that mention the token", () => {
    const messages = [
      { role: "user", content: "Please reply HEARTBEAT_OK so I can test something." },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });
});
