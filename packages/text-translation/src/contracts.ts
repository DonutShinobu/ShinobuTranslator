export type LlmProvider =
  | 'deepseek'
  | 'gemini'
  | 'glm'
  | 'kimi'
  | 'minimax'
  | 'mimo'
  | 'openai'
  | 'custom';

export type LlmAuthMode = 'api_key' | 'openai_oauth' | 'gemini_app';
export type LlmThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type TranslationReferenceContext = {
  source: 'x_tweet';
  currentTweetText: string;
  quotedTweetText?: string;
};

export type LlmChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmChatCompletionRequestBody = {
  model: string;
  messages: LlmChatMessage[];
  response_format?: { type: 'json_object' | 'text' };
  reasoning_effort?: Exclude<LlmThinkingLevel, 'on' | 'off'> | 'none';
  reasoning_split?: boolean;
  thinking?: { type: 'disabled' | 'enabled' | 'adaptive' };
};

export type LlmChatCompletionsProxyConfig = {
  provider: LlmProvider;
  authMode: LlmAuthMode;
  baseUrl: string;
  useCustomModel?: boolean;
  thinkingLevel?: LlmThinkingLevel;
};

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export type ChatCompletionTransportRequest = {
  body: LlmChatCompletionRequestBody;
  providerBody?: LlmChatCompletionRequestBody;
  proxyConfig: LlmChatCompletionsProxyConfig;
  diagnosticRunId?: string;
  signal?: AbortSignal;
};

export type PlainTranslationTransportRequest = {
  text: string;
  from: string;
  to: string;
  signal?: AbortSignal;
};

export interface TextTranslationTransport {
  requestChatCompletion(request: ChatCompletionTransportRequest): Promise<ChatCompletionResponse>;
  translatePlain(request: PlainTranslationTransportRequest): Promise<string>;
}

export type TextTranslationConfig = {
  sourceLang: string;
  targetLang: string;
  translator: 'google_web' | 'llm';
  llmProvider: LlmProvider;
  llmAuthMode: LlmAuthMode;
  llmBaseUrl: string;
  llmModel: string;
  llmUseCustomModel?: boolean;
  llmThinkingLevel?: LlmThinkingLevel;
  translationContext?: TranslationReferenceContext;
  diagnosticRunId?: string;
};

export type TextTranslationRegion = {
  id: string;
  sourceText: string;
  direction?: 'h' | 'v';
  originalLineCount?: number;
  translatedText: string;
  translatedColumns?: string[];
};

export type TranslationDebugInfo = {
  llmBatchRawResponse?: string;
  llmBatchParseError?: string;
  llmBatchError?: string;
  llmBatchFailed?: boolean;
  llmBatchRequestedRegionCount?: number;
  llmBatchHitRegionCount?: number;
  llmFallbackUsed?: boolean;
  llmFallbackRegionCount?: number;
  llmFallbackRequestCount?: number;
  tweetContextLengthFallback?: boolean;
};

export type TextTranslationRequest<T extends TextTranslationRegion> = {
  regions: readonly T[];
  config: Readonly<TextTranslationConfig>;
  signal?: AbortSignal;
};

export type TextTranslationResult<T extends TextTranslationRegion> = {
  regions: T[];
  translationDebug: TranslationDebugInfo | null;
};

export interface TextTranslator {
  translateRegions<T extends TextTranslationRegion>(
    request: TextTranslationRequest<T>,
  ): Promise<TextTranslationResult<T>>;
}
