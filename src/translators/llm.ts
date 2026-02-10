type LlmTranslateOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  from: string;
  to: string;
  text: string;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export async function llmTranslate(options: LlmTranslateOptions): Promise<string> {
  const { baseUrl, apiKey, model, from, to, text } = options;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
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
