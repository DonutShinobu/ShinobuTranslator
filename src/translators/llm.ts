import type { LlmAuthMode, LlmProvider } from '../types';
import { sendRuntimeMessage } from '../shared/messages';
import type { LlmChatCompletionRequestBody } from '../shared/messages';
import {
  classifyLlmFetchError,
  sanitizeDiagnosticUrl,
  toDiagnosticError,
} from '../shared/diagnosticLog';
import { emitDiagnosticLog, getDiagnosticExecutionContext } from '../shared/diagnosticLogClient';

type LlmTranslateOptions = {
  provider: LlmProvider;
  authMode: LlmAuthMode;
  baseUrl: string;
  model: string;
  from: string;
  to: string;
  text: string;
  diagnosticRunId?: string;
};

type LlmRegionInput = {
  id: string;
  text: string;
  direction: 'h' | 'v';
  targetColumns?: number;
  targetLines?: number;
};

type LlmSourceTextSegment = {
  index: number;
  label: string;
  text: string;
};

type LlmSourceTextPayload = {
  plainText: string;
  textWithBreaks: string;
  readingOrder: 'right-to-left' | 'top-to-bottom';
  columns?: LlmSourceTextSegment[];
  lines?: LlmSourceTextSegment[];
};

type LlmTranslateRegionsOptions = {
  provider: LlmProvider;
  authMode: LlmAuthMode;
  baseUrl: string;
  model: string;
  from: string;
  to: string;
  regions: LlmRegionInput[];
  diagnosticRunId?: string;
};

type RegionTranslationResult = {
  translatedText: string;
  translatedColumns?: string[];
};

type ChatCompletionRequestOptions = {
  provider: LlmProvider;
  authMode: LlmAuthMode;
  baseUrl: string;
  diagnosticRunId?: string;
};

export type LlmRegionBatchResult = {
  byId: Map<string, RegionTranslationResult>;
  rawContent: string;
};

export class LlmColumnsParseError extends Error {
  readonly rawContent: string;

  constructor(message: string, rawContent: string) {
    super(message);
    this.name = 'LlmColumnsParseError';
    this.rawContent = rawContent;
  }
}

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

function splitSourceSegments(text: string, labelPrefix: 'column' | 'line'): LlmSourceTextSegment[] {
  return text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment, index) => ({
      index: index + 1,
      label: `${labelPrefix}${index + 1}`,
      text: segment,
    }));
}

function buildSourceTextPayload(text: string, direction: 'h' | 'v'): LlmSourceTextPayload {
  const plainText = text.replace(/\n+/g, '').trim();
  const textWithBreaks = text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('\n');
  if (direction !== 'v') {
    const lines = splitSourceSegments(text, 'line');
    if (lines.length > 1) {
      return {
        plainText,
        textWithBreaks,
        readingOrder: 'top-to-bottom',
        lines,
      };
    }
    return {
      plainText,
      textWithBreaks,
      readingOrder: 'top-to-bottom',
    };
  }
  const columns = splitSourceSegments(text, 'column');
  return {
    plainText,
    textWithBreaks,
    readingOrder: 'right-to-left',
    columns,
  };
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

async function requestChatCompletion(
  options: ChatCompletionRequestOptions,
  body: LlmChatCompletionRequestBody,
): Promise<ChatCompletionResponse> {
  const startedAt = Date.now();
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const bodyJson = JSON.stringify(body);
  const baseLogData = {
    provider: options.provider,
    authMode: options.authMode,
    model: body.model,
    endpoint: sanitizeDiagnosticUrl(endpoint),
    messageCount: body.messages.length,
    responseFormat: body.response_format?.type ?? 'default',
    requestBodyBytes: bodyJson.length,
    requestBody: body,
  };
  emitDiagnosticLog({
    runId: options.diagnosticRunId,
    level: 'info',
    category: 'llm.api',
    source: { context: getDiagnosticExecutionContext(), module: 'translators/llm.ts' },
    message: `${options.provider} LLM 请求开始`,
    data: {
      ...baseLogData,
      contentDirectFetch: false,
    },
  });

  try {
    const response = await sendRuntimeMessage({
      type: 'mt:llm-chat-completions',
      body,
      proxyConfig: {
        provider: options.provider,
        authMode: options.authMode,
        baseUrl: options.baseUrl,
      },
      diagnosticRunId: options.diagnosticRunId,
    });
    if (!response.ok || response.type !== 'mt:llm-chat-completions') {
      throw new Error(response.ok ? 'LLM 翻译请求失败' : response.error);
    }
    emitDiagnosticLog({
      runId: options.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: getDiagnosticExecutionContext(), module: 'translators/llm.ts' },
      message: `${options.provider} LLM 请求完成`,
      data: {
        ...baseLogData,
        contentDirectFetch: false,
        durationMs: Date.now() - startedAt,
        responseData: response.data,
      },
    });
    return response.data as ChatCompletionResponse;
  } catch (error) {
    const classification = classifyLlmFetchError(error);
    emitDiagnosticLog({
      runId: options.diagnosticRunId,
      level: 'error',
      category: 'llm.api',
      source: { context: getDiagnosticExecutionContext(), module: 'translators/llm.ts' },
      message: `${options.provider} LLM 代理请求失败：${classification.reason}`,
      data: {
        ...baseLogData,
        contentDirectFetch: false,
        durationMs: Date.now() - startedAt,
        classification,
      },
      error: toDiagnosticError(error),
    });
    throw error;
  }
}

export async function llmTranslate(options: LlmTranslateOptions): Promise<string> {
  const { model, from, to, text } = options;
  const data = await requestChatCompletion(options, {
    model,
    messages: [
      {
        role: 'system',
        content: [
          '你是专业漫画本地化译者和中文润色编辑。',
          '你的目标是把台词改写成自然、口语化、符合中文漫画阅读习惯的译文。',
          '不要保留日语倒装语序，不要逐词直译，只输出译文，不输出解释。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `请把以下文本从 ${from} 翻译成 ${to}。`,
          '请先理解完整语义，再用自然中文表达；必要时可以调整语序、合并或拆分短句。',
          '如果原文包含换行，它可能只是漫画竖排或横排的视觉断列；请把它当作同一段语义处理，不要逐行逐列直译。',
          '只输出最终译文，不要输出注释、括号说明或原文。',
          '原文：',
          text,
        ].join('\n'),
      },
    ],
  });
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('LLM 翻译响应为空');
  }
  return content;
}

export async function llmTranslateRegions(
  options: LlmTranslateRegionsOptions,
): Promise<LlmRegionBatchResult> {
  const { model, from, to, regions } = options;
  const payload = regions.map((region) => ({
    id: region.id,
    direction: region.direction,
    targetColumns: region.direction === 'v' ? Math.max(1, region.targetColumns ?? 1) : undefined,
    targetLines: region.direction === 'h' ? Math.max(1, region.targetLines ?? 1) : undefined,
    sourceText: buildSourceTextPayload(region.text, region.direction),
  }));

  const data = await requestChatCompletion(options, {
    model,
    messages: [
      {
        role: 'system',
        content: [
          '你是专业漫画本地化译者和中文润色编辑。',
          '你会先理解整页上下文和每个文本框的完整语义，再写出自然中文译文。',
          '不要按日语列顺序逐列直译，不要保留日语倒装语序。',
          'columns/lines 是排版分段，不是逐列逐句对应原文。',
          '必须严格输出 JSON，不得输出解释。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `请把以下文本从 ${from} 翻译成 ${to}，并基于整页上下文保持语气、称呼和情绪一致。`,
          '输入是多个文本框。请按输入顺序理解上下文，但每个 region 仍独立返回。',
          'sourceText.plainText 是去掉换行后的完整原文，用于理解整句语义。',
          'sourceText.textWithBreaks 保留 OCR/视觉换行，用于参考原始断列或断行。',
          'sourceText.readingOrder 描述视觉阅读顺序：right-to-left 表示竖排从右到左，top-to-bottom 表示横排行从上到下。',
          'sourceText.columns/sourceText.lines 是结构化分段数组，格式为 [{"index":1,"label":"column1","text":"..."}]。',
          '返回格式必须是：',
          '{"regions":[{"id":"...","translation":"...","columns":["..."]}]}',
          '规则：',
          '1. regions 数组必须覆盖所有输入 id。',
          '2. translation 必须是自然流畅的完整中文译文，优先符合中文语序和中文漫画台词习惯。',
          '3. 翻译时必须允许跨 column/line 重组语义；不要把每个 column/line 当成必须逐字对应的独立句子。',
          '4. direction=v 时，先写完整中文译文，再按 targetColumns 拆成 columns；columns 按最终竖排显示的阅读顺序返回。',
          '5. direction=h 时，columns 表示最终横排行分段，优先接近 targetLines。',
          '6. columns 每段都应是自然中文片段，尽量在标点、语气停顿或短语边界断开。',
          '7. 除 JSON 外不要输出任何内容。',
          `输入数据：${JSON.stringify(payload)}`,
        ].join('\n'),
      },
    ],
    response_format: {
      type: 'json_object',
    },
  });
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('LLM 翻译响应为空');
  }

  try {
    return {
      byId: parseColumnsPayload(content),
      rawContent: content,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LlmColumnsParseError(`LLM 列翻译响应解析失败: ${detail}`, content);
  }
}
