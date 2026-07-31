import type {
  LlmProvider,
  LlmThinkingLevel,
  ProviderExecutionPolicy,
} from '@shinobu/image-pipeline';
import type { RuntimeChannel } from '../capabilities/contracts';

export type PipelineHostChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type PipelineHostChatCompletionRequestBody = {
  model: string;
  messages: PipelineHostChatMessage[];
  response_format?: {
    type: 'json_object' | 'text';
  };
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoning_split?: boolean;
  thinking?: {
    type: 'disabled' | 'enabled' | 'adaptive';
  };
};

export type PipelineHostChatCompletionsProxyConfig = {
  provider: LlmProvider;
  authMode: 'api_key' | 'openai_oauth' | 'gemini_app';
  baseUrl: string;
  useCustomModel?: boolean;
  thinkingLevel?: LlmThinkingLevel;
};

export type PipelineHostChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export interface PipelineHostTranslationTransport {
  requestChatCompletion(request: {
    body: PipelineHostChatCompletionRequestBody;
    providerBody?: PipelineHostChatCompletionRequestBody;
    proxyConfig: PipelineHostChatCompletionsProxyConfig;
    apiKey?: string;
    diagnosticRunId?: string;
    signal?: AbortSignal;
  }): Promise<PipelineHostChatCompletionResponse>;
  translatePlain(request: {
    text: string;
    from: string;
    to: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

export type PipelineHostRuntimeComposition = {
  providerPolicy?: ProviderExecutionPolicy;
  translationTransport?: PipelineHostTranslationTransport;
};

export const LOCAL_PIPELINE_OFFSCREEN_PORT = 'mt:offscreen-pipeline-host';
export const LOCAL_PIPELINE_OFFSCREEN_DOCUMENT = 'offscreen.html';

export interface PipelineHostConnection {
  connect(): Promise<RuntimeChannel>;
}

export interface PipelineHostController {
  dispose(): Promise<void>;
}

export type PipelineHostStarter = (
  connection: PipelineHostConnection,
) => PipelineHostController | Promise<PipelineHostController>;

export interface PipelineHostActivation {
  readonly channel: RuntimeChannel;
  activate(): void;
}

export interface PipelineHostDocumentLifecycle {
  isAvailable(): boolean;
  accepts(channel: RuntimeChannel): boolean;
  exists(): Promise<boolean>;
  create(): Promise<PipelineHostActivation | undefined>;
  close(): Promise<boolean>;
}

export type PipelineHostLifecycle =
  & PipelineHostConnection
  & PipelineHostDocumentLifecycle;
