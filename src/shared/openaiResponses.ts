import type { LlmChatCompletionRequestBody, LlmChatMessage } from './messages';

type OpenAiResponsesContent = {
  type: 'input_text' | 'output_text';
  text: string;
};

type OpenAiResponsesMessage = {
  type: 'message';
  role: 'user' | 'assistant';
  content: OpenAiResponsesContent[];
};

type OpenAiResponsesTextFormat = {
  type: 'json_schema';
  name: string;
  strict: boolean;
  schema: {
    type: 'object';
    additionalProperties: boolean;
  };
};

export type OpenAiResponsesRequest = {
  model: string;
  instructions: string;
  input: OpenAiResponsesMessage[];
  tools: [];
  tool_choice: 'auto';
  parallel_tool_calls: true;
  reasoning: {
    effort: NonNullable<LlmChatCompletionRequestBody['reasoning_effort']>;
  } | null;
  store: false;
  stream: true;
  include: string[];
  text?: {
    format: OpenAiResponsesTextFormat;
  };
  client_metadata?: Record<string, string>;
};

type SseEvent = {
  event?: string;
  data: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildInstructions(messages: LlmChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

function buildInput(messages: LlmChatMessage[]): OpenAiResponsesMessage[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      type: 'message' as const,
      role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: [
        {
          type: message.role === 'assistant' ? ('output_text' as const) : ('input_text' as const),
          text: message.content,
        },
      ],
    }));
}

function buildJsonObjectTextFormat(): OpenAiResponsesTextFormat {
  return {
    type: 'json_schema',
    name: 'shinobu_translation_response',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: true,
    },
  };
}

export function buildOpenAiResponsesRequest(
  body: LlmChatCompletionRequestBody,
  clientMetadata?: Record<string, string>,
): OpenAiResponsesRequest {
  const request: OpenAiResponsesRequest = {
    model: body.model,
    instructions: buildInstructions(body.messages),
    input: buildInput(body.messages),
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: body.reasoning_effort
      ? { effort: body.reasoning_effort }
      : null,
    store: false,
    stream: true,
    include: [],
  };

  if (body.response_format?.type === 'json_object') {
    request.text = { format: buildJsonObjectTextFormat() };
  }
  if (clientMetadata && Object.keys(clientMetadata).length > 0) {
    request.client_metadata = clientMetadata;
  }

  return request;
}

function extractContentText(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const text = item.text;
    return typeof text === 'string' ? [text] : [];
  });
}

export function extractOpenAiResponsesJsonText(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }

  if (typeof data.output_text === 'string') {
    return data.output_text;
  }

  if (Array.isArray(data.output)) {
    const outputText = data.output.flatMap((item) => (isRecord(item) ? extractContentText(item.content) : []));
    if (outputText.length > 0) {
      return outputText.join('');
    }
  }

  if (isRecord(data.item)) {
    const itemText = extractContentText(data.item.content);
    if (itemText.length > 0) {
      return itemText.join('');
    }
  }

  return null;
}

function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return;
    }
    events.push({ event: eventName, data: dataLines.join('\n') });
    eventName = undefined;
    dataLines = [];
  };

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  flush();

  return events;
}

export function extractOpenAiResponsesSseText(text: string): string | null {
  const finalCandidates: string[] = [];
  let deltaText = '';

  for (const event of parseSseEvents(text)) {
    if (event.data === '[DONE]') {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      continue;
    }

    if (!isRecord(parsed)) {
      continue;
    }

    const eventType = typeof parsed.type === 'string' ? parsed.type : event.event;
    if (eventType === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      deltaText += parsed.delta;
      continue;
    }

    const candidate = extractOpenAiResponsesJsonText(parsed);
    if (candidate) {
      finalCandidates.push(candidate);
    }
  }

  if (deltaText) {
    return deltaText;
  }
  return finalCandidates.length > 0 ? finalCandidates[finalCandidates.length - 1] : null;
}
