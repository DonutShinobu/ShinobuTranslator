import {
  createTextTranslationTransport,
  TextTranslationTransportError,
  type ChatCompletionResponse,
  type TextTranslationTransport,
} from '@shinobu/text-translation';
import {
  sendRuntimeMessage,
  type RuntimeMessage,
  type RuntimeResponse,
} from './messages';
import { abortable, throwIfSignalAborted } from './abortable';

export type RuntimeMessageSender = (
  message: RuntimeMessage,
) => Promise<RuntimeResponse>;

export function createMessageTextTranslationTransport(
  sendMessage: RuntimeMessageSender,
): TextTranslationTransport {
  return createTextTranslationTransport(async (request) => {
    throwIfSignalAborted(request.signal);
    const requestId = crypto.randomUUID();
    let sent = false;
    const cancel = (): void => {
      if (sent) void sendMessage({ type: 'mt:llm-cancel', requestId }).catch(() => undefined);
    };
    request.signal?.addEventListener('abort', cancel, { once: true });
    const response = await abortable(() => {
      sent = true;
      return sendMessage({
        type: 'mt:llm-chat-completions',
        requestId,
        body: request.body,
        proxyConfig: request.proxyConfig,
        diagnosticRunId: request.diagnosticRunId,
      });
    }, request.signal).finally(() => request.signal?.removeEventListener('abort', cancel));
    if (!response.ok || response.type !== 'mt:llm-chat-completions') {
      throw new TextTranslationTransportError(
        response.ok ? 'LLM 翻译请求失败' : response.error,
        {
          code: !response.ok ? response.errorCode : undefined,
          status: !response.ok ? response.status : undefined,
          retryAfterMs: !response.ok ? response.retryAfterMs : undefined,
          retryable: !response.ok ? response.retryable : undefined,
        },
      );
    }
    return response.data as ChatCompletionResponse;
  });
}

export const extensionTextTranslationTransport =
  createMessageTextTranslationTransport(sendRuntimeMessage);
