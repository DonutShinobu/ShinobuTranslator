import { describe, expect, it } from "vitest";
import {
  buildOpenAiResponsesRequest,
  extractOpenAiResponsesJsonText,
  extractOpenAiResponsesSseText,
} from "../../src/shared/openaiResponses";
import type { LlmChatCompletionRequestBody } from "../../src/shared/messages";

describe("buildOpenAiResponsesRequest", () => {
  it("converts a chat completion request to the Codex Responses shape", () => {
    const body: LlmChatCompletionRequestBody = {
      model: "gpt-5.1",
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Only output JSON." },
        { role: "user", content: "Translate this bubble." },
      ],
    };

    expect(buildOpenAiResponsesRequest(body, { "x-codex-installation-id": "install-1" })).toEqual({
      model: "gpt-5.1",
      instructions: "Only output JSON.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Translate this bubble." }],
        },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high" },
      store: false,
      stream: true,
      include: [],
      text: {
        format: {
          type: "json_schema",
          name: "shinobu_translation_response",
          strict: false,
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      client_metadata: { "x-codex-installation-id": "install-1" },
    });
  });
});

describe("extractOpenAiResponsesJsonText", () => {
  it("extracts assistant output text from a non-stream Responses body", () => {
    expect(
      extractOpenAiResponsesJsonText({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "{\"ok\":true}" }],
          },
        ],
      }),
    ).toBe("{\"ok\":true}");
  });
});

describe("extractOpenAiResponsesSseText", () => {
  it("accumulates output_text delta events", () => {
    const sse = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"你"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"好"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed"}',
      "",
    ].join("\n");

    expect(extractOpenAiResponsesSseText(sse)).toBe("你好");
  });
});
