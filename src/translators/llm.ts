type LlmTranslateOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  from: string;
  to: string;
  text: string;
};

type LlmRegionInput = {
  id: string;
  text: string;
  direction: 'h' | 'v';
  targetColumns?: number;
};

type LlmTranslateRegionsOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  from: string;
  to: string;
  regions: LlmRegionInput[];
};

type RegionTranslationResult = {
  translatedText: string;
  translatedColumns?: string[];
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return text.trim();
  }
  return text.slice(start, end + 1).trim();
}

function parseColumnsPayload(content: string): Map<string, RegionTranslationResult> {
  const jsonText = extractJsonObject(content);
  const parsed = JSON.parse(jsonText) as {
    regions?: Array<{
      id?: string;
      translation?: string;
      columns?: unknown;
    }>;
  };

  if (!Array.isArray(parsed.regions)) {
    throw new Error('LLM 列翻译响应缺少 regions 字段');
  }

  const byId = new Map<string, RegionTranslationResult>();
  for (const item of parsed.regions) {
    if (!item || typeof item.id !== 'string') {
      continue;
    }
    const translatedText = typeof item.translation === 'string' ? item.translation.trim() : '';
    if (!translatedText) {
      continue;
    }

    let translatedColumns: string[] | undefined;
    if (Array.isArray(item.columns)) {
      const normalized = item.columns
        .filter((col): col is string => typeof col === 'string')
        .map((col) => col.trim())
        .filter(Boolean);
      if (normalized.length > 0) {
        translatedColumns = normalized;
      }
    }

    byId.set(item.id, { translatedText, translatedColumns });
  }

  return byId;
}

export async function llmTranslate(options: LlmTranslateOptions): Promise<string> {
  const { baseUrl, apiKey, model, temperature, from, to, text } = options;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        {
          role: "system",
          content: "你是漫画翻译助手，只输出翻译文本，不输出解释。"
        },
        {
          role: "user",
          content: `请把以下文本从${from}翻译成${to}：\n${text}`
        }
      ]
    })
  });

  if (!res.ok) {
    throw new Error(`LLM 翻译请求失败: ${res.status}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("LLM 翻译响应为空");
  }
  return content;
}

export async function llmTranslateRegions(
  options: LlmTranslateRegionsOptions,
): Promise<Map<string, RegionTranslationResult>> {
  const { baseUrl, apiKey, model, temperature, from, to, regions } = options;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload = regions.map((region) => ({
    id: region.id,
    direction: region.direction,
    targetColumns: region.direction === 'v' ? Math.max(1, region.targetColumns ?? 1) : undefined,
    sourceText: region.text,
  }));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        {
          role: 'system',
          content: [
            '你是漫画翻译助手。',
            '你会在理解整页上下文的前提下逐框翻译。',
            '必须严格输出 JSON，不得输出解释。',
          ].join(''),
        },
        {
          role: 'user',
          content: [
            `请把以下文本从${from}翻译成${to}，并基于整段上下文保持语气一致。`,
            '输入是多个文本框。对竖排框你会收到 targetColumns（期望列数）。',
            '竖排框请把 sourceText 的换行视为输入 columns。',
            '返回格式必须是：',
            '{"regions":[{"id":"...","translation":"...","columns":["..."]}]}',
            '规则：',
            '1) regions 数组必须覆盖所有输入 id；',
            '2) translation 为完整译文；',
            '3) direction=v 时，columns 必须严格按输入 columns 的顺序返回（不得反转），优先接近 targetColumns；',
            '4) direction=h 时，columns 省略；',
            '5) 除 JSON 外不要输出任何内容。',
            `输入数据：${JSON.stringify(payload)}`,
          ].join('\n'),
        },
      ],
      response_format: {
        type: 'json_object',
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM 翻译请求失败: ${res.status}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('LLM 翻译响应为空');
  }

  return parseColumnsPayload(content);
}
