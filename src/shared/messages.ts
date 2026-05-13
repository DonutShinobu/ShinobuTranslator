import type { ExtensionSettings } from './config';
import { requireChromeApi } from './chrome';
import { toErrorMessage } from './utils';

export type GetSettingsMessage = {
  type: 'mt:get-settings';
};

export type SetSettingsMessage = {
  type: 'mt:set-settings';
  settings: ExtensionSettings;
};

export type DownloadImageMessage = {
  type: 'mt:download-image';
  imageUrl: string;
};

export type RuntimeMessage = GetSettingsMessage | SetSettingsMessage | DownloadImageMessage;

export type RuntimeSuccessResponse =
  | {
      ok: true;
      type: 'mt:get-settings';
      settings: ExtensionSettings;
    }
  | {
      ok: true;
      type: 'mt:set-settings';
      settings: ExtensionSettings;
    }
  | {
      ok: true;
      type: 'mt:download-image';
      base64: string;
      contentType: string;
      sourceUrl: string;
    };

export type RuntimeErrorResponse = {
  ok: false;
  type: RuntimeMessage['type'];
  error: string;
};

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === 'mt:get-settings' || type === 'mt:set-settings' || type === 'mt:download-image';
}

export function sendRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  const chromeApi = requireChromeApi();
  if (!chromeApi.runtime?.sendMessage) {
    return Promise.reject(new Error('当前环境不支持 runtime.sendMessage'));
  }
  return new Promise<RuntimeResponse>((resolve, reject) => {
    chromeApi.runtime?.sendMessage?.(message, (response: unknown) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response || typeof response !== 'object') {
        reject(new Error('扩展消息返回为空'));
        return;
      }
      resolve(response as RuntimeResponse);
    });
  }).catch((error: unknown) => {
    throw new Error(`扩展通信失败: ${toErrorMessage(error)}`);
  });
}
