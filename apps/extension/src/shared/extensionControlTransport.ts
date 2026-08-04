import type {
  ExtensionControlCommand,
  ExtensionControlProjection,
  ExtensionControlResult,
} from './extensionControl';
import {
  requireExtensionRuntime,
  type ExtensionRuntime,
} from './extensionRuntime';
import type { RuntimeResponse } from './messages';
import { toErrorMessage } from './utils';

export const extensionControlPortName = 'mt:extension-control-events';
export const extensionControlChangedEventType = 'mt:extension-control-changed';

export type ExtensionControlChangedEvent = {
  type: typeof extensionControlChangedEventType;
  projection: ExtensionControlProjection;
};

export async function sendExtensionControlCommand(
  command: ExtensionControlCommand,
  runtime: ExtensionRuntime = requireExtensionRuntime(),
): Promise<ExtensionControlResult> {
  try {
    const response = await runtime.sendMessage<RuntimeResponse>({
      type: 'mt:extension-control',
      command,
    });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展控制消息返回为空');
    }
    if (!response.ok) {
      throw Object.assign(new Error(response.error), {
        ...(response.errorCode ? { code: response.errorCode } : {}),
      });
    }
    if (response.type !== 'mt:extension-control') {
      throw new Error('扩展控制消息返回类型错误');
    }
    return response.result;
  } catch (error) {
    const wrapped = new Error(`扩展控制通信失败: ${toErrorMessage(error)}`);
    if (
      error
      && typeof error === 'object'
      && typeof (error as { code?: unknown }).code === 'string'
    ) {
      Object.assign(wrapped, { code: (error as { code: string }).code });
    }
    throw wrapped;
  }
}
