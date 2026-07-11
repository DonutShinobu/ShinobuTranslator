import type { ExtensionSettings } from '../../shared/config';
import { getChromeApi } from '../../shared/chrome';
import { getGeminiAppAuthStatus } from '../geminiAppClient';

export const geminiAppUrl = 'https://gemini.google.com/app';
export type GeminiAppAuthStatus = Awaited<ReturnType<typeof getGeminiAppAuthStatus>>;

export function openGeminiAppAuthTab(): Promise<void> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.tabs?.create) {
    return Promise.reject(new Error('当前浏览器不支持打开 Gemini 登录页，请确认扩展已授予 tabs 权限'));
  }

  return new Promise((resolve, reject) => {
    chromeApi.tabs?.create?.({ url: geminiAppUrl, active: true }, () => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function readGeminiAppAuthStatus(
  settings: ExtensionSettings,
): Promise<GeminiAppAuthStatus> {
  return getGeminiAppAuthStatus(settings);
}

export async function loginGeminiApp(
  settings: ExtensionSettings,
): Promise<GeminiAppAuthStatus> {
  const status = await getGeminiAppAuthStatus(settings);
  if (status.authenticated) return status;
  await openGeminiAppAuthTab();
  return { authenticated: false, pending: true };
}
