import type { ExtensionMessageSender } from '../../shared/extensionRuntime';
import { abortable } from '../../shared/abortable';

const requests = new Map<string, AbortController>();
const earlyCancellations = new Map<string, number>();
const timeoutMs = 120_000;

function keyFor(sender: ExtensionMessageSender, requestId: string): string {
  // A different tab/frame/document cannot cancel another caller's request.
  return JSON.stringify([sender.tab?.id, sender.frameId, sender.documentId, sender.url, requestId]);
}

export function cancelLlmRequest(sender: ExtensionMessageSender, requestId: string): void {
  const key = keyFor(sender, requestId);
  const active = requests.get(key);
  if (active) active.abort(new DOMException('翻译已取消', 'AbortError'));
  else {
    earlyCancellations.set(key, Date.now() + timeoutMs);
    if (earlyCancellations.size > 256) earlyCancellations.delete(earlyCancellations.keys().next().value!);
  }
}

export async function runCancelableLlmRequest<T>(
  sender: ExtensionMessageSender,
  requestId: string | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const key = requestId ? keyFor(sender, requestId) : undefined;
  for (const [cancelledKey, expires] of earlyCancellations) {
    if (expires <= Date.now()) earlyCancellations.delete(cancelledKey);
  }
  if (key && earlyCancellations.delete(key)) throw new DOMException('翻译已取消', 'AbortError');
  if (key && requests.has(key)) throw new Error('重复的 LLM 请求标识');
  const controller = new AbortController();
  if (key) requests.set(key, controller);
  const timer = setTimeout(() => controller.abort(new DOMException('AI 请求超时，请稍后重试', 'TimeoutError')), timeoutMs);
  try {
    return await abortable(() => run(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    if (key && requests.get(key) === controller) requests.delete(key);
  }
}
